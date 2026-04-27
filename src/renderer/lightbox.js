// --- Lightbox: open, close, carousel navigation ---

import { dom } from './state.js';
import { twitterImageUrl, escapeHtml, hostnameOf, primaryLinkFor, DL_ICON, COPY_ICON, SHARE_ICON } from './helpers.js';
import { downloadImage, copyImageToClipboard, mediaDownloadUrl, bookmarkFilename } from './media.js';
import { startDownload } from './downloads.js';
import { buildShareButton, buildRemoveBookmarkButton } from './card.js';
import { pauseAllGridVideos, resumeVisibleGridVideos } from './video-queue.js';

export const lbState = {
  lightboxOpen: false,
  lightboxItem: null,
  lightboxAnimating: false,
  carouselIdx: 0,
  isPanelHidden: localStorage.getItem("lbPanelHidden") === "true",
};

const LINK_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

// Shared in-flight/result cache for TweetDetail fetches. Used by both the
// auto-expand (for truncated longform tweets) and the "Show thread" button so
// opening the lightbox and then clicking "Show thread" only hits /thread once.
const threadCache = new Map();
const fetchThreadOnce = (tweetId) => {
  if (threadCache.has(tweetId)) return threadCache.get(tweetId);
  const promise = fetch(`/thread?id=${encodeURIComponent(tweetId)}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .catch((err) => {
      threadCache.delete(tweetId); // let failures retry next time
      throw err;
    });
  threadCache.set(tweetId, promise);
  return promise;
};

// Longform tweets carry a t.co "show more" self-URL at the end of full_text when
// X doesn't return note_tweet body. That tail is the classic truncation marker.
const LONGFORM_TAIL_REGEX = /https?:\/\/t\.co\/\S+\s*$/;
const looksTruncated = (bm) => {
  if (bm.textIsTruncated === true) return true; // explicit flag from new sync
  if (bm.textIsTruncated === false) return false;
  return LONGFORM_TAIL_REGEX.test(bm.text || ""); // old-data heuristic
};

// URL chips: unique expanded URLs linked from the tweet, capped at 3
const buildUrlsHtml = (urls) => {
  if (!Array.isArray(urls) || urls.length === 0) return "";
  const seen = new Set();
  const unique = [];
  for (const u of urls) {
    if (!u?.expanded || seen.has(u.expanded)) continue;
    seen.add(u.expanded);
    unique.push(u);
    if (unique.length >= 3) break;
  }
  if (!unique.length) return "";
  return `<div class="lb-urls">${unique.map((u) => `
    <a href="${escapeHtml(u.expanded)}" target="_blank" class="lb-url-chip" title="${escapeHtml(u.expanded)}">
      ${LINK_ICON}<span>${escapeHtml(u.display || hostnameOf(u.expanded) || u.expanded)}</span>
    </a>`).join("")}</div>`;
};

// Link preview card (from X's `card.legacy` binding_values)
const buildCardPreviewHtml = (card) => {
  if (!card) return "";
  const href = card.url || "#";
  const domain = card.vanityUrl || hostnameOf(card.url);
  const imgHtml = card.image?.url
    ? `<div class="lb-card-img"><img src="${escapeHtml(card.image.url)}" alt="" loading="lazy"></div>`
    : "";
  return `
    <a href="${escapeHtml(href)}" target="_blank" class="lb-card-preview">
      ${imgHtml}
      <div class="lb-card-body">
        ${domain ? `<span class="lb-card-domain">${escapeHtml(domain)}</span>` : ""}
        ${card.title ? `<span class="lb-card-title">${escapeHtml(card.title)}</span>` : ""}
        ${card.description ? `<span class="lb-card-desc">${escapeHtml(card.description)}</span>` : ""}
      </div>
    </a>
  `;
};

// Compact embedded view of a quoted tweet
const buildQuotedHtml = (q) => {
  if (!q) return "";
  const text = (q.text || "").replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const thumb = q.images?.[0];
  const thumbHtml = thumb
    ? `<img class="lb-quoted-thumb" src="${escapeHtml(twitterImageUrl(thumb.url, "small"))}" alt="" loading="lazy">`
    : "";
  return `
    <a href="${escapeHtml(q.url)}" target="_blank" class="lb-quoted">
      <div class="lb-quoted-head">
        <img class="lb-quoted-avatar" src="${escapeHtml(q.authorAvatar)}" alt="">
        <span class="lb-quoted-name">${escapeHtml(q.authorName)}</span>
        <span class="lb-quoted-handle">@${escapeHtml(q.authorHandle)}</span>
      </div>
      ${text ? `<p class="lb-quoted-text">${escapeHtml(text)}</p>` : ""}
      ${thumbHtml}
    </a>
  `;
};

const renderThreadTweet = (t, isFocal) => {
  const text = (t.text || "").replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const img = t.images?.[0];
  const imgHtml = img
    ? `<img class="lb-thread-thumb" src="${escapeHtml(twitterImageUrl(img.url, "small"))}" alt="" loading="lazy">`
    : "";
  return `
    <a href="${escapeHtml(t.url)}" target="_blank" class="lb-thread-item${isFocal ? " lb-thread-item--focal" : ""}">
      <img class="lb-thread-avatar" src="${escapeHtml(t.authorAvatar)}" alt="">
      <div class="lb-thread-body">
        <div class="lb-thread-head">
          <span class="lb-thread-name">${escapeHtml(t.authorName)}</span>
          <span class="lb-thread-handle">@${escapeHtml(t.authorHandle)}</span>
        </div>
        ${text ? `<p class="lb-thread-text">${escapeHtml(text)}</p>` : ""}
        ${imgHtml}
      </div>
    </a>
  `;
};

// Unfurl a truncated longform tweet in-place by pulling the note_tweet body
// out of TweetDetail. Bails if the lightbox was closed or switched during the
// fetch, and shares a cache with the "Show thread" button so we don't round-trip
// twice. Silent on failure — "Show thread" remains a manual fallback.
const maybeAutoExpandLongForm = async (root, bookmark) => {
  if (!looksTruncated(bookmark)) return;

  let data;
  try { data = await fetchThreadOnce(bookmark.id); }
  catch (err) { console.warn("auto-expand failed:", err); return; }

  const focal = data?.tweets?.find?.((t) => t.id === bookmark.id);
  if (!focal || !focal.text) return;
  if (focal.text.length <= (bookmark.text || "").length) return;

  // If the user moved on to another bookmark while we were fetching, skip.
  if (lbState.lightboxItem?.bookmark?.id !== bookmark.id) return;

  // Write back onto the live bookmark so share/copy and re-renders see the full text
  bookmark.text = focal.text;
  if (focal.urls?.length) bookmark.urls = focal.urls;
  if (focal.card && !bookmark.card) bookmark.card = focal.card;
  if (focal.quotedTweet && !bookmark.quotedTweet) bookmark.quotedTweet = focal.quotedTweet;

  const cleanText = focal.text.replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const textEl = root.querySelector(".lb-details-text");
  if (textEl) {
    textEl.textContent = cleanText;
  }

  // Refresh URL chips if the unfurled text carries new expanded URLs
  if (focal.urls?.length) {
    const newChipsHtml = buildUrlsHtml(focal.urls);
    const existing = root.querySelector(".lb-urls");
    if (existing) {
      existing.outerHTML = newChipsHtml;
    } else if (newChipsHtml && textEl) {
      textEl.insertAdjacentHTML("afterend", newChipsHtml);
    }
  }
};

// Fetches the thread via /thread?id=… on first click and replaces the button
// with the rendered conversation. Errors surface inline with a retry window.
const wireThreadButton = (root, bookmark) => {
  const btn = root.querySelector(".lb-thread-btn");
  const container = root.querySelector(".lb-thread");
  if (!btn || !container) return;

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.querySelector(".lb-thread-btn-label");
    if (label) label.textContent = "Loading thread…";

    try {
      const { tweets } = await fetchThreadOnce(bookmark.id);
      if (!Array.isArray(tweets) || tweets.length === 0) {
        if (label) label.textContent = "No thread available";
        return;
      }
      // If only the focal tweet came back, there's no real thread to show
      const others = tweets.filter((t) => t.id !== bookmark.id);
      if (others.length === 0) {
        if (label) label.textContent = "No thread available";
        return;
      }
      container.innerHTML = tweets.map((t) => renderThreadTweet(t, t.id === bookmark.id)).join("");
      container.hidden = false;
      btn.hidden = true;
    } catch (err) {
      console.warn("Thread fetch failed:", err);
      if (label) label.textContent = "Thread unavailable — tap to retry";
      setTimeout(() => {
        btn.disabled = false;
        if (label) label.textContent = "Show thread";
      }, 2500);
    }
  });
};

let lightboxClone = null;
let lbActionsEl = null;
let lbContextMenuEl = null;

// The side panel (#lightbox-info) is a persistent DOM node reused across
// openings. Without an explicit reset, its inline styles (size, opacity,
// pointer-events) survive close and intercept clicks on the grid underneath.
const resetSidePanel = () => {
  const sidePanel = document.getElementById("lightbox-info");
  if (!sidePanel) return;
  sidePanel.classList.remove("lb-side-panel", "lb-bottom-panel");
  sidePanel.removeAttribute("style");
  sidePanel.innerHTML = "";
};

// Right-click / long-press context menu on lightbox media. Mirrors the floating
// action buttons (share / copy / download) so the actions are reachable without
// needing the toolbar to be on screen — matches native image-viewer expectations.
const closeContextMenu = () => {
  if (!lbContextMenuEl) return;
  lbContextMenuEl.remove();
  lbContextMenuEl = null;
  document.removeEventListener("click", handleCtxOutsideClick, true);
  document.removeEventListener("keydown", handleCtxEscape, true);
  window.removeEventListener("scroll", closeContextMenu, true);
  window.removeEventListener("resize", closeContextMenu);
};

const handleCtxOutsideClick = (e) => {
  if (lbContextMenuEl && !lbContextMenuEl.contains(e.target)) closeContextMenu();
};
const handleCtxEscape = (e) => {
  if (e.key === "Escape") { e.stopPropagation(); closeContextMenu(); }
};

const openMediaContextMenu = (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!lbState.lightboxItem || lbState.lightboxItem.isTextOnly) return;
  const bm = lbState.lightboxItem.bookmark;
  const imgData = bm?.images?.[lbState.carouselIdx];
  if (!imgData) return;

  closeContextMenu();

  const isVideo = imgData.type === "video" || imgData.type === "animated_gif";
  const { url: mediaUrl, ext } = mediaDownloadUrl(imgData);
  const filename = bookmarkFilename(bm, ext);

  lbContextMenuEl = document.createElement("div");
  lbContextMenuEl.className = "lb-ctx-menu";
  lbContextMenuEl.innerHTML = `
    <button class="lb-ctx-item" data-action="share" type="button">${SHARE_ICON}<span>Share</span></button>
    ${!isVideo ? `<button class="lb-ctx-item" data-action="copy" type="button">${COPY_ICON}<span>Copy image</span></button>` : ""}
    <button class="lb-ctx-item" data-action="download" type="button">${DL_ICON}<span>Download ${isVideo ? "video" : "image"}</span></button>
  `;
  // Provisional offscreen position so we can measure then clamp to viewport
  lbContextMenuEl.style.left = "-9999px";
  lbContextMenuEl.style.top = "0";
  document.body.appendChild(lbContextMenuEl);

  const rect = lbContextMenuEl.getBoundingClientRect();
  const PAD = 8;
  const x = Math.min(Math.max(e.clientX, PAD), window.innerWidth - rect.width - PAD);
  const y = Math.min(Math.max(e.clientY, PAD), window.innerHeight - rect.height - PAD);
  lbContextMenuEl.style.left = `${x}px`;
  lbContextMenuEl.style.top = `${y}px`;

  lbContextMenuEl.querySelector('[data-action="share"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // Delegate to the existing toolbar share button so we reuse its Electron-IPC
    // → navigator.share → clipboard fallback chain without duplicating it here.
    lbActionsEl?.querySelector(".lb-share-btn")?.click();
    closeContextMenu();
  });
  lbContextMenuEl.querySelector('[data-action="copy"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const feedbackBtn = lbActionsEl?.querySelector(".lb-copy-btn");
    copyImageToClipboard(mediaUrl, feedbackBtn);
    closeContextMenu();
  });
  lbContextMenuEl.querySelector('[data-action="download"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (isVideo) {
      const dlBtn = lbActionsEl?.querySelector(".lb-dl-btn");
      if (dlBtn && !dlBtn.disabled) dlBtn.click();
    } else {
      downloadImage(mediaUrl, filename);
    }
    closeContextMenu();
  });

  // Defer so the originating right-click doesn't immediately close the menu
  setTimeout(() => {
    document.addEventListener("click", handleCtxOutsideClick, true);
    document.addEventListener("keydown", handleCtxEscape, true);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
  }, 0);
};

// Populates lightboxClone with a single photo (+ hi-res upgrade)
const lbShowPhoto = (container, imgData, fit = "cover") => {
  const thumb = document.createElement("img");
  thumb.src = twitterImageUrl(imgData.url, "medium");
  thumb.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};border-radius:inherit;`;
  container.appendChild(thumb);

  const hiRes = new Image();
  hiRes.src = twitterImageUrl(imgData.url, "4096x4096");
  hiRes.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};border-radius:inherit;opacity:0;transition:opacity 0.3s ease;`;
  hiRes.onload = () => { hiRes.style.opacity = "1"; };
  container.appendChild(hiRes);
};

const priorityVideoUrl = (videoUrl) =>
  `/proxy-video?url=${encodeURIComponent(videoUrl)}&priority=1`;

// Plyr wraps the <video> tag with its own chrome (.plyr container, controls,
// settings menu). We keep native <video> for animated_gif since GIFs are
// controls-less by design — Plyr's UI would just be in the way.
const PLYR_OPTS = {
  iconUrl: "node_modules/plyr/dist/plyr.svg",
  blankVideo: "",
  controls: ["play-large", "play", "progress", "current-time", "duration", "mute", "volume", "settings", "fullscreen"],
  settings: ["speed"],
  speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
  keyboard: { focused: true, global: false }, // global:false avoids stealing arrow keys from carousel
  tooltips: { controls: true, seek: true },
  fullscreen: { enabled: true, fallback: true, iosNative: false },
  storage: { enabled: true, key: "plyr_lightbox" },
};

// Initialise Plyr on a video element after it has been appended to the DOM.
// Returns the player instance (or null for GIFs / when Plyr isn't loaded).
// The .plyr wrapper is sized to fill the lightbox slot and click-bubbling is
// stopped so clicking the player doesn't dismiss the lightbox.
const initPlyr = (videoEl, isGif) => {
  if (isGif || typeof Plyr === "undefined") return null;
  const player = new Plyr(videoEl, PLYR_OPTS);
  const wrap = player.elements?.container;
  if (wrap) {
    wrap.style.cssText += "position:absolute;inset:0;width:100%;height:100%;z-index:2;background:#111;border-radius:inherit;";
    wrap.addEventListener("click", (e) => e.stopPropagation());
  }
  return player;
};

// Plyr.destroy() restores the underlying <video> back into the wrapper's slot.
// Safe to call with null/undefined.
const destroyPlyr = (player) => {
  if (!player) return;
  try { player.destroy(); } catch (err) { console.warn("Plyr destroy failed:", err); }
};

const RESTART_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;

const _wireVideoLoader = (videoEl, container, videoUrl, isGif) => {
  const restartBtn = document.createElement("button");
  restartBtn.className = "lb-video-restart";
  restartBtn.title = "Reload video";
  restartBtn.innerHTML = RESTART_ICON;
  container.appendChild(restartBtn);

  const hide = () => { restartBtn.classList.add("hidden"); };
  const show = () => { restartBtn.classList.remove("hidden"); };

  videoEl.addEventListener("playing", hide, { once: true });
  videoEl.addEventListener("error", show);
  videoEl.addEventListener("waiting", show);
  videoEl.addEventListener("canplay", hide);

  const doRestart = async () => {
    restartBtn.classList.add("lb-video-restart--loading");

    try {
      await fetch(`/video-cache-clear?url=${encodeURIComponent(videoUrl)}`, { method: "POST" });
    } catch {}

    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();

    const freshSrc = `${priorityVideoUrl(videoUrl)}&_t=${Date.now()}`;
    videoEl.src = freshSrc;

    videoEl.removeEventListener("playing", hide);
    videoEl.addEventListener("playing", hide, { once: true });

    videoEl.play().catch(() => {});
    restartBtn.classList.remove("lb-video-restart--loading");
  };

  restartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    doRestart();
  });
};

const lbShowVideo = (container, imgData, fit = "contain") => {
  const isGif = imgData.type === "animated_gif";

  const poster = document.createElement("img");
  poster.src = twitterImageUrl(imgData.url, "medium");
  poster.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};z-index:1;transition:opacity 0.3s ease;`;
  container.appendChild(poster);

  const video = document.createElement("video");
  video.src = priorityVideoUrl(imgData.videoUrl);
  video.controls = !isGif;
  video.autoplay = true;
  video.loop = isGif;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};z-index:2;background:#111;`;
  video.addEventListener("click", (e) => e.stopPropagation());
  container.appendChild(video);

  container._plyrPlayer = initPlyr(video, isGif);
  _wireVideoLoader(video, container, imgData.videoUrl, isGif);
  video.play().catch(() => {});
};

