// Shared application state — all modules import from here

const PERSIST_KEY = "tbg_view_state_v1";

const DEFAULT_VIEW_FIELDS = {
  masonry: { media: true, author: true, text: true, stats: false, date: false },
  card:    { media: true, author: true, text: true, stats: true, date: true },
  list:    { media: true, author: true, text: true, stats: true, date: true },
};

const loadPersisted = () => {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
};

const persisted = loadPersisted() || {};
const validViews = new Set(["masonry", "card", "list"]);
const validSorts = new Set(["newest", "oldest", "likes", "bookmarks", "reposts"]);
const validMediaTypes = new Set(["all", "photo", "video", "gif"]);
const validThemes = new Set(["dark", "light"]);

const mergedViewFields = {
  masonry: { ...DEFAULT_VIEW_FIELDS.masonry, ...(persisted.viewFields?.masonry || {}) },
  card:    { ...DEFAULT_VIEW_FIELDS.card,    ...(persisted.viewFields?.card || {}) },
  list:    { ...DEFAULT_VIEW_FIELDS.list,    ...(persisted.viewFields?.list || {}) },
};

export const state = {
  allBookmarks: [],
  folders: [],
  filteredBookmarks: [],
  activeFolder: typeof persisted.activeFolder === "string" ? persisted.activeFolder : "All",
  activeSort: validSorts.has(persisted.activeSort) ? persisted.activeSort : "newest",
  activeMediaType: validMediaTypes.has(persisted.activeMediaType) ? persisted.activeMediaType : "all",
  activeView: validViews.has(persisted.activeView) ? persisted.activeView : "masonry",
  activeTheme: validThemes.has(persisted.activeTheme) ? persisted.activeTheme : "dark",
  activeSearch: "",
  searchDebounceTimer: null,
  isTransitioning: false,
  viewFields: mergedViewFields,
};

const persistedCols = Number(persisted.cols);
export const CONFIG = {
  COLS: Number.isFinite(persistedCols) && persistedCols >= 2 && persistedCols <= 8 ? persistedCols : 3,
  GAP: 18,
};

export const saveViewState = () => {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      activeView: state.activeView,
      activeSort: state.activeSort,
      activeMediaType: state.activeMediaType,
      activeFolder: state.activeFolder,
      activeTheme: state.activeTheme,
      viewFields: state.viewFields,
      cols: CONFIG.COLS,
    }));
  } catch {}
};

export const applyTheme = (theme) => {
  if (!validThemes.has(theme)) return;
  state.activeTheme = theme;
  document.documentElement.dataset.theme = theme;
  saveViewState();
};

// DOM element references — call initDOM() after DOMContentLoaded
export const dom = {
  viewport: null,
  grid: null,
  overlay: null,
  lightboxClose: null,
  lightboxTitle: null,
  lightboxLink: null,
};

export function initDOM() {
  dom.viewport = document.getElementById("viewport");
  dom.grid = document.getElementById("grid");
  dom.overlay = document.getElementById("lightbox-overlay");
  dom.lightboxClose = document.getElementById("lightbox-close");
  dom.lightboxTitle = document.getElementById("lightbox-title");
  dom.lightboxLink = document.getElementById("lightbox-link");
}
