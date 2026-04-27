// --- Card building: HTML generation & action buttons ---

import { escapeHtml, hostnameOf, DL_ICON, COPY_ICON, SHARE_ICON, UNBOOKMARK_ICON } from './helpers.js';
import { buildMediaHtml, downloadImage, copyImageToClipboard, bookmarkFilename, mediaDownloadUrl, triggerAnchorDownload, bookmarksToZip } from './media.js';
import { startDownload } from './downloads.js';
import { state } from './state.js';

// --- Stats row (reply, repost, quote, like, bookmark) ---
// Reply/quote are hidden when zero since many tweets have none; showing "0"
// everywhere would clutter the card. Existing counters keep their original
// `!= null` behaviour for backwards compatibility with older bookmark data.
const buildStatsHtml = (bm) => {
  const items = [];
  if (bm.replyCount > 0) items.push(`<span class="stat-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>${formatCount(bm.replyCount)}</span>`);
  if (bm.repostCount != null) items.push(`<span class="stat-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>${formatCount(bm.repostCount)}</span>`);
  if (bm.quoteCount > 0) items.push(`<span class="stat-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 .985 0 1 0 1 1v1c0 1-1 2-2 2-1 0-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg>${formatCount(bm.quoteCount)}</span>`);
  if (bm.likeCount != null) items.push(`<span class="stat-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${formatCount(bm.likeCount)}</span>`);
  if (bm.bookmarkCount != null) items.push(`<span class="stat-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${formatCount(bm.bookmarkCount)}</span>`);
  return items.length ? `<div class="card-stats">${items.join("")}</div>` : "";
};

const formatCount = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

// --- Date formatting ---
const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const buildDateHtml = (bm) => {
  if (!bm.postedAt) return "";
  return `<span class="card-date">${formatDate(bm.postedAt)}</span>`;
};

// --- Masonry / Card view card ---
export const buildCardHtml = (bm) => {
  const hasMedia = bm.images && bm.images.length > 0;
  const fields = state.viewFields[state.activeView];
  const cleanText = bm.text.replace(/https?:\/\/t\.co\/\S+/g, "").trim();

  const authorHtml = fields.author ? `
    <div class="card-author">
      <img class="card-avatar" src="${escapeHtml(bm.authorAvatar)}" alt="" loading="lazy">
      <div class="card-author-text">
        <span class="card-author-name">${escapeHtml(bm.authorName)}</span>
        <span class="card-author-handle">@${escapeHtml(bm.authorHandle)}</span>
      </div>
    </div>
  ` : "";

  const textHtml = (fields.text && cleanText) ? `<p class="card-text">${escapeHtml(cleanText)}</p>` : "";
  const statsHtml = fields.stats ? buildStatsHtml(bm) : "";
  const dateHtml = fields.date ? buildDateHtml(bm) : "";

  const infoContent = authorHtml + textHtml + statsHtml + dateHtml;
  const showInfo = infoContent.trim().length > 0;

  if (hasMedia) {
    const mediaHtml = fields.media ? buildMediaHtml(bm.images) : "";
    return `${mediaHtml}${showInfo ? `<div class="card-info">${infoContent}</div>` : ""}`;
  }

  // Text-only card. Prefer X's own card thumbnail (instant, richer) and fall
  // back to an async OG scrape for older bookmarks without card data.
  const linkPreviewHtml = bm.card
    ? buildXCardPreviewHtml(bm.card)
    : `<div class="og-wrap" data-needs-og="1"></div>`;
  return `
    <div class="card-info card-info--text-only">${infoContent}</div>
    ${linkPreviewHtml}
  `;
};

// Inline X-card thumbnail for text-only grid cards (reuses .og-wrap styling so
// the grid visually matches pre-existing OG cards). Click wiring happens in
// grid.js so the card-level click handler can be short-circuited.
const buildXCardPreviewHtml = (card) => {
  const imgHtml = card.image?.url
    ? `<img class="og-image" src="${escapeHtml(card.image.url)}" alt="" loading="lazy">`
    : "";
  const domain = card.vanityUrl || hostnameOf(card.url || "");
  return `
    <div class="og-wrap og-wrap--x loaded">
      ${imgHtml}
      <div class="og-meta">
        ${card.title ? `<span class="og-title">${escapeHtml(card.title)}</span>` : ""}
        ${domain ? `<span class="og-domain">${escapeHtml(domain)}</span>` : ""}
      </div>
    </div>
  `;
};