// Unified: photo or video based on imgData.type
const lbShowMedia = (container, imgData, fit = "contain") => {
  const isVideo = (imgData.type === "video" || imgData.type === "animated_gif") && imgData.videoUrl;
  if (isVideo) lbShowVideo(container, imgData, fit);
  else lbShowPhoto(container, imgData, fit);
};

const DL_BTN_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const CHECK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const wireVideoDownload = (btn, url, filename, authorHandle) => {
  const origHtml = btn.innerHTML;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("card-action-btn--downloading");
    btn.style.setProperty("--dl-progress", "0");
    btn.innerHTML = `${DL_BTN_ICON}<span class="dl-progress-text">0%</span>`;

    startDownload(url, filename, {
      authorHandle,
      onProgress: (pct) => {
        if (pct < 0) {
          btn.style.removeProperty("--dl-progress");
          btn.innerHTML = `${DL_BTN_ICON}<span class="dl-progress-text">…</span>`;
        } else {
          btn.style.setProperty("--dl-progress", String(pct));
          btn.querySelector(".dl-progress-text").textContent = `${pct}%`;
        }
      },
      onComplete: () => {
        btn.style.setProperty("--dl-progress", "100");
        btn.innerHTML = `${CHECK_ICON}<span class="dl-progress-text">OK</span>`;
        btn.style.color = "#4ade80";
        setTimeout(() => {
          btn.innerHTML = origHtml;
          btn.style.color = "";
          btn.style.removeProperty("--dl-progress");
          btn.classList.remove("card-action-btn--downloading");
          btn.disabled = false;
        }, 1500);
      },
      onError: () => {
        btn.innerHTML = origHtml;
        btn.style.removeProperty("--dl-progress");
        btn.classList.remove("card-action-btn--downloading");
        btn.disabled = false;
      },
    });
  };
};

