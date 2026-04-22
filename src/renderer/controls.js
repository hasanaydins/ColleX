// --- UI Controls: search, media filter, view menu, sort, folder, bottom bar, user pill ---

import { state, CONFIG, saveViewState, applyTheme } from './state.js';
import { escapeHtml, stopControlEvents } from './helpers.js';
import { rebuildGrid } from './grid.js';
import { selectState, enterSelectMode, exitSelectMode, downloadSelected } from './select.js';
import { startSync } from './sync.js';

const SORT_LABELS = {
  newest: "Newest",
  oldest: "Oldest",
  likes: "Most Liked",
  bookmarks: "Most Bookmarked",
  reposts: "Most Reposted",
};

// Close every open dropdown except the one passed in. All dropdowns share
// the `.folder-dropdown` class, so a single selector catches them regardless
// of their individual IDs.
const closeOtherDropdowns = (keepOpen = null) => {
  document.querySelectorAll(".folder-dropdown.open").forEach((d) => {
    if (d !== keepOpen) d.classList.remove("open");
  });
};

export const createControlsRight = () => {
  const bar = document.createElement("div");
  bar.id = "controls-right";
  bar.className = "controls-right";
  stopControlEvents(bar);
  document.body.appendChild(bar);
  return bar;
};

export const createAppLogo = () => {
  const logo = document.createElement("div");
  logo.id = "app-logo";
  logo.className = "app-logo";
  logo.innerHTML = `<img src="assets/AppLogo.svg" alt="ColleX" draggable="false">`;
  document.body.appendChild(logo);
};

