const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const MAX_VIDEO_CACHE_BYTES = 500 * 1024 * 1024; // 500 MB LRU cap
const inflightCacheWrites = new Set();

const videoCachePathFor = (cacheDir, videoUrl) => {
  const hash = crypto.createHash("sha256").update(videoUrl).digest("hex");
  return path.join(cacheDir, hash + ".mp4");
};

// LRU eviction — debounced, runs after a successful cache write
let cleanupTimer = null;
const scheduleVideoCacheCleanup = (cacheDir) => {
  if (cleanupTimer) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    fs.readdir(cacheDir, (err, files) => {
      if (err) return;
      const entries = [];
      for (const f of files) {
        if (!f.endsWith(".mp4")) continue;
        try {
          const p = path.join(cacheDir, f);
          const s = fs.statSync(p);
          entries.push({ path: p, size: s.size, atime: s.atimeMs });
        } catch {}
      }
      let total = entries.reduce((a, e) => a + e.size, 0);
      if (total <= MAX_VIDEO_CACHE_BYTES) return;
      entries.sort((a, b) => a.atime - b.atime);
      for (const e of entries) {
        if (total <= MAX_VIDEO_CACHE_BYTES) break;
        try { fs.unlinkSync(e.path); total -= e.size; } catch {}
      }
    });
  }, 5000);
};

// Serve a fully-cached video file from disk with Range support
const serveVideoFromDisk = (cachePath, req, res) => {
  fs.stat(cachePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const total = stat.size;
    // Bump atime for LRU tracking
    fs.utimes(cachePath, new Date(), stat.mtime, () => {});

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      fs.createReadStream(cachePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      fs.createReadStream(cachePath).pipe(res);
    }
  });
};

// Cache-miss: stream from upstream to client AND tee to disk
const streamVideoUpstream = (videoUrl, cacheDir, req, res) => {
  const cachePath = videoCachePathFor(cacheDir, videoUrl);
  const tmpPath = cachePath + ".tmp";

  // Only start a disk writer if no other request is already caching this URL
  let diskStream = null;
  let diskFailed = false;
  if (!inflightCacheWrites.has(cachePath) && !fs.existsSync(cachePath)) {
    try {
      diskStream = fs.createWriteStream(tmpPath, { flags: "w" });
      inflightCacheWrites.add(cachePath);
      diskStream.on("error", () => { diskFailed = true; });
    } catch {
      diskStream = null;
    }
  }

  const abortDiskCache = () => {
    if (!diskStream) return;
    diskStream.destroy();
    inflightCacheWrites.delete(cachePath);
    try { fs.unlinkSync(tmpPath); } catch {}
    diskStream = null;
  };

  let clientClosed = false;
  res.on("close", () => { clientClosed = true; });

  const doFetch = (url) => {
    https.get(url, (upstream) => {
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        upstream.resume();
        return doFetch(upstream.headers.location);
      }
      if (upstream.statusCode !== 200) {
        abortDiskCache();
        if (!clientClosed) { res.writeHead(upstream.statusCode || 502); res.end(); }
        return;
      }

      if (!clientClosed) {
        res.writeHead(upstream.statusCode, {
          "Content-Type": upstream.headers["content-type"] || "video/mp4",
          "Content-Length": upstream.headers["content-length"],
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        });
      }

      upstream.on("data", (chunk) => {
        if (diskStream && !diskFailed) diskStream.write(chunk);
        if (!clientClosed) res.write(chunk);
      });

      upstream.on("end", () => {
        if (diskStream && !diskFailed) {
          diskStream.end(() => {
            fs.rename(tmpPath, cachePath, (err) => {
              inflightCacheWrites.delete(cachePath);
              if (!err) scheduleVideoCacheCleanup(cacheDir);
              else { try { fs.unlinkSync(tmpPath); } catch {} }
            });
          });
        } else {
          abortDiskCache();
        }
        if (!clientClosed) res.end();
      });

      upstream.on("error", () => {
        abortDiskCache();
        if (!clientClosed) res.end();
      });
    }).on("error", () => {
      abortDiskCache();
      if (!clientClosed) { res.writeHead(502); res.end("Upstream error"); }
    });
  };

  doFetch(videoUrl);
};

