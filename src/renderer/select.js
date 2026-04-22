// --- Multi-select mode ---

import { state, dom } from './state.js';
import { bookmarksToZip, triggerAnchorDownload } from './media.js';

export const selectState = {
  isSelectMode: false,
  selectedIds: new Set(),
};

const getSelectBar = () => document.getElementById("select-bar");
const getSelectToggle = () => document.getElementById("select-toggle");

export const updateSelectUI = () => {
  const bar = getSelectBar();
  if (!bar) return;

  const count = selectState.selectedIds.size;
  const countLabel = bar.querySelector("#select-count-label");
  const dlBtn = bar.querySelector("#select-dl-btn");

  if (countLabel) countLabel.textContent = `${count} selected`;
  if (dlBtn) dlBtn.disabled = count === 0;
};

export const toggleCardSelected = (id, itemEl) => {
  if (selectState.selectedIds.has(id)) {
    selectState.selectedIds.delete(id);
    itemEl.classList.remove("selected");
  } else {
    selectState.selectedIds.add(id);
    itemEl.classList.add("selected");
  }
  updateSelectUI();
};

export const enterSelectMode = () => {
  selectState.isSelectMode = true;
  selectState.selectedIds.clear();
  dom.grid.classList.add("select-mode");
  getSelectToggle()?.classList.add("active");
  getSelectBar()?.classList.add("visible");
  updateSelectUI();
};

export const exitSelectMode = () => {
  selectState.isSelectMode = false;
  selectState.selectedIds.clear();
  dom.grid.classList.remove("select-mode");
  document.querySelectorAll(".grid-item.selected").forEach(el => el.classList.remove("selected"));
  getSelectToggle()?.classList.remove("active");
  getSelectBar()?.classList.remove("visible");
};

export const downloadSelected = async () => {
  const btn = document.getElementById("select-dl-btn");
  const progress = document.getElementById("select-progress");
  // Use allBookmarks so selection survives filter tab changes
  const toDownload = state.allBookmarks.filter(bm => selectState.selectedIds.has(bm.id) && bm.images?.length);
  if (toDownload.length === 0) return;

  if (btn) btn.disabled = true;
  if (progress) { progress.style.display = ""; progress.textContent = ""; }

  try {
    const { zipBlob, totalFiles } = await bookmarksToZip(toDownload, (ev) => {
      if (ev.phase === "fetching") {
        progress.textContent = `Downloading ${ev.index + 1} / ${ev.total} — @${ev.bookmark.authorHandle}`;
      } else if (ev.phase === "zipping") {
        progress.textContent = `Zipping ${ev.totalFiles} files…`;
      }
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    triggerAnchorDownload(URL.createObjectURL(zipBlob), `bookmarks-${dateStr}.zip`);

    if (progress) progress.textContent = `✓ ${totalFiles} files downloaded`;
    setTimeout(() => exitSelectMode(), 1500);
  } catch (err) {
    console.error("Bulk download error:", err);
    if (progress) progress.textContent = `Error: ${err.message}`;
    if (btn) btn.disabled = selectState.selectedIds.size === 0;
  }
};