export const createSearchBar = () => {
  const bar = document.createElement("div");
  bar.id = "search-bar";
  bar.className = "search-bar";
  bar.innerHTML = `
    <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
    <input id="search-input" type="text" placeholder="Search by text or author…" autocomplete="off" spellcheck="false">
    <button id="search-clear" class="search-clear" aria-label="Clear search">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;
  stopControlEvents(bar);
  document.body.appendChild(bar);

  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");

  input.addEventListener("input", () => {
    state.activeSearch = input.value;
    clearBtn.style.opacity = state.activeSearch ? "1" : "0";
    clearBtn.style.pointerEvents = state.activeSearch ? "auto" : "none";
    clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = setTimeout(() => rebuildGrid(false), 250);
  });

  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    input.value = "";
    state.activeSearch = "";
    clearBtn.style.opacity = "0";
    clearBtn.style.pointerEvents = "none";
    rebuildGrid(false);
  });
};

export const createMediaTypeFilter = () => {
  const wrap = document.createElement("div");
  wrap.id = "media-filter";
  wrap.className = "media-filter";
  stopControlEvents(wrap);

  const types = [
    { value: "all", label: "All" },
    { value: "photo", label: "Photos" },
    { value: "video", label: "Videos" },
    { value: "gif", label: "GIFs" },
  ];

  for (const t of types) {
    const btn = document.createElement("button");
    btn.className =
      "media-filter-btn" + (t.value === state.activeMediaType ? " active" : "");
    btn.dataset.type = t.value;
    btn.textContent = t.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (t.value === state.activeMediaType) return;
      state.activeMediaType = t.value;
      wrap.querySelectorAll(".media-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      saveViewState();
      rebuildGrid();
    });
    wrap.appendChild(btn);
  }

  document.body.appendChild(wrap);
};

export const createBottomControls = () => {
  const wrap = document.createElement("div");
  wrap.className = "bottom-controls";

  const badge = document.createElement("div");
  badge.id = "results-count";
  badge.className = "results-count";
  badge.textContent = state.filteredBookmarks.length;

  const selectToggle = document.createElement("button");
  selectToggle.id = "select-toggle";
  selectToggle.className = "select-toggle";
  selectToggle.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>Multiple Select</span>`;
  selectToggle.addEventListener("click", () => {
    if (selectState.isSelectMode) exitSelectMode();
    else enterSelectMode();
  });

  wrap.appendChild(badge);
  wrap.appendChild(selectToggle);

  // Sync button — only shown when running inside Electron
  if (window.electronAPI?.isElectron) {
    const syncBtn = document.createElement("button");
    syncBtn.id = "sync-btn";
    syncBtn.className = "select-toggle sync-btn";
    syncBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Sync</span>`;
    syncBtn.addEventListener("click", () => startSync(syncBtn));
    wrap.appendChild(syncBtn);
  }

  document.body.appendChild(wrap);

  // Select action bar
  const bar = document.createElement("div");
  bar.id = "select-bar";
  bar.className = "select-bar";
  bar.innerHTML = `
    <span id="select-count-label" class="select-count-label">0 selected</span>
    <button id="select-dl-btn" class="select-bar-btn select-bar-dl" disabled>Download</button>
    <span id="select-progress" class="select-progress" style="display:none"></span>
    <button class="select-bar-btn select-bar-cancel">Cancel</button>
  `;
  bar.querySelector(".select-bar-cancel").addEventListener("click", exitSelectMode);
  bar.querySelector("#select-dl-btn").addEventListener("click", downloadSelected);
  document.body.appendChild(bar);
};

const SUN_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
const MOON_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

export const createThemeToggle = (container) => {
  const btn = document.createElement("button");
  btn.id = "theme-toggle";
  btn.className = "folder-pill theme-toggle";
  btn.type = "button";
  btn.setAttribute("aria-label", "Toggle theme");

  const render = () => {
    btn.innerHTML = state.activeTheme === "light" ? MOON_ICON : SUN_ICON;
    btn.title = state.activeTheme === "light" ? "Switch to dark mode" : "Switch to light mode";
  };
  render();

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    applyTheme(state.activeTheme === "light" ? "dark" : "light");
    render();
  });

  container.appendChild(btn);
};

// Combined View menu: view style radios + field visibility checkboxes + column slider
export const createViewMenu = (container) => {
  const VIEW_MODES = [
    { value: "masonry", label: "Masonry", icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="10" rx="1.5"/><rect x="14" y="3" width="7" height="6" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/></svg>` },
    { value: "card", label: "Card", icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="8" rx="1.5"/><rect x="3" y="14" width="7" height="8" rx="1.5"/><rect x="14" y="14" width="7" height="8" rx="1.5"/></svg>` },
    { value: "list", label: "List", icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="7" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="7" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/><line x1="7" y1="18" x2="21" y2="18"/></svg>` },
  ];

  const FIELD_LABELS = {
    media: "Media",
    author: "Author",
    text: "Tweet Text",
    stats: "Stats",
    date: "Date",
  };

  const VIEW_LABELS = {
    masonry: "Masonry",
    card: "Card",
    list: "List",
  };

  const wrapper = document.createElement("div");
  wrapper.className = "pill-wrapper";

  const pill = document.createElement("div");
  pill.id = "view-menu-pill";
  pill.className = "folder-pill view-menu-pill";
  pill.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="14" y2="18"/>
      <circle cx="14" cy="6" r="1.8" fill="currentColor" stroke="none"/>
      <circle cx="7" cy="12" r="1.8" fill="currentColor" stroke="none"/>
      <circle cx="17" cy="18" r="1.8" fill="currentColor" stroke="none"/>
    </svg>
    <span>View</span>
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>
  `;

  const dropdown = document.createElement("div");
  dropdown.className = "folder-dropdown view-menu-dropdown";
  // Prevent document-level click listener from closing the dropdown when
  // users toggle fields — individual items that SHOULD close it will still
  // do so explicitly via classList.remove("open").
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  const buildDropdown = () => {
    dropdown.innerHTML = "";

    // --- View style section ---
    const styleSection = document.createElement("div");
    styleSection.className = "view-menu-section";
    styleSection.innerHTML = `<div class="view-menu-label">Style</div>`;

    const radioGroup = document.createElement("div");
    radioGroup.className = "view-radio-group";

    for (const mode of VIEW_MODES) {
      const radio = document.createElement("button");
      radio.className = `view-radio-item${state.activeView === mode.value ? " active" : ""}`;
      radio.dataset.view = mode.value;
      radio.innerHTML = `
        <span class="view-radio-indicator"></span>
        <span class="view-radio-icon">${mode.icon}</span>
        <span class="view-radio-label">${mode.label}</span>
      `;
      radio.addEventListener("click", (e) => {
        e.stopPropagation();
        if (mode.value === state.activeView) return;
        state.activeView = mode.value;
        saveViewState();
        buildDropdown(); // re-render dropdown for field labels
        rebuildGrid();
      });
      radioGroup.appendChild(radio);
    }
    styleSection.appendChild(radioGroup);
    dropdown.appendChild(styleSection);

    // --- Divider ---
    const divider1 = document.createElement("div");
    divider1.className = "view-menu-divider";
    dropdown.appendChild(divider1);

    // --- Field visibility section ---
    const fieldSection = document.createElement("div");
    fieldSection.className = "view-menu-section";
    fieldSection.innerHTML = `<div class="view-menu-label">Show in ${VIEW_LABELS[state.activeView]}</div>`;

    const fieldList = document.createElement("div");
    fieldList.className = "view-field-list";

    const currentFields = state.viewFields[state.activeView];
    for (const [key, label] of Object.entries(FIELD_LABELS)) {
      const fieldItem = document.createElement("label");
      fieldItem.className = "view-field-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "view-field-checkbox";
      checkbox.checked = currentFields[key];
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        state.viewFields[state.activeView][key] = checkbox.checked;
        saveViewState();
        rebuildGrid();
      });

      const labelSpan = document.createElement("span");
      labelSpan.className = "view-field-label";
      labelSpan.textContent = label;

      fieldItem.appendChild(checkbox);
      fieldItem.appendChild(labelSpan);
      fieldList.appendChild(fieldItem);
    }
    fieldSection.appendChild(fieldList);
    dropdown.appendChild(fieldSection);

    // --- Column slider (hidden for list view) ---
    if (state.activeView !== "list") {
      const divider2 = document.createElement("div");
      divider2.className = "view-menu-divider";
      dropdown.appendChild(divider2);

      const colSection = document.createElement("div");
      colSection.className = "view-menu-section";
      colSection.innerHTML = `
        <div class="view-menu-label view-menu-label--with-value">
          <span>Columns</span>
          <span class="view-menu-value">${CONFIG.COLS}</span>
        </div>
        <div class="view-menu-slider-wrap">
          <span class="view-menu-slider-val">2</span>
          <input id="col-slider" type="range" min="2" max="8" step="1" value="${CONFIG.COLS}">
          <span class="view-menu-slider-val">8</span>
        </div>
      `;

      const slider = colSection.querySelector("#col-slider");
      const valueEl = colSection.querySelector(".view-menu-value");
      const updateTrack = () => {
        const val = parseInt(slider.value, 10);
        const pct = ((val - 2) / 6) * 100;
        slider.style.background = `linear-gradient(to right, #5b9cf6 ${pct}%, rgba(var(--fg-rgb), 0.15) ${pct}%)`;
        if (valueEl) valueEl.textContent = val;
      };
      updateTrack();
      slider.addEventListener("input", () => {
        updateTrack();
        CONFIG.COLS = parseInt(slider.value, 10);
        saveViewState();
        rebuildGrid(false);
      });
      dropdown.appendChild(colSection);
    }
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    buildDropdown();
    closeOtherDropdowns(dropdown);
    dropdown.classList.toggle("open");
  });
  document.addEventListener("click", () => dropdown.classList.remove("open"));

  wrapper.appendChild(pill);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);
};

