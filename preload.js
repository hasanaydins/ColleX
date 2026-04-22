const { contextBridge, ipcRenderer, shell } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => shell.openExternal(url),
  reLogin: () => ipcRenderer.invoke("re-login"),
  isElectron: true,
});
