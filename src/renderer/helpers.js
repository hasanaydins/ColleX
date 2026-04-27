// --- Utility helpers & shared icons ---

export const escapeHtml = (str) =>
  str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- Twitter image sizing ---
export const twitterImageUrl = (url, size = "small") => {
  const base = url.split("?")[0];
  const ext = base.match(/\.(jpg|jpeg|png)$/i);
  const format = ext ? ext[1].toLowerCase() : "jpg";
  return `${base}?format=${format}&name=${size}`;
};

// Extract first non-Twitter URL from tweet text
export const extractUrl = (text) => {
  const m = text.match(/https?:\/\/(?!t\.co\/)[^\s]+/);
  return m ? m[0] : null;
};

export const hostnameOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

// Best external link for a bookmark — prefers the X card's canonical URL, then
// any non-t.co URL extracted from the tweet body, then the first expanded URL
// we captured during sync. Returns null if none found.
export const primaryLinkFor = (bm) => {
  if (bm?.card?.url) return bm.card.url;
  const fromText = extractUrl(bm?.text || "");
  if (fromText) return fromText;
  const fromUrls = (bm?.urls || []).find((u) => u?.expanded)?.expanded;
  return fromUrls || null;
};

// Prevent events from bubbling out of control areas
export const stopControlEvents = (el) => {
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation());
};

// --- SVG icon constants ---

export const DL_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

export const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

export const SHARE_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;

export const UNBOOKMARK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/></svg>`;
