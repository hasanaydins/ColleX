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

const readJsonBody = (req, maxBytes = 64 * 1024) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON body"), { status: 400 })); }
    });
    req.on("error", reject);
  });

const removeBookmarkFromDisk = (dataDir, tweetId) => {
  const dataPath = path.join(dataDir, "bookmarks-data.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } catch {
    return { removed: false, count: 0 };
  }

  const bookmarks = Array.isArray(data) ? data : data.bookmarks;
  if (!Array.isArray(bookmarks)) return { removed: false, count: 0 };

  const next = bookmarks.filter((bm) => String(bm.id) !== String(tweetId));
  const removed = next.length !== bookmarks.length;
  if (!removed) return { removed: false, count: bookmarks.length };

  const output = Array.isArray(data) ? next : { ...data, bookmarks: next };
  fs.writeFileSync(dataPath, JSON.stringify(output, null, 2), "utf8");
  return { removed: true, count: next.length };
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

const UPSTREAM_CONNECT_TIMEOUT_MS = 30000;
const UPSTREAM_IDLE_TIMEOUT_MS = 60000;
const MAX_CONCURRENT_VIDEO_DL = 3;

let _activeDlCount = 0;
const _dlQueue = [];

const _acquireSlot = (cb) => {
  if (_activeDlCount < MAX_CONCURRENT_VIDEO_DL) { _activeDlCount++; cb(); return; }
  _dlQueue.push(cb);
};

const _releaseSlot = () => {
  _activeDlCount--;
  if (_dlQueue.length > 0 && _activeDlCount < MAX_CONCURRENT_VIDEO_DL) {
    _activeDlCount++;
    _dlQueue.shift()();
  }
};

const activeDownloads = new Map();
// cachePath → {
//   tmpPath, diskBytes, bytesReceived, totalBytes,
//   done, failed, writer, _diskWaiters[], _slotReleased
// }

function _notifyDisk(dl) {
  const ready = [];
  const pending = [];
  for (const w of dl._diskWaiters) {
    if (dl.diskBytes >= w.needed || dl.done || dl.failed) ready.push(w);
    else pending.push(w);
  }
  dl._diskWaiters = pending;
  for (const w of ready) w.resolve();
}

function _waitForDisk(dl, needed) {
  return new Promise((resolve) => {
    if (dl.diskBytes >= needed || dl.done || dl.failed) { resolve(); return; }
    dl._diskWaiters.push({ resolve, needed });
  });
}

const _startDownload = (videoUrl, cacheDir, cachePath, tmpPath, teeRes) => {
  const dl = {
    tmpPath,
    diskBytes: 0,
    bytesReceived: 0,
    totalBytes: 0,
    done: false,
    failed: false,
    writer: null,
    _diskWaiters: [],
    _slotReleased: false,
  };
  activeDownloads.set(cachePath, dl);

  let diskFailed = false;
  let teeClosed = false;
  if (teeRes) teeRes.on("close", () => { teeClosed = true; });

  try {
    dl.writer = fs.createWriteStream(tmpPath, { flags: "w" });
    inflightCacheWrites.add(cachePath);
    dl.writer.on("error", () => { diskFailed = true; });
  } catch { dl.writer = null; }

  const abort = () => {
    if (dl.writer) { dl.writer.destroy(); dl.writer = null; }
    inflightCacheWrites.delete(cachePath);
    try { fs.unlinkSync(tmpPath); } catch {}
    dl.failed = true;
    activeDownloads.delete(cachePath);
    _notifyDisk(dl);
    if (!dl._slotReleased) { dl._slotReleased = true; _releaseSlot(); }
  };

  const doFetch = (url) => {
    const upstreamReq = https.get(url, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS }, (upstream) => {
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        upstream.resume();
        return doFetch(upstream.headers.location);
      }
      if (upstream.statusCode !== 200) {
        if (teeRes && !teeRes.headersSent && !teeClosed) {
          try { teeRes.writeHead(upstream.statusCode || 502); } catch {}
          try { teeRes.end(); } catch {}
        }
        abort();
        return;
      }

      dl.totalBytes = parseInt(upstream.headers["content-length"] || "0", 10) || 0;

      if (teeRes && !teeRes.headersSent && !teeClosed) {
        teeRes.writeHead(206, {
          "Content-Range": `bytes 0-${dl.totalBytes - 1}/${dl.totalBytes}`,
          "Accept-Ranges": "bytes",
          "Content-Length": dl.totalBytes,
          "Content-Type": "video/mp4",
          "Cache-Control": "public, max-age=86400",
        });
      }

      upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        upstream.destroy(new Error("upstream idle timeout"));
      });

      upstream.on("data", (chunk) => {
        dl.bytesReceived += chunk.length;

        if (dl.writer && !diskFailed) {
          const canDrain = dl.writer.write(chunk, () => {
            dl.diskBytes += chunk.length;
            _notifyDisk(dl);
          });
          if (!canDrain) {
            upstream.pause();
            dl.writer.once("drain", () => upstream.resume());
          }
        }

        if (teeRes && !teeClosed && !teeRes.writableEnded && !teeRes.destroyed) {
          teeRes.write(chunk);
        }
      });

      upstream.on("end", () => {
        if (teeRes && !teeClosed && !teeRes.writableEnded && !teeRes.destroyed) {
          try { teeRes.end(); } catch {}
        }

        const complete = dl.totalBytes > 0 && dl.bytesReceived === dl.totalBytes;
        if (dl.writer && !diskFailed && complete) {
          dl.writer.end(() => {
            dl.diskBytes = dl.bytesReceived;
            _notifyDisk(dl);
            fs.rename(tmpPath, cachePath, (err) => {
              inflightCacheWrites.delete(cachePath);
              if (!err) {
                scheduleVideoCacheCleanup(cacheDir);
                dl.done = true;
                _notifyDisk(dl);
                if (!dl._slotReleased) { dl._slotReleased = true; _releaseSlot(); }
                setTimeout(() => activeDownloads.delete(cachePath), 10000);
              } else {
                try { fs.unlinkSync(tmpPath); } catch {}
                abort();
              }
            });
          });
        } else {
          abort();
        }
      });

      upstream.on("error", () => {
        if (teeRes && !teeClosed && !teeRes.writableEnded && !teeRes.destroyed) {
          try { teeRes.end(); } catch {}
        }
        abort();
      });
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("upstream connect timeout"));
    });
    upstreamReq.on("error", () => {
      if (teeRes && !teeClosed) {
        if (!teeRes.headersSent) { try { teeRes.writeHead(504); } catch {} }
        try { teeRes.end(); } catch {}
      }
      abort();
    });
  };

  doFetch(videoUrl);
  return dl;
};