export const createSortPill = (container) => {
  const sortOptions = [
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "likes", label: "Most Liked" },
    { value: "bookmarks", label: "Most Bookmarked" },
    { value: "reposts", label: "Most Reposted" },
  ];

  const wrapper = document.createElement("div");
  wrapper.className = "pill-wrapper";

  const pill = document.createElement("div");
  pill.id = "sort-pill";
  pill.className = "folder-pill";
  pill.innerHTML = `<span id="sort-pill-label">${SORT_LABELS[state.activeSort]}</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>`;

  const dropdown = document.createElement("div");
  dropdown.id = "sort-dropdown";
  dropdown.className = "folder-dropdown";

  wrapper.appendChild(pill);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);

  const buildDropdown = () => {
    dropdown.innerHTML = "";
    for (const opt of sortOptions) {
      const item = document.createElement("button");
      item.className =
        "folder-dropdown-item" + (opt.value === state.activeSort ? " active" : "");
      item.textContent = opt.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        state.activeSort = opt.value;
        document.getElementById("sort-pill-label").textContent = opt.label;
        dropdown.classList.remove("open");
        saveViewState();
        rebuildGrid();
      });
      dropdown.appendChild(item);
    }
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    buildDropdown();
    closeOtherDropdowns(dropdown);
    dropdown.classList.toggle("open");
  });

  document.addEventListener("click", () => dropdown.classList.remove("open"));
};

