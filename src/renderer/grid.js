// --- Grid rendering: masonry, card, and list views ---

import { state, CONFIG, dom } from './state.js';
import { buildCardHtml, buildListItemHtml, addCardActions, buildShareButton, buildRemoveBookmarkButton } from './card.js';
import { loadOgCard, mediaHeight } from './media.js';
import { selectState, toggleCardSelected } from './select.js';
import { openLightbox } from './lightbox.js';
import { primaryLinkFor } from './helpers.js';
import { setGridEl, enqueueVideo } from './video-queue.js';

// Wire the link-preview thumbnail so clicking it opens the lightbox instead
// of navigating away. The lightbox already shows the link card with a
// clickable URL, so the user can still reach the external site from there.
const wireOgClick = (item, bm) => {
  const og = item.querySelector(".og-wrap");
  if (!og) return;
  og.style.cursor = "pointer";
};

// Single shared IntersectionObserver for all video autoplay — much cheaper than one per card
let videoObserver = null;

const monthShortFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });
const monthLongFormatter = new Intl.DateTimeFormat("en-US", { month: "long" });

const dateRail = {
  initialized: false,
  root: null,
  thumb: null,
  popover: null,
  hoverPreview: null,
  dots: null,
  months: [],
  activeIndex: 0,
  isDragging: false,
  refreshRaf: 0,
  syncRaf: 0,
  hideTimer: null,
  scrollRaf: 0,
  programmaticUntil: 0,
  resizeObserver: null,
  observedGrid: null,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getBookmarkDateInfo = (postedAt) => {
  if (!postedAt) return null;
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return null;

  const month = monthShortFormatter.format(date).toUpperCase();
  const longMonth = monthLongFormatter.format(date);
  const year = String(date.getFullYear());
  return {
    key: `${year}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    month,
    longMonth,
    year,
    label: `${longMonth} ${year}`,
  };
};

const applyDateInfo = (item, bm) => {
  const info = getBookmarkDateInfo(bm.postedAt);
  if (!info) return;
  item.dataset.dateKey = info.key;
  item.dataset.dateMonth = info.month;
  item.dataset.dateLongMonth = info.longMonth;
  item.dataset.dateYear = info.year;
  item.dataset.dateLabel = info.label;
};

const makeDateAnchor = (bm) => {
  const anchor = document.createElement("div");
  anchor.className = "date-scroll-anchor";
  applyDateInfo(anchor, bm);
  return anchor;
};

const groupBookmarksByMonth = (bookmarks) => {
  const groups = [];
  for (const bm of bookmarks) {
    const info = getBookmarkDateInfo(bm.postedAt);
    const key = info?.key || "unknown";
    const previous = groups[groups.length - 1];
    if (previous?.key === key) {
      previous.items.push(bm);
      continue;
    }
    groups.push({
      key,
      label: info?.label || "Unknown date",
      first: bm,
      items: [bm],
    });
  }
  return groups;
};

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
        if (!v.src && v.dataset.src) {
          enqueueVideo(v);
        } else if (v.src) {
          v.play().catch(() => {});
        }
      } else {
        v.pause();
      }
    }
  }, { threshold: 0.2 });
  return videoObserver;
};

const viewportTopPadding = () => {
  const padding = Number.parseFloat(getComputedStyle(dom.viewport).paddingTop);
  return Number.isFinite(padding) ? padding : 0;
};

const maxViewportScrollTop = () => (
  dom.viewport ? Math.max(0, dom.viewport.scrollHeight - dom.viewport.clientHeight) : 0
);

const itemScrollTarget = (item) => {
  if (!dom.viewport || !item) return 0;
  const viewportRect = dom.viewport.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const target = dom.viewport.scrollTop + itemRect.top - viewportRect.top - viewportTopPadding() - 8;
  return clamp(target, 0, maxViewportScrollTop());
};

const ensureDateRail = () => {
  if (dateRail.initialized) return Boolean(dateRail.root);

  dateRail.root = document.getElementById("date-scrollbar");
  if (!dateRail.root || !dom.viewport) return false;

  dateRail.thumb = document.getElementById("date-scrollbar-thumb");
  dateRail.popover = document.getElementById("date-scrollbar-popover");
  dateRail.hoverPreview = document.getElementById("date-scrollbar-hover");
  dateRail.dots = document.getElementById("date-scrollbar-dots");
  if (!dateRail.thumb || !dateRail.popover) return false;

  dateRail.initialized = true;

  const pickFromPointer = (clientY, source) => {
    const month = monthFromClientY(clientY);
    if (!month) return;
    updateActiveDate(month.index);
    showDatePopover(month, clientY);
    hideHoverPreview();
    scrollToMonth(month, source === "drag" ? 180 : 320);
  };

  dateRail.root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dateRail.isDragging = true;
    dateRail.root.classList.add("is-dragging");
    dateRail.root.setPointerCapture?.(e.pointerId);
    pickFromPointer(e.clientY, "click");
  });

  dateRail.root.addEventListener("pointermove", (e) => {
    if (dateRail.isDragging) {
      e.preventDefault();
      e.stopPropagation();
      pickFromPointer(e.clientY, "drag");
      return;
    }

    showHoverPreview(e.clientY);
  });

  const endDrag = (e) => {
    if (!dateRail.isDragging) return;
    dateRail.isDragging = false;
    dateRail.root.classList.remove("is-dragging");
    dateRail.root.releasePointerCapture?.(e.pointerId);
    schedulePopoverHide();
  };
  dateRail.root.addEventListener("pointerup", endDrag);
  dateRail.root.addEventListener("pointercancel", endDrag);

  dateRail.root.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
    if (!dateRail.months.length) return;
    e.preventDefault();

    const pageStep = Math.max(1, Math.round(dateRail.months.length / 6));
    let nextIndex = dateRail.activeIndex;
    if (e.key === "ArrowUp") nextIndex -= 1;
    if (e.key === "ArrowDown") nextIndex += 1;
    if (e.key === "PageUp") nextIndex -= pageStep;
    if (e.key === "PageDown") nextIndex += pageStep;
    if (e.key === "Home") nextIndex = 0;
    if (e.key === "End") nextIndex = dateRail.months.length - 1;

    const month = dateRail.months[clamp(nextIndex, 0, dateRail.months.length - 1)];
    updateActiveDate(month.index);
    showDatePopover(month);
    scrollToMonth(month, 260);
    schedulePopoverHide();
  });

  dateRail.root.addEventListener("mouseenter", () => dateRail.root.classList.add("is-hovered"));
  dateRail.root.addEventListener("mouseleave", () => {
    dateRail.root.classList.remove("is-hovered");
    hideHoverPreview();
    if (!dateRail.isDragging) schedulePopoverHide(350);
  });

  dom.viewport.addEventListener("scroll", scheduleDateRailSync, { passive: true });
  window.addEventListener("resize", scheduleDateRailRefresh);

  if ("ResizeObserver" in window) {
    dateRail.resizeObserver = new ResizeObserver(scheduleDateRailRefresh);
  }

  return true;
};

const observeGridForDateRail = () => {
  if (!dateRail.resizeObserver || dateRail.observedGrid === dom.grid) return;
  if (dateRail.observedGrid) dateRail.resizeObserver.unobserve(dateRail.observedGrid);
  dateRail.resizeObserver.observe(dom.grid);
  dateRail.observedGrid = dom.grid;
};

const scheduleDateRailRefresh = () => {
  if (!ensureDateRail()) return;
  if (dateRail.refreshRaf) cancelAnimationFrame(dateRail.refreshRaf);
  dateRail.refreshRaf = requestAnimationFrame(() => {
    dateRail.refreshRaf = 0;
    refreshDateRail();
  });
};

const refreshDateRail = () => {
  if (!ensureDateRail()) return;
  observeGridForDateRail();

  const grouped = new Map();
  const anchors = Array.from(dom.grid.querySelectorAll(".date-scroll-anchor[data-date-key]"));
  const items = anchors.length
    ? anchors
    : Array.from(dom.grid.querySelectorAll("[data-date-key]"));

  for (const item of items) {
    const key = item.dataset.dateKey;
    if (!key) continue;
    const top = itemScrollTarget(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        month: item.dataset.dateMonth || "",
        longMonth: item.dataset.dateLongMonth || item.dataset.dateMonth || "",
        year: item.dataset.dateYear || "",
        label: item.dataset.dateLabel || "",
        top,
        element: item,
        count: 1,
      });
    } else {
      existing.count += 1;
      if (top < existing.top) {
        existing.top = top;
        existing.element = item;
      }
    }
  }

  dateRail.months = Array.from(grouped.values())
    .sort((a, b) => a.top - b.top)
    .map((month, index) => ({ ...month, index }));

  if (!dateRail.months.length) {
    dateRail.root.hidden = true;
    dateRail.root.setAttribute("aria-hidden", "true");
    renderDateDots();
    hideHoverPreview();
    return;
  }

  dateRail.root.hidden = false;
  dateRail.root.setAttribute("aria-hidden", "false");
  dateRail.root.setAttribute("aria-valuemax", String(dateRail.months.length));
  renderDateDots();
  syncActiveDateFromScroll(true);
};

const renderDateDots = () => {
  if (!dateRail.dots) return;
  dateRail.dots.replaceChildren();
  if (dateRail.months.length < 2) return;

  for (const month of dateRail.months) {
    const dot = document.createElement("span");
    dot.className = "date-scrollbar-dot";
    dot.title = month.label;
    const progress = month.index / (dateRail.months.length - 1);
    dot.style.setProperty("--date-dot-progress", String(progress));
    dateRail.dots.appendChild(dot);
  }
};

const scheduleDateRailSync = () => {
  if (!dateRail.months.length) return;
  if (dateRail.syncRaf) return;
  dateRail.syncRaf = requestAnimationFrame(() => {
    dateRail.syncRaf = 0;
    syncActiveDateFromScroll();
  });
};

const syncActiveDateFromScroll = (force = false) => {
  if (!dateRail.months.length || !dom.viewport) return;
  if (!force && (dateRail.isDragging || performance.now() < dateRail.programmaticUntil)) return;

  const referenceTop = dom.viewport.scrollTop + 24;
  let activeIndex = 0;
  for (let i = 0; i < dateRail.months.length; i += 1) {
    if (dateRail.months[i].top <= referenceTop) activeIndex = i;
    else break;
  }
  updateActiveDate(activeIndex);
};

const updateActiveDate = (index) => {
  if (!dateRail.months.length || !dateRail.thumb) return;
  dateRail.activeIndex = clamp(index, 0, dateRail.months.length - 1);
  const month = dateRail.months[dateRail.activeIndex];

  const monthEl = dateRail.thumb.querySelector(".date-scrollbar-month");
  const yearEl = dateRail.thumb.querySelector(".date-scrollbar-year");
  if (monthEl) monthEl.textContent = month.month;
  if (yearEl) yearEl.textContent = month.year;

  const rootRect = dateRail.root.getBoundingClientRect();
  const thumbRect = dateRail.thumb.getBoundingClientRect();
  const travel = Math.max(0, rootRect.height - thumbRect.height);
  const progress = dateRail.months.length > 1
    ? dateRail.activeIndex / (dateRail.months.length - 1)
    : 0.5;
  dateRail.thumb.style.setProperty("--date-thumb-y", `${Math.round(travel * progress)}px`);

  dateRail.root.setAttribute("aria-valuenow", String(dateRail.activeIndex + 1));
  dateRail.root.setAttribute("aria-valuetext", month.label);
  dateRail.root.title = month.label;

  if (dateRail.dots) {
    dateRail.dots.querySelectorAll(".date-scrollbar-dot").forEach((dot, dotIndex) => {
      dot.classList.toggle("active", dotIndex === dateRail.activeIndex);
    });
  }
};

const updateHoveredDate = (index) => {
  if (!dateRail.dots) return;
  dateRail.dots.querySelectorAll(".date-scrollbar-dot").forEach((dot, dotIndex) => {
    dot.classList.toggle("hovered", dotIndex === index && dotIndex !== dateRail.activeIndex);
  });
};

const monthFromClientY = (clientY) => {
  if (!dateRail.months.length || !dateRail.root) return null;
  const rect = dateRail.root.getBoundingClientRect();
  const y = clamp(clientY - rect.top, 0, Math.max(1, rect.height));
  const progress = y / Math.max(1, rect.height);
  const index = Math.round(progress * (dateRail.months.length - 1));
  return dateRail.months[clamp(index, 0, dateRail.months.length - 1)];
};

const showDatePopover = (month, clientY = null) => {
  if (!dateRail.popover || !dateRail.root) return;
  if (dateRail.hideTimer) {
    clearTimeout(dateRail.hideTimer);
    dateRail.hideTimer = null;
  }

  dateRail.popover.replaceChildren();
  const monthEl = document.createElement("span");
  monthEl.className = "date-scrollbar-popover-month";
  monthEl.textContent = month.longMonth;
  const yearEl = document.createElement("strong");
  yearEl.textContent = month.year;
  dateRail.popover.append(monthEl, yearEl);

  const rect = dateRail.root.getBoundingClientRect();
  const fallbackY = rect.top + rect.height * (
    dateRail.months.length > 1 ? month.index / (dateRail.months.length - 1) : 0.5
  );
  const y = clamp(clientY ?? fallbackY, rect.top + 22, rect.bottom - 22);
  dateRail.popover.style.setProperty("--date-popover-y", `${Math.round(y)}px`);
  dateRail.popover.classList.add("visible");
  dateRail.popover.setAttribute("aria-hidden", "false");
  dateRail.root.classList.add("is-active");
};

const showHoverPreview = (clientY) => {
  if (dateRail.isDragging || !dateRail.hoverPreview) return;
  const month = monthFromClientY(clientY);
  if (!month) return;

  const rect = dateRail.root.getBoundingClientRect();
  const y = clamp(clientY, rect.top + 18, rect.bottom - 18);
  dateRail.hoverPreview.textContent = month.label;
  dateRail.hoverPreview.style.setProperty("--date-hover-y", `${Math.round(y)}px`);
  dateRail.hoverPreview.classList.toggle("is-current", month.index === dateRail.activeIndex);
  dateRail.hoverPreview.classList.add("visible");
  dateRail.hoverPreview.setAttribute("aria-hidden", "false");
  updateHoveredDate(month.index);
};

const hideHoverPreview = () => {
  if (dateRail.hoverPreview) {
    dateRail.hoverPreview.classList.remove("visible", "is-current");
    dateRail.hoverPreview.setAttribute("aria-hidden", "true");
  }
  updateHoveredDate(-1);
};

const schedulePopoverHide = (delay = 700) => {
  if (!dateRail.popover) return;
  if (dateRail.hideTimer) clearTimeout(dateRail.hideTimer);
  dateRail.hideTimer = setTimeout(() => {
    dateRail.popover.classList.remove("visible");
    dateRail.popover.setAttribute("aria-hidden", "true");
    dateRail.root?.classList.remove("is-active");
    dateRail.hideTimer = null;
  }, delay);
};

const scrollToMonth = (month, duration) => {
  if (!dom.viewport || !month?.element) return;
  const target = itemScrollTarget(month.element);

  if (dateRail.scrollRaf) {
    cancelAnimationFrame(dateRail.scrollRaf);
    dateRail.scrollRaf = 0;
  }

  const start = dom.viewport.scrollTop;
  const distance = target - start;
  if (Math.abs(distance) < 1) return;

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReducedMotion || duration <= 0) {
    dom.viewport.scrollTop = target;
    syncActiveDateFromScroll(true);
    return;
  }

  const startedAt = performance.now();
  dateRail.programmaticUntil = startedAt + duration + 80;

  const step = (now) => {
    const progress = clamp((now - startedAt) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    dom.viewport.scrollTop = start + distance * eased;

    if (progress < 1) {
      dateRail.scrollRaf = requestAnimationFrame(step);
      return;
    }

    dateRail.scrollRaf = 0;
    dateRail.programmaticUntil = 0;
    syncActiveDateFromScroll(true);
  };

  dateRail.scrollRaf = requestAnimationFrame(step);
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
const masonryColumnWidth = (colCount, gap) => {
  const gridStyle = getComputedStyle(dom.grid);
  const paddingX = Number.parseFloat(gridStyle.paddingLeft) + Number.parseFloat(gridStyle.paddingRight);
  const gridWidth = dom.grid.clientWidth || window.innerWidth;
  const innerWidth = Math.max(0, gridWidth - (Number.isFinite(paddingX) ? paddingX : 0));
  return (innerWidth - gap * (colCount - 1)) / colCount;
};

const renderMasonryItems = (bookmarks, target, sharedVideoObserver) => {
  const colCount = CONFIG.COLS;
  const gap = CONFIG.GAP;
  const colWidth = masonryColumnWidth(colCount, gap);

  const colHeights = new Array(colCount).fill(0);
  const colEls = Array.from({ length: colCount }, () => {
    const col = document.createElement("div");
    col.className = "masonry-col";
    target.appendChild(col);
    return col;
  });

  for (const bm of bookmarks) {
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
    applyDateInfo(item, bm);
    item.innerHTML = buildCardHtml(bm);

    setupCardInteractions(item, bm, hasMedia, sharedVideoObserver);
    colEls[minCol].appendChild(item);
  }
};

const renderMasonry = (sharedVideoObserver) => {
  dom.grid.className = "grid-masonry-date";

  for (const group of groupBookmarksByMonth(state.filteredBookmarks)) {
    const section = document.createElement("section");
    section.className = "date-section";
    section.setAttribute("aria-label", group.label);
    section.appendChild(makeDateAnchor(group.first));

    const sectionGrid = document.createElement("div");
    sectionGrid.className = "date-section-grid";
    section.appendChild(sectionGrid);

    renderMasonryItems(group.items, sectionGrid, sharedVideoObserver);
    dom.grid.appendChild(section);
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
    applyDateInfo(item, bm);
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
    applyDateInfo(item, bm);
    item.innerHTML = buildListItemHtml(bm);

    // Autoplay video thumbnails when visible (same observer as grid cards)
    const videoEl = item.querySelector(".card-video");
    if (videoEl) { sharedVideoObserver.observe(videoEl); bindVideoLoader(videoEl); }

    // Click → open lightbox (text-only bookmarks also open here; link thumbnail
    // intercepts its own click below to go to the external URL instead).
    item.addEventListener("click", (e) => {
      if (selectState.isSelectMode && hasMedia) {
        e.stopPropagation();
        toggleCardSelected(bm.id, item);
        return;
      }
      if (selectState.isSelectMode) return;
      openLightbox(item, bm);
    });
    if (!hasMedia) wireOgClick(item, bm);

    // Checkbox for multi-select
    if (hasMedia) {
      const checkbox = document.createElement("div");
      checkbox.className = "card-checkbox";
      item.appendChild(checkbox);
      if (selectState.selectedIds.has(bm.id)) item.classList.add("selected");
    }

    const actions = document.createElement("div");
    actions.className = "card-actions card-actions--list";
    actions.appendChild(buildShareButton(bm));
    actions.appendChild(buildRemoveBookmarkButton(bm));
    item.appendChild(actions);

    dom.grid.appendChild(item);
  }
};

// --- Shared card setup (actions, video observer, click, checkbox) ---
const setupCardInteractions = (item, bm, hasMedia, sharedVideoObserver) => {
  if (!hasMedia) {
    const ogWrap = item.querySelector(".og-wrap");
    // Only kick the async OG scrape when we don't already have an X card inlined
    if (ogWrap && ogWrap.dataset.needsOg === "1") loadOgCard(bm, ogWrap);
    wireOgClick(item, bm);

    // Share button for text-only cards (media cards get it via addCardActions)
    const actions = document.createElement("div");
    actions.className = "card-actions card-actions--text-only";
    actions.appendChild(buildShareButton(bm));
    actions.appendChild(buildRemoveBookmarkButton(bm));
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
    openLightbox(item, bm);
  });
};

export const renderGrid = () => {
  dom.grid.innerHTML = "";
  dom.grid.className = "";
  dom.grid.id = "grid";
  dom.grid.style.removeProperty("--card-cols");
  setGridEl(dom.grid);

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
  scheduleDateRailRefresh();
};

let fadeOutTimer = null;
let fadeInTimer = null;

export const rebuildGrid = (withAnimation = true) => {
  if (fadeOutTimer) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
  if (fadeInTimer) { clearTimeout(fadeInTimer); fadeInTimer = null; }

  if (!withAnimation) {
    applyFilters();
    renderGrid();
    dom.grid.style.transition = "";
    dom.grid.style.opacity = "1";
    state.isTransitioning = false;
    return;
  }

  state.isTransitioning = true;
  dom.grid.style.transition = "opacity 0.2s ease";
  dom.grid.style.opacity = "0";
  fadeOutTimer = setTimeout(() => {
    fadeOutTimer = null;
    applyFilters();
    renderGrid();
    void dom.grid.offsetHeight;
    dom.grid.style.transition = "opacity 0.3s ease";
    dom.grid.style.opacity = "1";
    fadeInTimer = setTimeout(() => {
      fadeInTimer = null;
      dom.grid.style.transition = "";
      state.isTransitioning = false;
    }, 300);
  }, 200);
};
