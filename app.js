// --- App entry point ---
// All logic is split into modules under src/renderer/

import { state, dom, initDOM } from './src/renderer/state.js';
import { applyFilters, renderGrid } from './src/renderer/grid.js';
import {
  createAppLogo,
  createSearchBar,
  createMediaTypeFilter,
  createBottomControls,
  createControlsRight,
  createViewMenu,
  createSortPill,
  createExportMenu,
  createFolderPill,
  createUserPill,
  createThemeToggle,
} from './src/renderer/controls.js';
import { closeLightbox, lbState, lbCarouselGoTo } from './src/renderer/lightbox.js';
import { startSync } from './src/renderer/sync.js';

// Apply persisted theme before first paint to avoid a flash of the wrong theme
document.documentElement.dataset.theme = state.activeTheme;

const init = async () => {
  initDOM();

  try {
    const res = await fetch("./bookmarks-data.json");
    const data = await res.json();
    if (Array.isArray(data)) {
      state.allBookmarks = data;
      state.folders = [];
    } else {
      state.allBookmarks = data.bookmarks || [];
      state.folders = data.folders || [];
    }
    // Reset persisted folder selection if it no longer exists (after a sync)
    const validFolders = new Set(["All", ...state.folders.map((f) => f.name)]);
    if (!validFolders.has(state.activeFolder)) state.activeFolder = "All";
    applyFilters();
    console.log(`Loaded ${state.filteredBookmarks.length} bookmarks, ${state.folders.length} folders`);
  } catch (e) {
    console.error("Failed to load bookmarks data:", e);
    return;
  }

  // Build the chrome (topbar, logo, search, controls) BEFORE rendering the
  // grid. For large libraries renderGrid synchronously creates hundreds of
  // DOM nodes and blocks paint, so doing it first hides the header for
  // seconds. Controls are cheap — paint them first, then yield so the
  // browser can show them before we start the heavier grid work.

  const topbar = document.createElement("div");
  topbar.id = "topbar";
  document.body.appendChild(topbar);

  createAppLogo();
  createSearchBar();
  createMediaTypeFilter();
  createBottomControls();
  const controlsRight = createControlsRight();
  createViewMenu(controlsRight);
  createSortPill(controlsRight);
  if (state.folders.length > 0) createFolderPill(controlsRight);
  createExportMenu(controlsRight);
  createThemeToggle(controlsRight);
  const userPillReady = window.electronAPI?.isElectron
    ? createUserPill(controlsRight)
    : null;

  // Let the browser paint the chrome before we block the main thread with
  // renderGrid.
  await new Promise((r) => requestAnimationFrame(r));

  renderGrid();

  // First-launch auto sync: wait for userInfo so the 24h cooldown (reflected
  // in the sync button's disabled state) is respected.
  if (window.electronAPI?.isElectron && state.allBookmarks.length === 0) {
    await userPillReady;
    const syncBtn = document.getElementById("sync-btn");
    if (syncBtn && !syncBtn.disabled) startSync(syncBtn);
  }

  // Pre-warm Motion
  const warmup = document.createElement("div");
  warmup.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;";
  document.body.appendChild(warmup);
  Motion.animate(warmup, { opacity: [0, 1] }, { duration: 0.01 }).then(() => warmup.remove());

  // Scroll-to-top button (list view only)
  const scrollTopBtn = document.createElement("button");
  scrollTopBtn.id = "scroll-top-btn";
  scrollTopBtn.className = "scroll-top-btn";
  scrollTopBtn.setAttribute("aria-label", "Scroll to top");
  scrollTopBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  scrollTopBtn.addEventListener("click", () => {
    dom.viewport.scrollTo({ top: 0, behavior: "smooth" });
  });
  document.body.appendChild(scrollTopBtn);

  const updateScrollTopBtn = () => {
    scrollTopBtn.classList.toggle("visible", dom.viewport.scrollTop > 400);
  };
  dom.viewport.addEventListener("scroll", updateScrollTopBtn, { passive: true });

  window.addEventListener("resize", () => renderGrid());

  dom.lightboxClose.addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
  dom.overlay.addEventListener("click", (e) => { if (e.target === dom.overlay) closeLightbox(); });
  window.addEventListener("keydown", (e) => {
    if (!lbState.lightboxOpen) return;
    if (e.key === "Escape") { closeLightbox(); return; }
    const imgs = lbState.lightboxItem?.bookmark?.images;
    if (!imgs || imgs.length < 2) return;
    if (e.key === "ArrowLeft") lbCarouselGoTo(imgs, lbState.carouselIdx - 1);
    if (e.key === "ArrowRight") lbCarouselGoTo(imgs, lbState.carouselIdx + 1);
  });
};

init();