// --- List view item ---
export const buildListItemHtml = (bm) => {
  const hasMedia = bm.images && bm.images.length > 0;
  const fields = state.viewFields.list;
  const cleanText = bm.text.replace(/https?:\/\/t\.co\/\S+/g, "").trim();

  let thumbHtml = "";
  if (fields.media && hasMedia) {
    const img = bm.images[0];
    const isVideo = (img.type === "video" || img.type === "animated_gif") && img.videoUrl;
    const isGif = img.type === "animated_gif";
    const thumbUrl = img.url;
    const mediaEl = isVideo
      ? `<video class="card-video" data-src="/proxy-video?url=${encodeURIComponent(img.videoUrl)}" poster="${escapeHtml(thumbUrl)}" ${isGif ? "loop" : ""} muted playsinline></video>`
      : `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy">`;
    thumbHtml = `
      <div class="list-thumb">
        ${mediaEl}
        ${isVideo ? `<div class="video-loader video-loader--sm" aria-hidden="true"></div>` : ""}
        ${isVideo ? `<div class="list-thumb-badge">${isGif ? "GIF" : "▶"}</div>` : ""}
        ${bm.images.length > 1 ? `<div class="list-thumb-count">${bm.images.length}</div>` : ""}
      </div>
    `;
  }

  const authorHtml = fields.author ? `
    <div class="list-author">
      <img class="list-avatar" src="${escapeHtml(bm.authorAvatar)}" alt="" loading="lazy">
      <span class="list-author-name">${escapeHtml(bm.authorName)}</span>
      <span class="list-author-handle">@${escapeHtml(bm.authorHandle)}</span>
    </div>
  ` : "";

  const textHtml = (fields.text && cleanText) ? `<p class="list-text">${escapeHtml(cleanText)}</p>` : "";
  const statsHtml = fields.stats ? buildStatsHtml(bm) : "";
  const dateHtml = fields.date ? buildDateHtml(bm) : "";

  const metaHtml = (statsHtml || dateHtml) ? `<div class="list-meta">${statsHtml}${dateHtml}</div>` : "";

  return `
    ${thumbHtml}
    <div class="list-content">
      ${authorHtml}
      ${textHtml}
      ${metaHtml}
    </div>
  `;
};

// Native share. Priority:
//   1) Electron IPC bridge → macOS native share sheet (AirDrop, Messages, Mail)
//   2) navigator.share     → mobile PWA native share sheet
//   3) Clipboard copy      → silent fallback with ✓ feedback
export const buildShareButton = (bm) => {
  const shareBtn = document.createElement("button");
  shareBtn.className = "card-action-btn";
  shareBtn.title = "Share";
  shareBtn.innerHTML = SHARE_ICON;

  const flashCopied = () => {
    const originalHtml = shareBtn.innerHTML;
    shareBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    shareBtn.style.color = "#4ade80";
    setTimeout(() => {
      shareBtn.innerHTML = originalHtml;
      shareBtn.style.color = "";
    }, 1200);
  };

  shareBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    const title = bm.authorName ? `${bm.authorName} on X` : "X bookmark";
    const cleanText = (bm.text || "").replace(/https?:\/\/t\.co\/\S+/g, "").trim();
    const text = cleanText ? cleanText.slice(0, 200) : "";

    // 1) Electron (macOS) — native share menu via IPC
    if (window.electronAPI?.shareUrl) {
      try {
        const ok = await window.electronAPI.shareUrl({ url: bm.url, title, text });
        if (ok) return;
      } catch (err) {
        console.warn("Electron share failed:", err);
      }
    }

    // 2) Web Share API (mobile PWA primarily)
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: bm.url, title, ...(text && { text }) });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
        console.warn("navigator.share failed, falling back to clipboard:", err);
      }
    }

    // 3) Clipboard fallback
    try {
      await navigator.clipboard.writeText(bm.url);
      flashCopied();
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  });
  return shareBtn;
};

const removeBookmarkLocally = (id) => {
  const sameId = (bm) => String(bm.id) === String(id);
  state.allBookmarks = state.allBookmarks.filter((bm) => !sameId(bm));
  state.filteredBookmarks = state.filteredBookmarks.filter((bm) => !sameId(bm));

  const badge = document.getElementById("results-count");
  if (badge) badge.textContent = state.filteredBookmarks.length;
};

export const buildRemoveBookmarkButton = (bm, { onRemoved } = {}) => {
  const btn = document.createElement("button");
  btn.className = "card-action-btn card-action-btn--remove";
  btn.title = "Remove from bookmarks";
  btn.setAttribute("aria-label", "Remove from bookmarks");
  btn.innerHTML = UNBOOKMARK_ICON;

  const originalHtml = btn.innerHTML;

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;

    const author = bm.authorHandle ? `@${bm.authorHandle}` : "this post";
    const ok = window.confirm(`Remove ${author} from your X bookmarks?`);
    if (!ok) return;

    btn.disabled = true;
    btn.classList.add("card-action-btn--busy");
    btn.innerHTML = `<span class="action-spinner" aria-hidden="true"></span>`;

    try {
      const res = await fetch("/bookmark/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bm.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      removeBookmarkLocally(bm.id);
      const item = btn.closest(".grid-item, .card-view-item, .list-item");
      if (typeof onRemoved === "function") {
        onRemoved({ button: btn, item });
        return;
      }
      if (item) {
        item.style.transition = "opacity 0.18s ease, transform 0.18s ease";
        item.style.opacity = "0";
        item.style.transform = "scale(0.98)";
        setTimeout(() => item.remove(), 180);
      }
    } catch (err) {
      console.error("Remove bookmark failed:", err);
      btn.classList.remove("card-action-btn--busy");
      btn.innerHTML = originalHtml;
      btn.disabled = false;
      window.alert(`Could not remove bookmark: ${err.message}`);
    }
  });

  return btn;
};

