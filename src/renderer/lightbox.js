// --- Lightbox: open, close, carousel navigation ---

import { dom } from './state.js';
import { twitterImageUrl, escapeHtml } from './helpers.js';
import { downloadImage, copyImageToClipboard, mediaDownloadUrl, bookmarkFilename } from './media.js';
import { buildShareButton } from './card.js';

export const lbState = {
  lightboxOpen: false,
  lightboxItem: null,
  lightboxAnimating: false,
  carouselIdx: 0,
  isPanelHidden: localStorage.getItem("lbPanelHidden") === "true",
};

let lightboxClone = null;
let lbActionsEl = null;

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

// Show a video slide inside the carousel (fresh element, autoplay)
const lbShowVideo = (container, imgData, fit = "contain") => {
  const isGif = imgData.type === "animated_gif";

  const poster = document.createElement("img");
  poster.src = twitterImageUrl(imgData.url, "medium");
  poster.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};z-index:1;transition:opacity 0.3s ease;`;
  container.appendChild(poster);

  const video = document.createElement("video");
  video.src = `/proxy-video?url=${encodeURIComponent(imgData.videoUrl)}`;
  video.controls = !isGif;
  video.autoplay = true;
  video.loop = isGif;
  video.muted = isGif;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};z-index:2;background:#111;`;
  video.addEventListener("playing", () => { poster.style.opacity = "0"; }, { once: true });
  video.addEventListener("click", (e) => e.stopPropagation());
  container.appendChild(video);
  video.play().catch(() => {});
};

// Unified: photo or video based on imgData.type
const lbShowMedia = (container, imgData, fit = "contain") => {
  const isVideo = (imgData.type === "video" || imgData.type === "animated_gif") && imgData.videoUrl;
  if (isVideo) lbShowVideo(container, imgData, fit);
  else lbShowPhoto(container, imgData, fit);
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

  if (copyBtn) copyBtn.style.display = isVideo ? "none" : "";
  if (dlBtn) dlBtn.onclick = (e) => { e.stopPropagation(); downloadImage(url, filename); };
  if (copyBtn) copyBtn.onclick = (e) => { e.stopPropagation(); copyImageToClipboard(url, copyBtn); };

  lbActionsEl.style.display = "";
};

const createLbActions = (bookmark) => {
  const wrap = document.createElement("div");
  wrap.className = "card-actions lb-actions";

  const shareBtn = buildShareButton(bookmark);
  shareBtn.classList.add("lb-share-btn");

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

  // Order: info (conditional) → share → copy → download
  wrap.appendChild(infoBtn);
  wrap.appendChild(shareBtn);
  wrap.appendChild(copyBtn);
  wrap.appendChild(dlBtn);
  return wrap;
};

// Carousel nav (called by buttons and keyboard)
export const lbCarouselGoTo = (images, idx) => {
  lbState.carouselIdx = (idx + images.length) % images.length;
  const track = lightboxClone?.querySelector(".lb-track");
  if (!track) return;

  // Stop any playing video in the outgoing slide so it doesn't keep buffering
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

export const openLightbox = (el, bookmark) => {
  if (lbState.lightboxOpen || lbState.lightboxAnimating) return;
  if (!bookmark.images || bookmark.images.length === 0) return;

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
    // Poster shown only until the video is ready
    const poster = document.createElement("img");
    poster.src = twitterImageUrl(img0.url, "medium");
    poster.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;transition:opacity 0.3s ease;";
    lightboxClone.appendChild(poster);

    // Reuse the grid video element — no reload, no rebuffer
    const gridVideo = el.querySelector(".card-video");
    if (gridVideo && img0.videoUrl) {
      const isGif = img0.type === "animated_gif";

      // Save state to restore on close
      lbState.lightboxItem._gridVideo = gridVideo;
      lbState.lightboxItem._gridVideoParent = gridVideo.parentElement;
      lbState.lightboxItem._gridVideoStyle = gridVideo.getAttribute("style") || "";
      lbState.lightboxItem._gridVideoControls = gridVideo.controls;
      lbState.lightboxItem._gridVideoMuted = gridVideo.muted;

      // Re-style and move into lightbox
      gridVideo.setAttribute(
        "style",
        "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;background:#111;"
      );
      gridVideo.controls = !isGif;
      gridVideo.muted = false;

      // Stop clicks on the video from bubbling up while it's inside the lightbox.
      // Keep a reference so we can remove it on close — otherwise the listener
      // persists after the video is restored to its card and swallows the next
      // click, preventing the lightbox from reopening.
      const stopVideoClick = (e) => e.stopPropagation();
      gridVideo.addEventListener("click", stopVideoClick);
      lbState.lightboxItem._gridVideoClickStop = stopVideoClick;

      // If the video has enough data, hide poster immediately
      if (gridVideo.readyState >= 2) poster.style.opacity = "0";
      else gridVideo.addEventListener("playing", () => { poster.style.opacity = "0"; }, { once: true });

      lightboxClone.appendChild(gridVideo);
      gridVideo.play().catch(() => {});
    } else if (img0.videoUrl) {
      // Fallback: no grid video found — create a fresh one
      const isGif = img0.type === "animated_gif";
      const video = document.createElement("video");
      video.src = `/proxy-video?url=${encodeURIComponent(img0.videoUrl)}`;
      video.controls = !isGif;
      video.autoplay = true;
      video.loop = isGif;
      video.muted = false;
      video.playsInline = true;
      video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;opacity:0;transition:opacity 0.3s ease;";
      video.addEventListener("playing", () => { video.style.opacity = "1"; poster.style.opacity = "0"; }, { once: true });
      video.addEventListener("click", (e) => e.stopPropagation());
      lightboxClone.appendChild(video);
    } else {
      // No video URL — show "Play on Twitter" button
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
  dom.overlay.classList.add("active");

  const cleanText = bookmark.text.replace(/https?:\/\/t\.co\/\S+/g, "").trim();
  const formatCount = (n) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };
  const dateStr = bookmark.postedAt ? new Date(bookmark.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  const lightboxInfo = document.getElementById("lightbox-info");
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
      <div class="lb-details-meta">
        ${dateStr ? `<span class="lb-details-date">${dateStr}</span>` : ""}
        <div class="lb-details-stats">
          ${bookmark.repostCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> ${formatCount(bookmark.repostCount)}</span>` : ""}
          ${bookmark.likeCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${formatCount(bookmark.likeCount)}</span>` : ""}
          ${bookmark.bookmarkCount != null ? `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> ${formatCount(bookmark.bookmarkCount)}</span>` : ""}
        </div>
      </div>
    </div>
  `;
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

  lbState.lightboxAnimating = true;
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
    // Restore the moved grid video back to its card before removing the clone
    const gv = lbState.lightboxItem?._gridVideo;
    const gvParent = lbState.lightboxItem?._gridVideoParent;
    if (gv && gvParent) {
      const clickStop = lbState.lightboxItem._gridVideoClickStop;
      if (clickStop) gv.removeEventListener("click", clickStop);
      gv.setAttribute("style", lbState.lightboxItem._gridVideoStyle);
      gv.controls = lbState.lightboxItem._gridVideoControls;
      gv.muted = lbState.lightboxItem._gridVideoMuted;
      gvParent.appendChild(gv);
    }
    lightboxClone.remove();
    lightboxClone = null;
    lbActionsEl = null;
    el.style.visibility = "";
    lbState.lightboxOpen = false;
    lbState.lightboxItem = null;
    lbState.lightboxAnimating = false;
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