// Update lightbox action buttons for the current image
const updateLbActions = (imgData) => {
  if (!lbActionsEl) return;
  const isVideo = imgData.type === "video" || imgData.type === "animated_gif";
  const { url, ext } = mediaDownloadUrl(imgData);
  const bm = lbState.lightboxItem?.bookmark;
  const filename = bm ? bookmarkFilename(bm, ext) : `bookmark.${ext}`;

  const copyBtn = lbActionsEl.querySelector(".lb-copy-btn");
  const dlBtn = lbActionsEl.querySelector(".lb-dl-btn");

  // Lift the action toolbar above Plyr's control bar when showing a video
  lbActionsEl.classList.toggle("lb-actions--video", isVideo);

  if (copyBtn) copyBtn.style.display = isVideo ? "none" : "";
  if (dlBtn) {
    if (isVideo) {
      wireVideoDownload(dlBtn, url, filename, bm?.authorHandle);
    } else {
      dlBtn.onclick = (e) => { e.stopPropagation(); downloadImage(url, filename); };
    }
  }
  if (copyBtn) copyBtn.onclick = (e) => { e.stopPropagation(); copyImageToClipboard(url, copyBtn); };

  lbActionsEl.style.display = "";
};

const closeAfterBookmarkRemoval = () => {
  const sourceEl = lbState.lightboxItem?.element;
  closeLightbox();
  if (sourceEl) {
    sourceEl.style.transition = "opacity 0.18s ease, transform 0.18s ease";
    setTimeout(() => {
      sourceEl.style.visibility = "";
      sourceEl.style.opacity = "0";
      sourceEl.style.transform = "scale(0.98)";
      setTimeout(() => sourceEl.remove(), 180);
    }, 260);
  }
};

