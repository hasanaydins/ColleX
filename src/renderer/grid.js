// --- Grid rendering: masonry, card, and list views ---

import { state, CONFIG, dom } from './state.js';
import { buildCardHtml, buildListItemHtml, addCardActions, buildShareButton } from './card.js';
import { loadOgCard, mediaHeight } from './media.js';
import { selectState, toggleCardSelected } from './select.js';
import { openLightbox } from './lightbox.js';

// Single shared IntersectionObserver for all video autoplay — much cheaper than one per card
let videoObserver = null;

// Bind a one-time "playing" listener to fade out the loader spinner
const bindVideoLoader = (videoEl) => {
  const loader = videoEl.parentElement?.querySelector(".video-loader");
  if (!loader) return;
  const hide = () => loader.classList.add("hidden");
  videoEl.addEventListener("playing", hide, { once: true });
  videoEl.addEventListener("error", hide, { once: true });
};

const getVideoObserver = () => {
  if (videoObserver) videoObserver.disconnect();
  videoObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const v = entry.target;
      if (entry.isIntersecting) {
        if (!v.src) v.src = v.dataset.src;
        v.play().catch(() => {});
      } else {
        v.pause();
      }
    }
  }, { threshold: 0.2 });
  return videoObserver;
};

export const applyFilters = () => {
  // Media type filter
  let results;
  if (state.activeMediaType !== "all") {
    results = state.allBookmarks.filter((b) => {
      if (!b.images || b.images.length === 0) return false;
      const typeMap = { photo: "photo", video: "video", gif: "animated_gif" };
      return b.images[0].type === typeMap[state.activeMediaType];
    });
  } else {
    results = [...state.allBookmarks];
  }

  if (state.activeFolder !== "All") {
    results = results.filter((b) => b.folders && b.folders.includes(state.activeFolder));
  }

  if (state.activeSearch.trim()) {
    const q = state.activeSearch.toLowerCase().trim();
    results = results.filter(
      (b) =>
        b.text?.toLowerCase().includes(q) ||
        b.authorHandle?.toLowerCase().includes(q) ||
        b.authorName?.toLowerCase().includes(q)
    );
  }

  const sortFns = {
    newest: (a, b) => new Date(b.postedAt) - new Date(a.postedAt),
    oldest: (a, b) => new Date(a.postedAt) - new Date(b.postedAt),
    likes: (a, b) => (b.likeCount || 0) - (a.likeCount || 0),
    bookmarks: (a, b) => (b.bookmarkCount || 0) - (a.bookmarkCount || 0),
    reposts: (a, b) => (b.repostCount || 0) - (a.repostCount || 0),
  };
  results.sort(sortFns[state.activeSort] || sortFns.newest);
  state.filteredBookmarks = results;

  const badge = document.getElementById("results-count");
  if (badge) badge.textContent = results.length;
};

// --- Masonry layout ---
const renderMasonry = (sharedVideoObserver) => {
  const colCount = CONFIG.COLS;
  const gap = CONFIG.GAP;
  const vw = window.innerWidth;
  const colWidth = (vw - gap * (colCount + 1)) / colCount;

  const colHeights = new Array(colCount).fill(0);
  const colEls = Array.from({ length: colCount }, () => {
    const col = document.createElement("div");
    col.className = "masonry-col";
    dom.grid.appendChild(col);
    return col;
  });

  for (const bm of state.filteredBookmarks) {
    let minCol = 0;
    for (let c = 1; c < colCount; c++) {
      if (colHeights[c] < colHeights[minCol]) minCol = c;
    }

    const hasMedia = bm.images && bm.images.length > 0;
    const fields = state.viewFields.masonry;
    if (hasMedia && fields.media) {
      const itemH = mediaHeight(bm.images, colWidth);
      const infoH = (fields.author || fields.text) ? 105 : 0;
      colHeights[minCol] += itemH + infoH + gap;
    } else {
      colHeights[minCol] += 160 + gap;
    }

    const item = document.createElement("div");
    item.className = hasMedia ? "grid-item" : "grid-item grid-item--text";
    item.innerHTML = buildCardHtml(bm);

    setupCardInteractions(item, bm, hasMedia, sharedVideoObserver);
    colEls[minCol].appendChild(item);
  }
};

