const { app, BrowserWindow, session, shell, ipcMain, dialog, Menu } = require("electron");
const net = require("net");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { loadCredentials, saveCredentials, clearCredentials } = require("./src/credentials");
const { tryExtractChromeCookies } = require("./src/browser-cookies");

const isDev = !app.isPackaged;
const DATA_DIR = isDev ? __dirname : app.getPath("userData");

let mainWindow = null;
let loginWindow = null;
let serverPort = null;

// --- Port discovery ---

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// --- Window management ---

function openMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // External links → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

function openLoginWindow(port, autoLogin = false) {
  loginWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    title: "Connect Your X Account",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let credentialsCaptured = false;

  // Intercept Twitter GraphQL requests to capture auth credentials
  loginWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["*://x.com/i/api/graphql/*", "*://twitter.com/i/api/graphql/*"] },
    (details, callback) => {
      // Always pass through — never block the request
      callback({ requestHeaders: details.requestHeaders });

      if (credentialsCaptured) return;

      // Only care about Bookmarks operation
      if (!details.url.includes("/Bookmarks")) return;

      const queryIdMatch = details.url.match(/graphql\/([^/?]+)\/Bookmarks/);
      if (!queryIdMatch) return;
      const queryId = queryIdMatch[1];

      const h = details.requestHeaders;
      const bearerRaw = h["authorization"] || h["Authorization"] || "";
      const bearerToken = bearerRaw.replace(/^Bearer\s+/i, "").trim();
      const ct0 = (h["x-csrf-token"] || h["X-Csrf-Token"] || "").trim();
      const cookies = h["cookie"] || h["Cookie"] || "";
      const authTokenMatch = cookies.match(/auth_token=([^;]+)/);
      const authToken = authTokenMatch ? authTokenMatch[1].trim() : "";

      if (!bearerToken || !ct0 || !authToken || !queryId) return;

      credentialsCaptured = true;

      const creds = {
        bearerToken,
        ct0,
        authToken,
        queryId,
        capturedAt: new Date().toISOString(),
      };

      saveCredentials(DATA_DIR, creds);
      console.log("✓ Credentials captured, queryId:", queryId);

      // Fetch user info in background, then open main window
      const { fetchUserInfo } = require("./src/twitter");
      fetchUserInfo(creds).then((userInfo) => {
        if (userInfo.userHandle) {
          saveCredentials(DATA_DIR, { ...creds, ...userInfo });
          console.log("✓ Logged in as @" + userInfo.userHandle);
        }
        if (loginWindow) { loginWindow.close(); loginWindow = null; }
        openMainWindow(port);
      }).catch(() => {
        if (loginWindow) { loginWindow.close(); loginWindow = null; }
        openMainWindow(port);
      });
    }
  );

  // Auto-redirect to bookmarks once user is logged in (auth_token cookie appears)
  loginWindow.webContents.session.cookies.on("changed", (event, cookie) => {
    if (
      (cookie.domain.includes("twitter.com") || cookie.domain.includes("x.com")) &&
      cookie.name === "auth_token" &&
      !cookie.removed &&
      !credentialsCaptured
    ) {
      setTimeout(() => {
        if (loginWindow && !credentialsCaptured) {
          loginWindow.loadURL("https://twitter.com/i/bookmarks");
        }
      }, 1500);
    }
  });

  loginWindow.on("closed", () => {
    loginWindow = null;
    // If closed before capture and no main window, quit
    if (!mainWindow && !credentialsCaptured) {
      dialog.showErrorBox(
        "Connection cancelled",
        "You closed the login window before connecting. Reopen the app to try again."
      );
      app.quit();
    }
  });

  if (autoLogin) {
    // Cookies were pre-injected into the session; going straight to bookmarks
    // triggers the GraphQL request that the interceptor above captures.
    // If cookies are stale, X will redirect to the login page in this same
    // window — user can fall back to manual login without us doing anything.
    loginWindow.loadURL("https://x.com/i/bookmarks");
  } else {
    loginWindow.loadFile(path.join(__dirname, "login.html"));
  }
}