export const createFolderPill = (container) => {
  const wrapper = document.createElement("div");
  wrapper.className = "pill-wrapper";

  const pill = document.createElement("div");
  pill.id = "folder-pill";
  pill.className = "folder-pill";
  pill.innerHTML = `<span id="folder-pill-label">${escapeHtml(state.activeFolder)}</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>`;

  const dropdown = document.createElement("div");
  dropdown.id = "folder-dropdown";
  dropdown.className = "folder-dropdown";

  wrapper.appendChild(pill);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);

  const buildDropdown = () => {
    dropdown.innerHTML = "";
    const options = ["All", ...state.folders.map((f) => f.name)];
    for (const name of options) {
      const item = document.createElement("button");
      item.className =
        "folder-dropdown-item" + (name === state.activeFolder ? " active" : "");
      item.textContent = name;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (name === state.activeFolder) { dropdown.classList.remove("open"); return; }
        state.activeFolder = name;
        document.getElementById("folder-pill-label").textContent = name;
        dropdown.classList.remove("open");
        saveViewState();
        rebuildGrid();
      });
      dropdown.appendChild(item);
    }
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    buildDropdown();
    closeOtherDropdowns(dropdown);
    dropdown.classList.toggle("open");
  });

  document.addEventListener("click", () => dropdown.classList.remove("open"));
};

// --- Electron-only UI ---

const updateSyncButtonState = (lastSyncAt) => {
  const btn = document.getElementById("sync-btn");
  if (!btn) return;
  const minutesSince = (Date.now() - new Date(lastSyncAt)) / 60000;
  if (minutesSince < 60) {
    const minutesLeft = Math.ceil(60 - minutesSince);
    btn.disabled = true;
    btn.querySelector("span").textContent = `Next sync in ${minutesLeft}m`;
    btn.title = `Last synced: ${new Date(lastSyncAt).toLocaleString()}`;
  } else {
    btn.title = `Last synced: ${new Date(lastSyncAt).toLocaleString()}`;
  }
};

// --- About modal ---
// Fill in your personal info and social links here.
const ABOUT_INFO = {
  name: "Hasan Aydın",
  role: "Product Designer & Indie Maker",
  tagline: "Making X bookmarks truly useful again.",
  socials: [
    // { label: "X / Twitter", href: "https://x.com/yourhandle" },
    // { label: "GitHub",      href: "https://github.com/yourhandle" },
    // { label: "LinkedIn",    href: "https://www.linkedin.com/in/yourhandle" },
    { label: "Website",     href: "https://hasanaydin.co" },
  ],
};

