// --- Media operations: HTML building, download, copy, ZIP, OG cards ---

import { escapeHtml, twitterImageUrl, extractUrl } from './helpers.js';

// Lazy-load OG image for a text-only card
export const loadOgCard = async (bm, ogWrap) => {
  const url = extractUrl(bm.text) || bm.url;
  try {
    const res = await fetch(`/og?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data || !data.image) return;
    ogWrap.innerHTML = `
      <img class="og-image" src="${escapeHtml(data.image)}" alt="" loading="lazy">
      <div class="og-meta">
        ${data.title ? `<span class="og-title">${escapeHtml(data.title)}</span>` : ""}
        <span class="og-domain">${escapeHtml(data.domain || "")}</span>
      </div>
    `;
    ogWrap.classList.add("loaded");
  } catch {
    // silently fail — card still shows text
  }
};

// Returns pixel height of the media area for masonry tracking
export const mediaHeight = (images, colWidth) => {
  const n = Math.min(images.length, 4);
  if (n === 0) return 0;
  if (n === 1) return colWidth / (images[0].width / images[0].height);
  if (n === 2) return colWidth * (9 / 16);
  if (n === 3) return colWidth * (3 / 4);
  return colWidth; // 4 images → square grid
};

export const buildMediaHtml = (images) => {
  const n = Math.min(images.length, 4);
  if (n === 0) return "";

  // Single media
  if (n === 1) {
    const img = images[0];
    const aspect = `${img.width}/${img.height}`;
    if ((img.type === "animated_gif" || img.type === "video") && img.videoUrl) {
      const isGif = img.type === "animated_gif";
      return `<div class="card-media-wrap"><video class="card-video" data-src="/proxy-video?url=${encodeURIComponent(img.videoUrl)}" poster="${twitterImageUrl(img.url, "medium")}" style="aspect-ratio:${aspect}" ${isGif ? "loop" : ""} muted playsinline></video><div class="video-loader" aria-hidden="true"></div></div>`;
    }
    return `<div class="card-media-wrap"><img src="${twitterImageUrl(img.url, "medium")}" alt="" loading="lazy" decoding="async"></div>`;
  }

  // Multi-image grid
  const extra = images.length - 4;
  const items = images.slice(0, n).map((img, i) => {
    const isLast = i === n - 1 && extra > 0;
    return `<div class="media-grid-cell">
      <img class="media-grid-img" src="${twitterImageUrl(img.url, "medium")}" alt="" loading="lazy" decoding="async">
      ${isLast ? `<div class="media-grid-more">+${extra + 1}</div>` : ""}
    </div>`;
  }).join("");

  return `<div class="card-media-wrap"><div class="media-grid media-grid--${n}">${items}</div></div>`;
};

// --- Image action helpers ---

export const triggerAnchorDownload = (href, filename) => {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const downloadImage = async (url, filename) => {
  if (url.startsWith("/")) {
    triggerAnchorDownload(url, filename);
    await new Promise(r => setTimeout(r, 800));
    return;
  }
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(blobUrl, filename);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch (err) {
    console.error("Download failed:", err);
  }
};

export const copyImageToClipboard = async (url, btn) => {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    const pngBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);

    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      btn.style.color = "#4ade80";
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ""; }, 1500);
    }
  } catch (err) {
    console.error("Copy failed:", err);
  }
};

export const bookmarkFilename = (bm, ext) => {
  const safe = (s) => (s || "").replace(/[^\w\-]/g, "_").replace(/_+/g, "_").slice(0, 40);
  const date = new Date(bm.postedAt);
  const dateStr = isNaN(date)
    ? "unknown"
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${safe(bm.authorHandle)}_${safe(bm.authorName)}_${dateStr}.${ext}`;
};

export const mediaDownloadUrl = (img) => {
  const isVideo = img.type === "video" || img.type === "animated_gif";
  if (isVideo && img.videoUrl) return { url: `/proxy-video?url=${encodeURIComponent(img.videoUrl)}`, ext: "mp4" };
  // Route image fetches through same-origin proxy — CSP connect-src blocks direct twimg.com requests.
  return { url: `/proxy-image?url=${encodeURIComponent(twitterImageUrl(img.url, "4096x4096"))}`, ext: "jpg" };
};

const FETCH_BLOB_TIMEOUT_MS = 30000;

export const fetchBlob = async (url) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_BLOB_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Fetch failed ${resp.status}`);
    return await resp.blob();
  } finally {
    clearTimeout(timeoutId);
  }
};

const FETCH_VIDEO_TIMEOUT_MS = 120000;

export const fetchBlobWithProgress = async (url, onProgress, { signal: externalSignal } = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_VIDEO_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Fetch failed ${resp.status}`);

    const contentLength = parseInt(resp.headers.get("Content-Length") || "0", 10);

    if (!resp.body || contentLength === 0) {
      if (onProgress) onProgress(-1);
      const blob = await resp.blob();
      if (onProgress) onProgress(100);
      return blob;
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(Math.round((received / contentLength) * 100));
    }

    if (onProgress) onProgress(100);
    return new Blob(chunks, { type: resp.headers.get("Content-Type") || "video/mp4" });
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
};

// Build a ZIP from a list of bookmarks. Fires onProgress events.
export const bookmarksToZip = async (bookmarks, onProgress) => {
  const zip = new JSZip();
  let totalFiles = 0;
  const total = bookmarks.length;

  for (let i = 0; i < total; i++) {
    const bm = bookmarks[i];
    if (onProgress) onProgress({ phase: "fetching", bookmark: bm, index: i, total });

    for (let j = 0; j < bm.images.length; j++) {
      const img = bm.images[j];
      const { url, ext } = mediaDownloadUrl(img);
      const suffix = bm.images.length > 1 ? `_${j + 1}of${bm.images.length}` : "";
      const base = bookmarkFilename(bm, ext);
      const filename = base.replace(`.${ext}`, `${suffix}.${ext}`);
      try {
        const blob = await fetchBlob(url);
        zip.file(filename, blob);
        totalFiles++;
      } catch (e) {
        console.warn(`Skipped ${filename}:`, e.message);
      }
    }
  }

  if (totalFiles === 0) throw new Error("No files could be downloaded");

  if (onProgress) onProgress({ phase: "zipping", totalFiles });
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return { zipBlob, totalFiles };
};
