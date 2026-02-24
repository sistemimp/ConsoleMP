const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updaterApi", {
  readRemote: () => ipcRenderer.invoke("updater:read-remote"),
  runInstaller: (installerPath, options) => ipcRenderer.invoke("updater:run-installer", installerPath, options),
  openNetworkFolder: (targetUrl) => ipcRenderer.invoke("updater:open-network-folder", targetUrl)
});