// --- Card (uniform grid) layout ---
const renderCardGrid = (sharedVideoObserver) => {
  dom.grid.className = "grid-cards";

  const colCount = CONFIG.COLS;
  dom.grid.style.setProperty("--card-cols", colCount);

  for (const bm of state.filteredBookmarks) {
    const hasMedia = bm.images && bm.images.length > 0;
    const item = document.createElement("div");
    item.className = hasMedia ? "grid-item card-view-item" : "grid-item card-view-item grid-item--text";
    item.innerHTML = buildCardHtml(bm);

    setupCardInteractions(item, bm, hasMedia, sharedVideoObserver);
    dom.grid.appendChild(item);
  }
};

// --- List layout ---
const renderList = (sharedVideoObserver) => {
  dom.grid.className = "grid-list";

  for (const bm of state.filteredBookmarks) {
    const hasMedia = bm.images && bm.images.length > 0;
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = buildListItemHtml(bm);

    // Autoplay video thumbnails when visible (same observer as grid cards)
    const videoEl = item.querySelector(".card-video");
    if (videoEl) { sharedVideoObserver.observe(videoEl); bindVideoLoader(videoEl); }

    // Click → open tweet or lightbox
    item.addEventListener("click", (e) => {
      if (selectState.isSelectMode && hasMedia) {
        e.stopPropagation();
        toggleCardSelected(bm.id, item);
        return;
      }
      if (selectState.isSelectMode) return;
      if (hasMedia) openLightbox(item, bm);
      else window.open(bm.url, "_blank");
    });

    // Checkbox for multi-select
    if (hasMedia) {
      const checkbox = document.createElement("div");
      checkbox.className = "card-checkbox";
      item.appendChild(checkbox);
      if (selectState.selectedIds.has(bm.id)) item.classList.add("selected");
    }

    dom.grid.appendChild(item);
  }
};

// --- Shared card setup (actions, video observer, click, checkbox) ---
const setupCardInteractions = (item, bm, hasMedia, sharedVideoObserver) => {
  if (!hasMedia) {
    const ogWrap = item.querySelector(".og-wrap");
    if (ogWrap) loadOgCard(bm, ogWrap);

    // Share button for text-only cards (media cards get it via addCardActions)
    const actions = document.createElement("div");
    actions.className = "card-actions card-actions--text-only";
    actions.appendChild(buildShareButton(bm));
    item.appendChild(actions);
  } else {
    const fields = state.viewFields[state.activeView];
    if (fields.media) {
      const mediaWrap = item.querySelector(".card-media-wrap");
      if (mediaWrap) addCardActions(mediaWrap, bm.images, bm);

      const videoEl = item.querySelector(".card-video");
      if (videoEl) { sharedVideoObserver.observe(videoEl); bindVideoLoader(videoEl); }
    }
  }

  // Checkbox for multi-select (media-only)
  if (hasMedia) {
    const checkbox = document.createElement("div");
    checkbox.className = "card-checkbox";
    item.appendChild(checkbox);
    if (selectState.selectedIds.has(bm.id)) item.classList.add("selected");
  }

  item.addEventListener("click", (e) => {
    if (selectState.isSelectMode && hasMedia) {
      e.stopPropagation();
      toggleCardSelected(bm.id, item);
      return;
    }
    if (selectState.isSelectMode) return;
    if (hasMedia) openLightbox(item, bm);
    else window.open(bm.url, "_blank");
  });
};

export const renderGrid = () => {
  dom.grid.innerHTML = "";
  // Reset grid classes
  dom.grid.className = "";
  dom.grid.id = "grid";
  dom.grid.style.removeProperty("--card-cols");

  const sharedVideoObserver = getVideoObserver();

  if (state.activeView === "list") {
    renderList(sharedVideoObserver);
  } else if (state.activeView === "card") {
    renderCardGrid(sharedVideoObserver);
  } else {
    // masonry (default)
    renderMasonry(sharedVideoObserver);
  }

  dom.viewport.scrollTop = 0;
};

export const rebuildGrid = (withAnimation = true) => {
  if (withAnimation) {
    if (state.isTransitioning) return;
    state.isTransitioning = true;
    dom.grid.style.transition = "opacity 0.2s ease";
    dom.grid.style.opacity = "0";
    setTimeout(() => {
      applyFilters();
      renderGrid();
      void dom.grid.offsetHeight;
      dom.grid.style.transition = "opacity 0.3s ease";
      dom.grid.style.opacity = "1";
      setTimeout(() => {
        dom.grid.style.transition = "";
        state.isTransitioning = false;
      }, 300);
    }, 200);
  } else {
    applyFilters();
    renderGrid();
  }
};