const createLbActions = (bookmark) => {
  const wrap = document.createElement("div");
  wrap.className = "card-actions lb-actions";

  const shareBtn = buildShareButton(bookmark);
  shareBtn.classList.add("lb-share-btn");

  const removeBtn = buildRemoveBookmarkButton(bookmark, {
    onRemoved: closeAfterBookmarkRemoval,
  });
  removeBtn.classList.add("lb-remove-btn");

  const copyBtn = document.createElement("button");
  copyBtn.className = "card-action-btn lb-copy-btn";
  copyBtn.title = "Copy image";
  copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  const dlBtn = document.createElement("button");
  dlBtn.className = "card-action-btn lb-dl-btn";
  dlBtn.title = "Download";
  dlBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  const infoBtn = document.createElement("button");
  infoBtn.className = "card-action-btn lb-info-btn";
  infoBtn.title = "Show details";
  infoBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  infoBtn.style.display = "none";

  // Order: info (conditional) → share → unbookmark → copy → download
  wrap.appendChild(infoBtn);
  wrap.appendChild(shareBtn);
  wrap.appendChild(removeBtn);
  wrap.appendChild(copyBtn);
  wrap.appendChild(dlBtn);
  return wrap;
};

// Carousel nav (called by buttons and keyboard)
export const lbCarouselGoTo = (images, idx) => {
  closeContextMenu();
  lbState.carouselIdx = (idx + images.length) % images.length;
  const track = lightboxClone?.querySelector(".lb-track");
  if (!track) return;

  // Stop any playing video in the outgoing slide so it doesn't keep buffering.
  // Destroy Plyr first so its event listeners and DOM wrapper are torn down
  // cleanly before we wipe innerHTML.
  destroyPlyr(track._plyrPlayer);
  track._plyrPlayer = null;
  const prevVideo = track.querySelector("video");
  if (prevVideo) {
    try { prevVideo.pause(); } catch {}
    prevVideo.removeAttribute("src");
    prevVideo.load();
  }

  track.innerHTML = "";
  const imgData = images[lbState.carouselIdx];
  lbShowMedia(track, imgData, "contain");

  const counter = lightboxClone?.querySelector(".lb-counter");
  if (counter) counter.textContent = `${lbState.carouselIdx + 1} / ${images.length}`;

  // Update action buttons for current image
  updateLbActions(imgData);
};

