const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("citropyDesktop", {
  windowState: () => ipcRenderer.invoke("window:state"),
  windowCommand: (command) => ipcRenderer.invoke("window:command", command),
  onWindowState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  onNotification: (callback) => {
    const listener = (_, notification) => callback(notification);
    ipcRenderer.on("notification:open", listener);
    return () => ipcRenderer.removeListener("notification:open", listener);
  },
  onBrowserSelect: (callback) => {
    const listener = (_, panel) => callback(panel);
    ipcRenderer.on("browser:select", listener);
    ipcRenderer.send("browser:ready");
    return () => ipcRenderer.removeListener("browser:select", listener);
  },
  browserBounds: (id, bounds, visible, cover = false) =>
    ipcRenderer.send("browser:bounds", { id, bounds, visible, cover }),
  onBrowserCover: (callback) => {
    const listener = (_, id, image) => callback(id, image);
    ipcRenderer.on("browser:cover", listener);
    return () => ipcRenderer.removeListener("browser:cover", listener);
  },
  onAddressFocus: (callback) => {
    const listener = (_, id) => callback(id);
    ipcRenderer.on("browser:address", listener);
    return () => ipcRenderer.removeListener("browser:address", listener);
  },
});