const _serveFromTmp = async (tmpPath, dl, req, res) => {
  let clientClosed = false;
  res.on("close", () => { clientClosed = true; });

  await _waitForDisk(dl, 1);
  if (dl.failed && dl.diskBytes === 0) {
    if (!clientClosed) { try { res.writeHead(502); } catch {} try { res.end(); } catch {} }
    return;
  }

  const totalSize = dl.totalBytes > 0 ? dl.totalBytes : dl.diskBytes;
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      if (!clientClosed) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
      }
      return;
    }

    const start = m[1] ? parseInt(m[1], 10) : 0;
    const endReq = m[2] ? parseInt(m[2], 10) : totalSize - 1;

    if (start >= totalSize) {
      if (!clientClosed) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
      }
      return;
    }

    await _waitForDisk(dl, start + 1);
    if (dl.failed && start >= dl.diskBytes) {
      if (!clientClosed) { try { res.writeHead(502); } catch {} try { res.end(); } catch {} }
      return;
    }

    const actualEnd = Math.min(endReq, dl.diskBytes - 1);
    if (start > actualEnd) {
      if (!clientClosed) {
        res.writeHead(416, { "Content-Range": `bytes */${totalSize}` });
        res.end();
      }
      return;
    }

    const contentLength = actualEnd - start + 1;
    if (!clientClosed) {
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${actualEnd}/${totalSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": contentLength,
        "Content-Type": "video/mp4",
        "Cache-Control": dl.done ? "public, max-age=31536000, immutable" : "public, max-age=86400",
      });
      fs.createReadStream(tmpPath, { start, end: actualEnd }).pipe(res);
    }
  } else {
    if (!clientClosed) {
      const headers = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      };
      if (dl.totalBytes > 0) headers["Content-Length"] = dl.totalBytes;
      res.writeHead(200, headers);
    }

    let offset = 0;
    const CHUNK = 256 * 1024;

    while (!clientClosed && !res.writableEnded && !res.destroyed) {
      if (offset >= dl.diskBytes) {
        if (dl.done || dl.failed) break;
        await _waitForDisk(dl, offset + 1);
        continue;
      }

      const readEnd = Math.min(offset + CHUNK - 1, dl.diskBytes - 1);

      try {
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(tmpPath, { start: offset, end: readEnd });
          stream.on("data", (chunk) => {
            offset += chunk.length;
            if (!clientClosed && !res.destroyed) res.write(chunk);
          });
          stream.on("end", resolve);
          stream.on("error", reject);
        });
      } catch { break; }

      if (offset >= dl.diskBytes && !dl.done && !dl.failed) {
        await _waitForDisk(dl, offset + 1);
      }
    }

    if (!clientClosed && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }
  }
};