let aboutModalEl = null;
const openAboutModal = () => {
  if (!aboutModalEl) {
    aboutModalEl = document.createElement("div");
    aboutModalEl.className = "about-modal";
    aboutModalEl.innerHTML = `
      <div class="about-modal-backdrop"></div>
      <div class="about-modal-panel" role="dialog" aria-labelledby="about-modal-title">
        <button class="about-modal-close" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="about-modal-logo"><img src="assets/AppLogo.svg" alt="ColleX" draggable="false"></div>
        <h2 id="about-modal-title" class="about-modal-name">${escapeHtml(ABOUT_INFO.name)}</h2>
        <div class="about-modal-role">${escapeHtml(ABOUT_INFO.role)}</div>
        ${ABOUT_INFO.tagline ? `<p class="about-modal-tagline">${escapeHtml(ABOUT_INFO.tagline)}</p>` : ""}
        ${ABOUT_INFO.socials.length ? `
          <div class="about-modal-socials">
            ${ABOUT_INFO.socials.map(s => `
              <a class="about-modal-social" href="${escapeHtml(s.href)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
    document.body.appendChild(aboutModalEl);

    const close = () => aboutModalEl.classList.remove("open");
    aboutModalEl.querySelector(".about-modal-close").addEventListener("click", close);
    aboutModalEl.querySelector(".about-modal-backdrop").addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && aboutModalEl.classList.contains("open")) close();
    });
  }
  requestAnimationFrame(() => aboutModalEl.classList.add("open"));
};

// Builds the contents of the user dropdown, including the About + Disconnect items.
// Called both before /user-info resolves (no user info) and after (with user info).
const buildUserDropdown = (dropdown, userInfo) => {
  const hasUser = !!userInfo?.handle;
  dropdown.innerHTML = `
    ${hasUser ? `
      <div class="user-dropdown-info">
        ${userInfo.avatar ? `<img class="user-dropdown-avatar" src="${escapeHtml(userInfo.avatar)}" alt="">` : ""}
        <div>
          <div class="user-dropdown-name">${escapeHtml(userInfo.name || userInfo.handle)}</div>
          <div class="user-dropdown-handle">@${escapeHtml(userInfo.handle)}</div>
        </div>
      </div>
      <div class="user-dropdown-divider"></div>
    ` : ""}
    <button class="folder-dropdown-item user-about-btn">About</button>
    <button class="folder-dropdown-item user-disconnect-btn">Disconnect account</button>
  `;

  dropdown.querySelector(".user-about-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.remove("open");
    openAboutModal();
  });
  dropdown.querySelector(".user-disconnect-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.remove("open");
    window.electronAPI.reLogin();
  });
};

// Renders the pill synchronously so it's visible on first paint, then
// enriches the dropdown with user info once /user-info resolves.
// Returns a promise that resolves after enrichment — callers awaiting user
// info (e.g. for sync-cooldown-aware auto-sync) can use it.
export const createUserPill = (container) => {
  const wrapper = document.createElement("div");
  wrapper.className = "pill-wrapper";

  const pill = document.createElement("div");
  pill.className = "folder-pill user-pill";
  pill.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;

  const dropdown = document.createElement("div");
  dropdown.className = "folder-dropdown user-dropdown";
  buildUserDropdown(dropdown, null);

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    closeOtherDropdowns(dropdown);
    dropdown.classList.toggle("open");
  });
  document.addEventListener("click", () => dropdown.classList.remove("open"));

  wrapper.appendChild(pill);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);

  return fetch("/user-info")
    .then((res) => res.json())
    .then((userInfo) => {
      if (userInfo?.handle) buildUserDropdown(dropdown, userInfo);
      if (userInfo?.lastSyncAt) updateSyncButtonState(userInfo.lastSyncAt);
    })
    .catch(() => {});
};

// --- Export Menu ---

const exportBookmarks = (format) => {
  const data = state.filteredBookmarks;
  if (!data.length) return;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let content = "";
  let type = "";
  let ext = "";
  
  if (format === "json") {
    content = JSON.stringify(data, null, 2);
    type = "application/json";
    ext = "json";
  } else if (format === "csv") {
    const fields = ["id", "authorName", "authorHandle", "text", "url", "postedAt", "likeCount", "repostCount", "bookmarkCount"];
    content = fields.join(",") + "\n";
    data.forEach(bm => {
      const row = fields.map(f => {
        let val = bm[f];
        if (val == null) val = "";
        val = String(val).replace(/"/g, '""');
        return `"${val}"`;
      });
      content += row.join(",") + "\n";
    });
    type = "text/csv;charset=utf-8;";
    ext = "csv";
  }
  
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bookmarks_export_${timestamp}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
};

export const createExportMenu = (container) => {
  const wrapper = document.createElement("div");
  wrapper.className = "pill-wrapper";

  const pill = document.createElement("div");
  pill.id = "export-pill";
  pill.className = "folder-pill";
  pill.innerHTML = `<span id="export-pill-label">Export</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="3,4.5 6,7.5 9,4.5"/></svg>`;

  const dropdown = document.createElement("div");
  dropdown.id = "export-dropdown";
  dropdown.className = "folder-dropdown";
  
  const buildDropdown = () => {
    dropdown.innerHTML = "";
    
    // JSON Option
    const btnJson = document.createElement("button");
    btnJson.className = "folder-dropdown-item";
    btnJson.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export JSON`;
    btnJson.addEventListener("click", (e) => {
      e.stopPropagation();
      exportBookmarks("json");
      dropdown.classList.remove("open");
    });
    
    // CSV Option
    const btnCsv = document.createElement("button");
    btnCsv.className = "folder-dropdown-item";
    btnCsv.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Export CSV`;
    btnCsv.addEventListener("click", (e) => {
      e.stopPropagation();
      exportBookmarks("csv");
      dropdown.classList.remove("open");
    });

    dropdown.appendChild(btnJson);
    dropdown.appendChild(btnCsv);
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    buildDropdown();
    closeOtherDropdowns(dropdown);
    dropdown.classList.toggle("open");
  });

  document.addEventListener("click", () => dropdown.classList.remove("open"));

  wrapper.appendChild(pill);
  wrapper.appendChild(dropdown);
  container.appendChild(wrapper);
};
