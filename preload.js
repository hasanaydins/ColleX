const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  reLogin: () => ipcRenderer.invoke("re-login"),
  shareUrl: (payload) => ipcRenderer.invoke("share-url", payload),
  getAppVersion: () => ipcRenderer.invoke("app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  isElectron: true,
});