export const addCardActions = (mediaWrap, images, bm) => {
  const wrap = document.createElement("div");
  wrap.className = "card-actions";

  // Share button is always first
  wrap.appendChild(buildShareButton(bm));
  wrap.appendChild(buildRemoveBookmarkButton(bm));

  if (images.length > 1) {
    // Multi-image: zip all media into single download
    const dlBtn = document.createElement("button");
    dlBtn.className = "card-action-btn card-action-btn--multi";
    dlBtn.title = `Download all ${images.length} items as ZIP`;
    const origHtml = `${DL_ICON}<span>${images.length}</span>`;
    dlBtn.innerHTML = origHtml;

    dlBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      dlBtn.disabled = true;
      dlBtn.innerHTML = `${DL_ICON}<span>…</span>`;
      try {
        const { zipBlob, totalFiles } = await bookmarksToZip([bm]);
        const dateStr = new Date().toISOString().slice(0, 10);
        const safeHandle = (bm.authorHandle || "bookmark").replace(/[^\w\-]/g, "_");
        triggerAnchorDownload(URL.createObjectURL(zipBlob), `${safeHandle}_${dateStr}.zip`);

        // Success feedback: checkmark
        dlBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>${totalFiles}</span>`;
        dlBtn.style.color = "#4ade80";
        setTimeout(() => {
          dlBtn.innerHTML = origHtml;
          dlBtn.style.color = "";
          dlBtn.disabled = false;
        }, 1500);
      } catch (err) {
        console.error(err);
        dlBtn.innerHTML = origHtml;
        dlBtn.disabled = false;
      }
    });
    wrap.appendChild(dlBtn);
  } else {
    const img = images[0];
    const isVideo = img.type === "video" || img.type === "animated_gif";
    const { url: dlUrl, ext } = mediaDownloadUrl(img);
    const filename = bookmarkFilename(bm, ext);

    if (!isVideo) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "card-action-btn";
      copyBtn.title = "Copy image";
      copyBtn.innerHTML = COPY_ICON;
      copyBtn.addEventListener("click", (e) => { e.stopPropagation(); copyImageToClipboard(dlUrl, copyBtn); });
      wrap.appendChild(copyBtn);
    }

    const dlBtn = document.createElement("button");
    dlBtn.className = "card-action-btn";
    dlBtn.title = isVideo ? "Download video" : "Download image";
    dlBtn.innerHTML = DL_ICON;
    if (isVideo) {
      const origHtml = dlBtn.innerHTML;
      dlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dlBtn.disabled) return;
        dlBtn.disabled = true;
        dlBtn.classList.add("card-action-btn--downloading");
        dlBtn.style.setProperty("--dl-progress", "0");
        dlBtn.innerHTML = `${DL_ICON}<span class="dl-progress-text">0%</span>`;

        const gridItem = dlBtn.closest('.grid-item, .card-view-item, .list-item');
        if (gridItem) gridItem.classList.add('grid-item--downloading');

        startDownload(dlUrl, filename, {
          authorHandle: bm.authorHandle,
          onProgress: (pct) => {
            if (!document.contains(dlBtn)) return;
            if (pct < 0) {
              dlBtn.style.removeProperty("--dl-progress");
              dlBtn.innerHTML = `${DL_ICON}<span class="dl-progress-text">…</span>`;
            } else {
              dlBtn.style.setProperty("--dl-progress", String(pct));
              dlBtn.querySelector(".dl-progress-text").textContent = `${pct}%`;
            }
          },
          onComplete: () => {
            if (!document.contains(dlBtn)) return;
            dlBtn.style.setProperty("--dl-progress", "100");
            dlBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="dl-progress-text">OK</span>`;
            dlBtn.style.color = "#4ade80";
            const item = dlBtn.closest('.grid-item, .card-view-item, .list-item');
            if (item) item.classList.remove('grid-item--downloading');
            setTimeout(() => {
              dlBtn.innerHTML = origHtml;
              dlBtn.style.color = "";
              dlBtn.style.removeProperty("--dl-progress");
              dlBtn.classList.remove("card-action-btn--downloading");
              dlBtn.disabled = false;
            }, 1500);
          },
          onError: () => {
            if (!document.contains(dlBtn)) return;
            dlBtn.innerHTML = origHtml;
            dlBtn.style.removeProperty("--dl-progress");
            dlBtn.classList.remove("card-action-btn--downloading");
            dlBtn.disabled = false;
            const item = dlBtn.closest('.grid-item, .card-view-item, .list-item');
            if (item) item.classList.remove('grid-item--downloading');
          },
        });
      });
    } else {
      dlBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadImage(dlUrl, filename); });
    }
    wrap.appendChild(dlBtn);
  }

  mediaWrap.appendChild(wrap);
};