const formatStatCount = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

// Text-only variant: a centered modal (no image clone, no spring-from-grid
// animation). Reuses the same URL / card / quoted / thread UI as the media
// lightbox's side panel so the two stay visually coherent.
const openTextLightbox = (el, bookmark) => {
  lbState.lightboxAnimating = true;
  lbState.lightboxOpen = true;
  lbState.lightboxItem = { element: el, bookmark, isTextOnly: true };

  const cleanText = (bookmark.text || "").replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const dateStr = bookmark.postedAt
    ? new Date(bookmark.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  const urlsHtml = buildUrlsHtml(bookmark.urls);
  const cardHtml = buildCardPreviewHtml(bookmark.card);
  const quotedHtml = buildQuotedHtml(bookmark.quotedTweet);

  // Text-only mode uses its own modal; fully reset the reusable side panel so
  // stale content/styles from a previous media lightbox don't leak through.
  resetSidePanel();

  lightboxClone = document.createElement("div");
  lightboxClone.className = "lb-text-modal";
  lightboxClone.innerHTML = `
    <div class="lb-text-modal-inner">
      <div class="lb-details-scroll-content">
        <div class="lb-details-author">
          <img class="lb-details-avatar" src="${escapeHtml(bookmark.authorAvatar)}" alt="">
          <div class="lb-details-author-text">
            <a href="https://x.com/${escapeHtml(bookmark.authorHandle)}" target="_blank" class="lb-details-name">${escapeHtml(bookmark.authorName)}</a>
            <span class="lb-details-handle">@${escapeHtml(bookmark.authorHandle)}</span>
          </div>
          <a href="${escapeHtml(bookmark.url)}" target="_blank" class="lb-details-twitter-link" title="Open on Twitter">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
        </div>
        ${cleanText ? `<p class="lb-details-text">${escapeHtml(cleanText)}</p>` : ""}
        ${urlsHtml}
        ${cardHtml}
        ${quotedHtml}
        <div class="lb-details-meta">
          ${dateStr ? `<span class="lb-details-date">${dateStr}</span>` : ""}
          <div class="lb-details-stats">
            ${bookmark.replyCount > 0 ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> ${formatStatCount(bookmark.replyCount)}</span>` : ""}
            ${bookmark.repostCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> ${formatStatCount(bookmark.repostCount)}</span>` : ""}
            ${bookmark.quoteCount > 0 ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 .985 0 1 0 1 1v1c0 1-1 2-2 2-1 0-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg> ${formatStatCount(bookmark.quoteCount)}</span>` : ""}
            ${bookmark.likeCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${formatStatCount(bookmark.likeCount)}</span>` : ""}
            ${bookmark.bookmarkCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> ${formatStatCount(bookmark.bookmarkCount)}</span>` : ""}
          </div>
        </div>
        <button class="lb-thread-btn" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="lb-thread-btn-label">Show thread</span>
        </button>
        <div class="lb-thread" hidden></div>
      </div>
    </div>
  `;

  document.body.appendChild(lightboxClone);
  lbActionsEl = createLbActions(bookmark);
  lbActionsEl.classList.add("lb-actions--text");
  lbActionsEl.querySelector(".lb-info-btn")?.remove();
  lbActionsEl.querySelector(".lb-copy-btn")?.remove();
  lbActionsEl.querySelector(".lb-dl-btn")?.remove();
  lightboxClone.appendChild(lbActionsEl);
  dom.overlay.classList.add("active");

  wireThreadButton(lightboxClone, bookmark);
  maybeAutoExpandLongForm(lightboxClone, bookmark);

  Motion.animate(
    lightboxClone,
    { opacity: [0, 1], transform: ["scale(0.97)", "scale(1)"] },
    { duration: 0.2, easing: "ease-out" }
  ).then(() => { lbState.lightboxAnimating = false; });
};

export const openLightbox = (el, bookmark) => {
  if (lbState.lightboxOpen || lbState.lightboxAnimating) return;
  const hasMedia = bookmark.images && bookmark.images.length > 0;
  if (!hasMedia) { openTextLightbox(el, bookmark); return; }

  lbState.lightboxAnimating = true;
  lbState.lightboxOpen = true;
  lbState.lightboxItem = { element: el, bookmark };
  lbState.carouselIdx = 0;

  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxH = vh * 0.88;
  const PANEL_W = vw >= 900 ? 360 : 0; 

  const img0 = bookmark.images[0];
  const isVideo0 = img0.type === "video" || img0.type === "animated_gif";
  const aspectRatio = isVideo0 ? 16 / 9 : img0.width / img0.height;

  const computeBounds = (hidePanel) => {
    const pw = hidePanel ? 0 : PANEL_W;
    const gap = hidePanel || pw === 0 ? 0 : 24;
    const mMaxW = (vw * 0.88) - pw - gap;
    
    let tW, tH;
    if (mMaxW / maxH > aspectRatio) {
      tH = maxH;
      tW = tH * aspectRatio;
    } else {
      tW = mMaxW;
      tH = tW / aspectRatio;
    }
    
    const eX = (vw - (tW + pw + gap)) / 2;
    const eY = (vh - tH) / 2;
    
    return { targetW: tW, targetH: tH, endX: eX, endY: eY, gap };
  };

  const boundsOptions = {
    shown: computeBounds(false),
    hidden: computeBounds(true)
  };

  const isHidden = PANEL_W > 0 && lbState.isPanelHidden;
  const currentBounds = isHidden ? boundsOptions.hidden : boundsOptions.shown;
  const { targetW, targetH, endX, endY } = currentBounds;
  const GAP = boundsOptions.shown.gap;

  const startX = rect.left;
  const startY = rect.top;
  const startW = rect.width;
  const startH = rect.height;

  el.style.visibility = "hidden";

  lightboxClone = document.createElement("div");
  lightboxClone.className = "grid-item lightbox-active";
  lightboxClone.style.cssText = `width:${startW}px;height:${startH}px;transform:translate3d(${startX}px,${startY}px,0);border-radius:20px;overflow:hidden;background:#111;`;

  // ── Single video / GIF ──────────────────────────────────────────────────────
  if (isVideo0) {
    pauseAllGridVideos();

    const poster = document.createElement("img");
    poster.src = twitterImageUrl(img0.url, "medium");
    poster.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;transition:opacity 0.3s ease;";
    lightboxClone.appendChild(poster);

    const gridVideo = el.querySelector(".card-video");
    if (gridVideo && img0.videoUrl) {
      const isGif = img0.type === "animated_gif";

      lbState.lightboxItem._gridVideo = gridVideo;
      lbState.lightboxItem._gridVideoParent = gridVideo.parentElement;
      lbState.lightboxItem._gridVideoStyle = gridVideo.getAttribute("style") || "";
      lbState.lightboxItem._gridVideoControls = gridVideo.controls;
      lbState.lightboxItem._gridVideoMuted = gridVideo.muted;
      lbState.lightboxItem._gridVideoSrc = gridVideo.src;

      gridVideo.setAttribute(
        "style",
        "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;background:#111;"
      );
      gridVideo.controls = !isGif;
      gridVideo.muted = true;

      const stopVideoClick = (e) => e.stopPropagation();
      gridVideo.addEventListener("click", stopVideoClick);
      lbState.lightboxItem._gridVideoClickStop = stopVideoClick;

      if (gridVideo.readyState >= 3) {
        poster.style.opacity = "0";
      } else {
        gridVideo.src = priorityVideoUrl(img0.videoUrl);
        gridVideo.load();
      }

      lightboxClone.appendChild(gridVideo);
      lbState.lightboxItem._plyrPlayer = initPlyr(gridVideo, isGif);
      _wireVideoLoader(gridVideo, lightboxClone, img0.videoUrl, isGif);
      gridVideo.play().catch(() => {});
    } else if (img0.videoUrl) {
      const isGif = img0.type === "animated_gif";
      const video = document.createElement("video");
      video.src = priorityVideoUrl(img0.videoUrl);
      video.controls = !isGif;
      video.autoplay = true;
      video.loop = isGif;
      video.muted = true;
      video.playsInline = true;
      video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;opacity:0;transition:opacity 0.3s ease;";
      video.addEventListener("click", (e) => e.stopPropagation());
      video.addEventListener("playing", () => { video.style.opacity = "1"; poster.style.opacity = "0"; }, { once: true });
      lightboxClone.appendChild(video);
      lbState.lightboxItem._plyrPlayer = initPlyr(video, isGif);
      _wireVideoLoader(video, lightboxClone, img0.videoUrl, isGif);
      video.play().catch(() => {});
    } else {
      const btn = document.createElement("button");
      btn.className = "lightbox-play-btn";
      btn.innerHTML = `<span class="play-pill visible"><img src="assets/play-icon.svg" class="play-pill-icon" alt=""><span>Play on Twitter</span></span>`;
      btn.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;z-index:3;";
      btn.addEventListener("click", (e) => { e.stopPropagation(); window.open(bookmark.url, "_blank"); });
      lightboxClone.appendChild(btn);
    }

  // ── Multi-image carousel ────────────────────────────────────────────────────
  } else if (bookmark.images.length > 1) {
    const images = bookmark.images;

    const track = document.createElement("div");
    track.className = "lb-track";
    track.style.cssText = "position:absolute;inset:0;background:#111;";
    lbShowMedia(track, img0, "contain");
    lightboxClone.appendChild(track);

    const mkBtn = (cls, svgPath) => {
      const btn = document.createElement("button");
      btn.className = `lb-carousel-btn ${cls}`;
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${svgPath}"/></svg>`;
      return btn;
    };
    const prevBtn = mkBtn("lb-prev", "15,18 9,12 15,6");
    const nextBtn = mkBtn("lb-next", "9,6 15,12 9,18");
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); lbCarouselGoTo(images, lbState.carouselIdx - 1); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); lbCarouselGoTo(images, lbState.carouselIdx + 1); });

    const counter = document.createElement("div");
    counter.className = "lb-counter";
    counter.textContent = `1 / ${images.length}`;

    lightboxClone.appendChild(prevBtn);
    lightboxClone.appendChild(nextBtn);
    lightboxClone.appendChild(counter);

  // ── Single photo ────────────────────────────────────────────────────────────
  } else {
    lbShowPhoto(lightboxClone, img0);
  }

  // Action buttons (share + copy + download) — copy hidden for videos
  lbActionsEl = createLbActions(bookmark);
  lightboxClone.appendChild(lbActionsEl);
  updateLbActions(img0);

  document.body.appendChild(lightboxClone);
  lightboxClone.addEventListener("contextmenu", openMediaContextMenu);
  dom.overlay.classList.add("active");

  const cleanText = bookmark.text.replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const formatCount = (n) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };
  const dateStr = bookmark.postedAt ? new Date(bookmark.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  const lightboxInfo = document.getElementById("lightbox-info");
  const urlsHtml = buildUrlsHtml(bookmark.urls);
  const cardHtml = buildCardPreviewHtml(bookmark.card);
  const quotedHtml = buildQuotedHtml(bookmark.quotedTweet);
  lightboxInfo.innerHTML = `
    ${PANEL_W > 0 ? `<button class="lb-details-hide-btn" aria-label="Hide panel">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </button>` : ""}
    <div class="lb-details-scroll-content">
      <div class="lb-details-author">
        <img class="lb-details-avatar" src="${escapeHtml(bookmark.authorAvatar)}" alt="">
        <div class="lb-details-author-text">
          <a href="https://x.com/${escapeHtml(bookmark.authorHandle)}" target="_blank" class="lb-details-name">${escapeHtml(bookmark.authorName)}</a>
          <span class="lb-details-handle">@${escapeHtml(bookmark.authorHandle)}</span>
        </div>
        <a href="${escapeHtml(bookmark.url)}" target="_blank" class="lb-details-twitter-link" title="Open on Twitter">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        </a>
      </div>
      ${cleanText ? `<p class="lb-details-text">${escapeHtml(cleanText)}</p>` : ""}
      ${urlsHtml}
      ${cardHtml}
      ${quotedHtml}
      <div class="lb-details-meta">
        ${dateStr ? `<span class="lb-details-date">${dateStr}</span>` : ""}
        <div class="lb-details-stats">
          ${bookmark.replyCount > 0 ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> ${formatCount(bookmark.replyCount)}</span>` : ""}
          ${bookmark.repostCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> ${formatCount(bookmark.repostCount)}</span>` : ""}
          ${bookmark.quoteCount > 0 ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 .985 0 1 0 1 1v1c0 1-1 2-2 2-1 0-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg> ${formatCount(bookmark.quoteCount)}</span>` : ""}
          ${bookmark.likeCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${formatCount(bookmark.likeCount)}</span>` : ""}
          ${bookmark.bookmarkCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> ${formatCount(bookmark.bookmarkCount)}</span>` : ""}
        </div>
      </div>
      <button class="lb-thread-btn" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="lb-thread-btn-label">Show thread</span>
      </button>
      <div class="lb-thread" hidden></div>
    </div>
  `;
  wireThreadButton(lightboxInfo, bookmark);
  maybeAutoExpandLongForm(lightboxInfo, bookmark);
  if (PANEL_W > 0) {
    const shownB = boundsOptions.shown;
    lightboxInfo.style.left = `${shownB.endX + shownB.targetW + GAP}px`;
    lightboxInfo.style.top = `${shownB.endY}px`;
    lightboxInfo.style.width = `${PANEL_W}px`;
    lightboxInfo.style.height = `${shownB.targetH}px`;
    
    lightboxInfo.classList.add("lb-side-panel");
    lightboxInfo.classList.remove("lb-bottom-panel");

    if (isHidden) {
      lightboxInfo.style.opacity = "0";
      lightboxInfo.style.pointerEvents = "none";
    }
  } else {
    lightboxInfo.style.left = "50%";
    lightboxInfo.style.top = `${endY + targetH + 16}px`;
    lightboxInfo.style.width = "100%";
    lightboxInfo.style.height = "auto";
    lightboxInfo.classList.add("lb-bottom-panel");
    lightboxInfo.classList.remove("lb-side-panel");
  }

  lbState.lightboxItem._endX = endX;
  lbState.lightboxItem._endY = endY;
  lbState.lightboxItem._endW = targetW;
  lbState.lightboxItem._endH = targetH;

  const infoBtn = lbActionsEl.querySelector(".lb-info-btn");
  if (infoBtn) {
    if (PANEL_W > 0) {
      if (isHidden) infoBtn.style.display = "";

      const hideBtn = lightboxInfo.querySelector(".lb-details-hide-btn");
      
      hideBtn.onclick = () => {
        lbState.isPanelHidden = true;
        localStorage.setItem("lbPanelHidden", "true");
        
        lightboxInfo.style.opacity = "0";
        lightboxInfo.style.pointerEvents = "none";
        infoBtn.style.display = ""; 
        
        const b = boundsOptions.hidden;
        Motion.animate(lightboxClone, { 
          width: `${b.targetW}px`, height: `${b.targetH}px`, transform: `translate3d(${b.endX}px, ${b.endY}px, 0)` 
        }, { duration: 0.35, easing: "ease-out" });
        
        lbState.lightboxItem._endX = b.endX;
        lbState.lightboxItem._endY = b.endY;
        lbState.lightboxItem._endW = b.targetW;
        lbState.lightboxItem._endH = b.targetH;
      };
      
      infoBtn.onclick = (e) => {
        e.stopPropagation();
        lbState.isPanelHidden = false;
        localStorage.setItem("lbPanelHidden", "false");
        
        const b = boundsOptions.shown;
        lightboxInfo.style.left = `${b.endX + b.targetW + GAP}px`;
        lightboxInfo.style.top = `${b.endY}px`;
        lightboxInfo.style.height = `${b.targetH}px`;
        
        lightboxInfo.style.opacity = "1";
        lightboxInfo.style.pointerEvents = "auto";
        infoBtn.style.display = "none";
        
        Motion.animate(lightboxClone, { 
          width: `${b.targetW}px`, height: `${b.targetH}px`, transform: `translate3d(${b.endX}px, ${b.endY}px, 0)` 
        }, { duration: 0.35, easing: "ease-out" });
        
        lbState.lightboxItem._endX = b.endX;
        lbState.lightboxItem._endY = b.endY;
        lbState.lightboxItem._endW = b.targetW;
        lbState.lightboxItem._endH = b.targetH;
      };
    } else {
      infoBtn.remove();
    }
  }

  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const springDuration = 0.22 + Math.min(distance / 2000, 0.08);

  Motion.animate(
    lightboxClone,
    {
      width: [`${startW}px`, `${targetW}px`],
      height: [`${startH}px`, `${targetH}px`],
      transform: [
        `translate3d(${startX}px, ${startY}px, 0)`,
        `translate3d(${endX}px, ${endY}px, 0)`,
      ],
    },
    { type: "spring", duration: springDuration, bounce: 0.15 }
  ).then(() => {
    lbState.lightboxAnimating = false;
  });
};

export const closeLightbox = () => {
  if (!lbState.lightboxOpen || lbState.lightboxAnimating || !lbState.lightboxItem) return;

  closeContextMenu();
  lbState.lightboxAnimating = true;

  if (lbState.lightboxItem.isTextOnly) {
    dom.overlay.classList.remove("active");
    Motion.animate(
      lightboxClone,
      { opacity: [1, 0], transform: ["scale(1)", "scale(0.97)"] },
      { duration: 0.16, easing: "ease-in" }
    ).then(() => {
      lightboxClone?.remove();
      lightboxClone = null;
      lbActionsEl = null;
      resetSidePanel();
      lbState.lightboxOpen = false;
      lbState.lightboxItem = null;
      lbState.lightboxAnimating = false;
    });
    return;
  }

  const { element: el } = lbState.lightboxItem;

  // Don't pause the reused grid video — it should keep playing in the grid

  dom.overlay.classList.remove("active");

  const originalRect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inViewport =
    originalRect.bottom > 0 &&
    originalRect.top < vh &&
    originalRect.right > 0 &&
    originalRect.left < vw;

  const fromX = lbState.lightboxItem._endX;
  const fromY = lbState.lightboxItem._endY;
  const fromW = lbState.lightboxItem._endW;
  const fromH = lbState.lightboxItem._endH;

  const cleanup = () => {
    // Tear down Plyr first so the underlying <video> is unwrapped from the
    // .plyr container before we try to move/reset it back into the grid card.
    destroyPlyr(lbState.lightboxItem?._plyrPlayer);
    const gv = lbState.lightboxItem?._gridVideo;
    const gvParent = lbState.lightboxItem?._gridVideoParent;
    if (gv && gvParent) {
      const clickStop = lbState.lightboxItem._gridVideoClickStop;
      if (clickStop) gv.removeEventListener("click", clickStop);
      gv.setAttribute("style", lbState.lightboxItem._gridVideoStyle);
      gv.controls = lbState.lightboxItem._gridVideoControls;
      gv.muted = lbState.lightboxItem._gridVideoMuted;

      if (lbState.lightboxItem._gridVideoSrc) {
        gv.src = lbState.lightboxItem._gridVideoSrc;
        gv.load();
      }

      gvParent.appendChild(gv);
    }
    // Carousel slides may have their own Plyr instances on the track element
    const track = lightboxClone?.querySelector(".lb-track");
    if (track?._plyrPlayer) destroyPlyr(track._plyrPlayer);
    lightboxClone.remove();
    lightboxClone = null;
    lbActionsEl = null;
    resetSidePanel();
    el.style.visibility = "";
    lbState.lightboxOpen = false;
    lbState.lightboxItem = null;
    lbState.lightboxAnimating = false;
    resumeVisibleGridVideos();
  };

  if (!inViewport) {
    Motion.animate(
      lightboxClone,
      { opacity: [1, 0], scale: [1, 0.92] },
      { duration: 0.22, easing: "ease-in" }
    ).then(cleanup);
    return;
  }

  Motion.animate(
    lightboxClone,
    {
      width: [`${fromW}px`, `${originalRect.width}px`],
      height: [`${fromH}px`, `${originalRect.height}px`],
      transform: [
        `translate3d(${fromX}px, ${fromY}px, 0)`,
        `translate3d(${originalRect.left}px, ${originalRect.top}px, 0)`,
      ],
    },
    { type: "spring", duration: 0.2, bounce: 0 }
  ).then(cleanup);
};