// Direct upstream passthrough for non-zero Range requests. The cache pipeline
// fills sequentially via tmp file writes; on a 30-min video, asking
// _serveFromTmp to wait for diskBytes to reach byte N (often hundreds of MB
// in) is minutes of dead air — long enough for the browser to give up. The
// passthrough lets the seek/preload-end request hit upstream directly while
// the bytes=0- background download continues filling the cache.
const passthroughRange = (videoUrl, range, res, redirects = 0) => {
  let clientClosed = false;
  res.on("close", () => { clientClosed = true; });

  const upstreamReq = https.get(
    videoUrl,
    { headers: { Range: range }, timeout: UPSTREAM_CONNECT_TIMEOUT_MS },
    (upstream) => {
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        upstream.resume();
        if (redirects >= 3) {
          if (!clientClosed) { try { res.writeHead(502); res.end(); } catch {} }
          return;
        }
        return passthroughRange(upstream.headers.location, range, res, redirects + 1);
      }
      if (upstream.statusCode !== 206 && upstream.statusCode !== 200) {
        if (!clientClosed) { try { res.writeHead(upstream.statusCode || 502); res.end(); } catch {} }
        upstream.resume();
        return;
      }

      upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        upstream.destroy(new Error("upstream idle timeout"));
      });

      if (clientClosed) { upstream.resume(); return; }

      const respHeaders = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      };
      if (upstream.headers["content-length"]) respHeaders["Content-Length"] = upstream.headers["content-length"];
      if (upstream.headers["content-range"]) respHeaders["Content-Range"] = upstream.headers["content-range"];
      try { res.writeHead(upstream.statusCode, respHeaders); } catch {}
      upstream.pipe(res);
      upstream.on("error", () => { try { res.end(); } catch {} });
    }
  );

  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream connect timeout")));
  upstreamReq.on("error", () => {
    if (!clientClosed) { try { res.writeHead(504); res.end(); } catch {} }
  });
};