// In-memory OG cache
const ogCache = new Map();

const fetchOg = (rawUrl) =>
  new Promise((resolve) => {
    let targetUrl;
    try { targetUrl = new URL(rawUrl); } catch { return resolve(null); }
    if (!["http:", "https:"].includes(targetUrl.protocol)) return resolve(null);

    const mod = targetUrl.protocol === "https:" ? https : http;
    const req = mod.get(
      rawUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)",
          Accept: "text/html",
        },
        timeout: 5000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirected = new URL(res.headers.location, rawUrl).href;
          res.resume();
          return fetchOg(redirected).then(resolve);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }

        const ct = res.headers["content-type"] || "";
        if (!ct.includes("text/html")) { res.resume(); return resolve(null); }

        let html = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          html += chunk;
          if (html.includes("</head>") || html.length > 80000) res.destroy();
        });
        res.on("close", () => {
          const meta = (prop) => {
            const m =
              html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ||
              html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, "i")) ||
              html.match(new RegExp(`<meta[^>]+name=["']twitter:${prop}["'][^>]+content=["']([^"']+)["']`, "i"));
            return m ? m[1] : null;
          };
          const image = meta("image");
          const title = meta("title") || meta("site_name");
          resolve(image ? { image, title, domain: targetUrl.hostname.replace(/^www\./, "") } : null);
        });
        res.on("error", () => resolve(null));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });

function createServer(port, dataDir) {
  const DATA_DIR = dataDir || __dirname;
  const VIDEO_CACHE_DIR = path.join(DATA_DIR, "video-cache");
  try { fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true }); } catch {}

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);

    // Proxy Twitter video requests (with persistent disk cache)
    if (parsed.pathname === "/proxy-video") {
      const videoUrl = parsed.searchParams.get("url");
      if (!videoUrl || !videoUrl.startsWith("https://video.twimg.com/")) {
        res.writeHead(400);
        res.end("Invalid video URL");
        return;
      }
      const cachePath = videoCachePathFor(VIDEO_CACHE_DIR, videoUrl);
      fs.access(cachePath, fs.constants.R_OK, (err) => {
        if (!err) serveVideoFromDisk(cachePath, req, res);
        else streamVideoUpstream(videoUrl, VIDEO_CACHE_DIR, req, res);
      });
      return;
    }

    // Proxy Twitter image requests — CSP blocks direct fetch to pbs.twimg.com,
    // so downloads/copy/ZIP go through this same-origin endpoint.
    if (parsed.pathname === "/proxy-image") {
      const imageUrl = parsed.searchParams.get("url");
      if (!imageUrl || !/^https:\/\/([a-z0-9-]+\.)?twimg\.com\//i.test(imageUrl)) {
        res.writeHead(400);
        res.end("Invalid image URL");
        return;
      }
      let clientClosed = false;
      res.on("close", () => { clientClosed = true; });

      const doFetch = (url, redirects) => {
        https.get(url, (upstream) => {
          if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
            upstream.resume();
            if (redirects >= 3) { if (!clientClosed) { res.writeHead(502); res.end(); } return; }
            return doFetch(new URL(upstream.headers.location, url).href, redirects + 1);
          }
          if (upstream.statusCode !== 200) {
            upstream.resume();
            if (!clientClosed) { res.writeHead(upstream.statusCode || 502); res.end(); }
            return;
          }
          if (!clientClosed) {
            res.writeHead(200, {
              "Content-Type": upstream.headers["content-type"] || "image/jpeg",
              "Content-Length": upstream.headers["content-length"],
              "Cache-Control": "public, max-age=86400",
            });
          }
          upstream.pipe(res);
          upstream.on("error", () => { if (!clientClosed) res.end(); });
        }).on("error", () => {
          if (!clientClosed) { res.writeHead(502); res.end("Upstream error"); }
        });
      };
      doFetch(imageUrl, 0);
      return;
    }

    // OG image fetch endpoint
    if (parsed.pathname === "/og") {
      const url = parsed.searchParams.get("url");
      if (!url) { res.writeHead(400); res.end("Missing url"); return; }

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=86400");

      if (ogCache.has(url)) {
        res.writeHead(200);
        res.end(JSON.stringify(ogCache.get(url)));
        return;
      }

      const result = await fetchOg(url);
      ogCache.set(url, result);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // User info endpoint
    if (parsed.pathname === "/user-info") {
      const { loadCredentials } = require("./src/credentials");
      const creds = loadCredentials(DATA_DIR);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!creds) { res.end(JSON.stringify(null)); return; }
      res.end(JSON.stringify({
        handle: creds.userHandle || null,
        name: creds.userName || null,
        avatar: creds.userAvatar || null,
        lastSyncAt: creds.lastSyncAt || null,
      }));
      return;
    }

    // Fetch full conversation thread for a single tweet (on-demand from lightbox)
    if (parsed.pathname === "/thread") {
      const tweetId = parsed.searchParams.get("id");
      if (!tweetId || !/^\d+$/.test(tweetId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid id" }));
        return;
      }
      const { loadCredentials } = require("./src/credentials");
      const creds = loadCredentials(DATA_DIR);
      if (!creds) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not authenticated" }));
        return;
      }
      try {
        const { fetchThread } = require("./src/twitter");
        const tweets = await fetchThread(creds, tweetId);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=300",
        });
        res.end(JSON.stringify({ tweets }));
      } catch (err) {
        res.writeHead(err.status === 401 || err.status === 403 ? 401 : 502, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: err.message || "thread fetch failed" }));
      }
      return;
    }

    // Bookmark sync endpoint (SSE) — max once per hour
    if (parsed.pathname === "/sync") {
      const { loadCredentials, saveCredentials } = require("./src/credentials");
      const creds = loadCredentials(DATA_DIR);

      const sseHeaders = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      };

      // Enforce hourly sync limit
      if (creds?.lastSyncAt) {
        const minutesSince = (Date.now() - new Date(creds.lastSyncAt)) / 60000;
        if (minutesSince < 60) {
          const minutesLeft = Math.ceil(60 - minutesSince);
          res.writeHead(200, sseHeaders);
          res.write(`data: ${JSON.stringify({ type: "limit", minutesLeft })}\n\n`);
          res.end();
          return;
        }
      }

      res.writeHead(200, sseHeaders);
      const pingInterval = setInterval(() => res.write(":ping\n\n"), 15000);
      const onProgress = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

      const { syncBookmarks } = require("./src/twitter");
      syncBookmarks(DATA_DIR, onProgress)
        .then(() => {
          // Save lastSyncAt after successful sync
          const updated = loadCredentials(DATA_DIR);
          if (updated) saveCredentials(DATA_DIR, { ...updated, lastSyncAt: new Date().toISOString() });
        })
        .catch((err) => onProgress({ type: "error", message: err.message }))
        .finally(() => { clearInterval(pingInterval); res.end(); });

      req.on("close", () => clearInterval(pingInterval));
      return;
    }

    // Static file serving
    const reqPath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;

    // bookmarks-data.json lives in DATA_DIR (writable userData); everything else from __dirname
    let filePath;
    if (reqPath === "/bookmarks-data.json") {
      filePath = path.join(DATA_DIR, "bookmarks-data.json");
    } else {
      filePath = path.join(__dirname, reqPath);
    }

    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err && reqPath === "/bookmarks-data.json") {
        // Return empty dataset on first launch
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bookmarks: [], folders: [] }));
        return;
      }
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  });

  server.listen(port, "127.0.0.1", () =>
    console.log(`Server running at http://localhost:${port}`)
  );

  return server;
}

module.exports = { createServer };

// Standalone mode: node server.js
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const DATA_DIR = process.env.DATA_DIR || __dirname;
  createServer(PORT, DATA_DIR);
}