async function injectChromeCookies({ ct0, authToken }) {
  const ses = session.defaultSession;
  await ses.cookies.set({
    url: "https://x.com/",
    name: "ct0",
    value: ct0,
    domain: ".x.com",
    path: "/",
    secure: true,
    sameSite: "lax",
  });
  await ses.cookies.set({
    url: "https://x.com/",
    name: "auth_token",
    value: authToken,
    domain: ".x.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

// Show a native dialog offering to reuse the user's Chrome session.
// Returns true if the user accepted, false if they want manual login.
function promptUseChromeSession() {
  const choice = dialog.showMessageBoxSync(null, {
    type: "question",
    title: "Chrome session detected",
    message: "We found an active X session in Chrome",
    detail:
      "Would you like to sign in automatically using your Chrome session? " +
      "Otherwise you can sign in manually in the next window.",
    buttons: ["Use Chrome session", "Sign in manually"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0;
}

// Start the correct window flow when no credentials are stored:
// offer the Chrome session shortcut if one exists, otherwise open the
// manual login window.
async function beginAuthFlow() {
  const chromeCookies = tryExtractChromeCookies();
  if (chromeCookies && promptUseChromeSession()) {
    await injectChromeCookies(chromeCookies);
    openLoginWindow(serverPort, /*autoLogin=*/ true);
  } else {
    openLoginWindow(serverPort);
  }
}

// --- IPC handlers ---

ipcMain.handle("re-login", async () => {
  clearCredentials(DATA_DIR);
  if (mainWindow) { mainWindow.close(); mainWindow = null; }
  await beginAuthFlow();
});

// Pop up the native macOS share sheet (AirDrop, Messages, Mail, Notes, etc.)
// anchored to the mouse position. macOS-only; returns false on other platforms
// so the renderer can fall back to clipboard copy.
ipcMain.handle("share-url", (event, { url, title, text }) => {
  if (process.platform !== "darwin") return false;

  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;

  const sharingItem = { urls: [url] };
  // Bundle title + text as a single text payload so Messages/Notes include it
  const combined = [title, text].filter(Boolean).join("\n").trim();
  if (combined) sharingItem.texts = [combined];

  const menu = Menu.buildFromTemplate([
    { label: "Share…", role: "shareMenu", sharingItem },
  ]);
  menu.popup({ window: win });
  return true;
});

// --- Auto-update ---

function setupAutoUpdater() {
  if (isDev) {
    console.log("[updater] Skipped in development mode");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message || err);
    dialog.showErrorBox("Update Error", `Failed to check for updates: ${err?.message || err}`);
  });

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    dialog.showMessageBox({
      type: "info",
      title: "Update Available",
      message: `A new version ${info.version} is available!`,
      detail: "The update will be downloaded in the background. You'll be notified when it's ready to install.",
      buttons: ["OK"],
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] up to date:", info.version);
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] downloaded:", info.version);
    const response = dialog.showMessageBoxSync({
      type: "info",
      title: "Update Ready",
      message: `Version ${info.version} has been downloaded.`,
      detail: "The update will be installed when you quit the app. Would you like to restart now?",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // Check for updates on startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[updater] Failed to check for updates:", err);
    });
  }, 3000);
}

// Show custom About dialog
function showAboutDialog() {
  const version = app.getVersion();

  dialog.showMessageBox({
    type: "info",
    title: `About ${app.name}`,
    message: `${app.name}`,
    detail: `Version ${version}\n\nBrowse your X bookmarks in a beautiful visual desktop library.\n\n© 2026 Hasan Aydın`,
    buttons: ["OK"],
    icon: path.join(__dirname, "assets/AppIcon.png"),
  });
}

// Manual update check
function checkForUpdatesManually() {
  if (isDev) {
    dialog.showMessageBox({
      type: "info",
      title: "Development Mode",
      message: "Auto-update is disabled in development mode.",
      buttons: ["OK"],
    });
    return;
  }

  autoUpdater.checkForUpdates().then((result) => {
    if (!result || !result.updateInfo) {
      dialog.showMessageBox({
        type: "info",
        title: "No Updates",
        message: "You're already running the latest version!",
        buttons: ["OK"],
      });
    }
  }).catch((err) => {
    dialog.showErrorBox("Update Check Failed", `Could not check for updates: ${err?.message || err}`);
  });
}

// --- Menu setup ---

function createAppMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => showAboutDialog(),
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => checkForUpdatesManually(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ] : [
          { role: "delete" },
          { type: "separator" },
          { role: "selectAll" },
        ]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [
          { type: "separator" },
          { role: "front" },
          { type: "separator" },
          { role: "window" },
        ] : [
          { role: "close" },
        ]),
      ],
    },
    ...(!isMac ? [{
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => checkForUpdatesManually(),
        },
      ],
    }] : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// --- App startup ---

app.whenReady().then(async () => {
  serverPort = await findFreePort();

  // Start HTTP server (OG proxy, video proxy, static files, /sync SSE)
  const { createServer } = require("./server");
  createServer(serverPort, DATA_DIR);

  // Setup application menu
  createAppMenu();

  const creds = loadCredentials(DATA_DIR);
  if (creds) {
    openMainWindow(serverPort);
  } else {
    await beginAuthFlow();
  }

  setupAutoUpdater();
});

app.on("window-all-closed", () => {
  // On macOS, keep app running unless explicitly quit
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (!mainWindow && !loginWindow && serverPort) {
    const creds = loadCredentials(DATA_DIR);
    if (creds) openMainWindow(serverPort);
    else await beginAuthFlow();
  }
});
