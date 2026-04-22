const { contextBridge, ipcRenderer, shell } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => shell.openExternal(url),
  reLogin: () => ipcRenderer.invoke("re-login"),
  shareUrl: (payload) => ipcRenderer.invoke("share-url", payload),
  isElectron: true,
});
