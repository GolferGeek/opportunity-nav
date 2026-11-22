import { contextBridge, ipcRenderer } from "electron";

// The web UI reads window.opnavDesktop.{serverUrl, token}; setup.html uses setup().
const ctx = ipcRenderer.sendSync("opnav:context") as { serverUrl: string | null; token: string | null; helperStatus: string };
contextBridge.exposeInMainWorld("opnavDesktop", {
  serverUrl: ctx.serverUrl,
  token: ctx.token,
  helperStatus: ctx.helperStatus,
  setup: (link: string, runHelper: boolean) => ipcRenderer.invoke("opnav:setup", { link, runHelper }),
});