const streamVideoUpstream = (videoUrl, cacheDir, req, res, isPriority = false) => {
  const cachePath = videoCachePathFor(cacheDir, videoUrl);
  const tmpPath = cachePath + ".tmp";

  // Anything that isn't a from-byte-0 request (suffix ranges like `bytes=-500`,
  // mid-file ranges like `bytes=N-…`) goes through passthrough. Browsers send
  // these for seeking and trailing-metadata probes; making them wait for the
  // sequential disk-cache download to catch up is what stalls long videos.
  const range = req.headers.range;
  const startsAtZero = !range || /^bytes=0-/.test(range.trim());
  if (!startsAtZero) {
    passthroughRange(videoUrl, range, res);
    return;
  }

  const existing = activeDownloads.get(cachePath);
  if (existing) {
    _serveFromTmp(tmpPath, existing, req, res);
    return;
  }

  if (fs.existsSync(tmpPath) && !inflightCacheWrites.has(cachePath)) {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  const launch = () => {
    const existingAfter = activeDownloads.get(cachePath);
    if (existingAfter) {
      if (!isPriority) _releaseSlot();
      _serveFromTmp(tmpPath, existingAfter, req, res);
      return;
    }

    if (res.writableEnded || res.destroyed) {
      if (!isPriority) _releaseSlot();
      return;
    }

    _startDownload(videoUrl, cacheDir, cachePath, tmpPath, res);
  };

  if (isPriority) {
    launch();
  } else {
    _acquireSlot(launch);
  }
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

  // Purge orphan .tmp files left behind by downloads that were interrupted
  // by a crash, force-quit, or a network drop between the upstream 'end' and
  // the rename. Leaving them there wastes disk and confuses the LRU sweeper.
  try {
    for (const f of fs.readdirSync(VIDEO_CACHE_DIR)) {
      if (f.endsWith(".tmp")) {
        try { fs.unlinkSync(path.join(VIDEO_CACHE_DIR, f)); } catch {}
      }
    }
  } catch {}

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);

    // Proxy Twitter video requests (with persistent disk cache)
    if (parsed.pathname === "/proxy-video") {
      const videoUrl = parsed.searchParams.get("url");
      const isPriority = parsed.searchParams.get("priority") === "1";
      if (!videoUrl || !videoUrl.startsWith("https://video.twimg.com/")) {
        res.writeHead(400);
        res.end("Invalid video URL");
        return;
      }
      const cachePath = videoCachePathFor(VIDEO_CACHE_DIR, videoUrl);
      fs.access(cachePath, fs.constants.R_OK, (err) => {
        if (!err) serveVideoFromDisk(cachePath, req, res);
        else streamVideoUpstream(videoUrl, VIDEO_CACHE_DIR, req, res, isPriority);
      });
      return;
    }

    if (parsed.pathname === "/video-cache-clear" && req.method === "POST") {
      const videoUrl = parsed.searchParams.get("url");
      if (!videoUrl || !videoUrl.startsWith("https://video.twimg.com/")) {
        res.writeHead(400);
        res.end("Invalid video URL");
        return;
      }
      const cachePath = videoCachePathFor(VIDEO_CACHE_DIR, videoUrl);
      const tmpPath = cachePath + ".tmp";

      const dl = activeDownloads.get(cachePath);
      if (dl) {
        if (dl.writer) { dl.writer.destroy(); dl.writer = null; }
        inflightCacheWrites.delete(cachePath);
        dl.failed = true;
        dl._diskWaiters.forEach(w => w.resolve());
        dl._diskWaiters = [];
        activeDownloads.delete(cachePath);
        if (!dl._slotReleased) { dl._slotReleased = true; _releaseSlot(); }
      }

      try { fs.unlinkSync(cachePath); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

      const IMAGE_TIMEOUT_MS = 15000;
      const doFetch = (url, redirects) => {
        const req2 = https.get(url, { timeout: IMAGE_TIMEOUT_MS }, (upstream) => {
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
          upstream.setTimeout(IMAGE_TIMEOUT_MS, () => {
            upstream.destroy(new Error("upstream idle timeout"));
          });
          upstream.pipe(res);
          upstream.on("error", () => { if (!clientClosed) res.end(); });
        });
        req2.on("timeout", () => {
          req2.destroy(new Error("upstream connect timeout"));
        });
        req2.on("error", () => {
          if (!clientClosed) {
            try { res.writeHead(504); res.end("Upstream timeout"); }
            catch { try { res.end(); } catch {} }
          }
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

    if (parsed.pathname === "/bookmark/remove") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(err.status || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "invalid request" }));
        return;
      }

      const tweetId = body?.id || body?.tweetId;
      if (!tweetId || !/^\d+$/.test(String(tweetId))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid id" }));
        return;
      }

      try {
        const { removeBookmark } = require("./src/twitter");
        await removeBookmark(DATA_DIR, tweetId);
        const local = removeBookmarkFromDisk(DATA_DIR, tweetId);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, removed: local.removed, count: local.count }));
      } catch (err) {
        res.writeHead(err.status === 401 || err.status === 403 ? 401 : 502, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: err.message || "bookmark remove failed" }));
      }
      return;
    }

    // Bookmark sync endpoint (SSE) — max once per hour
    if (parsed.pathname === "/sync") {
      const { loadCredentials, saveCredentials } = require("./src/credentials");
      const creds = loadCredentials(DATA_DIR);
      const mode = parsed.searchParams.get("mode") === "full" ? "full" : "incremental";

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
      syncBookmarks(DATA_DIR, onProgress, { mode })
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
