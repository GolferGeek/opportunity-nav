/**
 * Opportunity Nav desktop app: one window on the server's web UI, plus the
 * node helper running inside, so this machine's agents report usage and take
 * jobs whenever the app is open. Tokens are encrypted with the OS keychain
 * (Electron safeStorage) and never written in the clear.
 */
import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell, Tray, nativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { startNode } from "@opnav/node";

interface Config {
  serverUrl: string;
  uiToken: string; // encrypted, base64
  nodeToken?: string; // encrypted, base64
  runHelper: boolean;
}

const configPath = () => path.join(app.getPath("userData"), "config.json");
const enc = (s: string) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString("base64") : `plain:${s}`);
const dec = (s: string) => (s.startsWith("plain:") ? s.slice(6) : safeStorage.decryptString(Buffer.from(s, "base64")));

function load(): Config | null {
  try {
    return existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), "utf8")) as Config) : null;
  } catch {
    return null;
  }
}
function save(c: Config) {
  writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

let win: BrowserWindow | null = null;
let helper: { stop(): Promise<void> } | null = null;
let helperStatus = "Off";
let tray: Tray | null = null;

function open(c: Config | null) {
  if (!win) {
    win = new BrowserWindow({
      width: 1500,
      height: 950,
      minWidth: 720,
      title: "Opportunity Nav",
      backgroundColor: "#15171b",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.on("closed", () => (win = null));
    // Links to other sites open in the browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      const cfg = load();
      if (url.startsWith("file:") || (cfg && url.startsWith(cfg.serverUrl))) return;
      e.preventDefault();
      void shell.openExternal(url);
    });
  }
  if (c) void win.loadURL(c.serverUrl + "/");
  else void win.loadFile(path.join(__dirname, "setup.html"));
}

async function runHelper(c: Config) {
  await helper?.stop().catch(() => {});
  helper = null;
  if (!c.runHelper || !c.nodeToken) {
    helperStatus = "Off";
    return;
  }
  try {
    helper = startNode({
      serverUrl: c.serverUrl,
      token: dec(c.nodeToken),
      name: hostname(),
      onStatus: (m) => {
        helperStatus = m;
        tray?.setToolTip(`Opportunity Nav · ${m}`);
      },
    });
    helperStatus = "Starting";
  } catch (e) {
    helperStatus = `Couldn't start: ${(e as Error).message}`;
  }
}

/** The page asks for these through the preload bridge. Only pages from the configured server get the token. */
ipcMain.on("opnav:context", (e) => {
  const c = load();
  const from = e.sender.getURL();
  const trusted = c && from.startsWith(c.serverUrl);
  e.returnValue = trusted ? { serverUrl: c.serverUrl, token: dec(c.uiToken), helperStatus } : { serverUrl: c?.serverUrl ?? null, token: null, helperStatus };
});

/**
 * Setup: the person pastes the sign-in link the server printed
 * (https://server/#signin=<token>). We check it, then make this machine's
 * own helper token with it, so there's nothing else to copy.
 */
ipcMain.handle("opnav:setup", async (_e, input: { link: string; runHelper: boolean }) => {
  const m = /^(https?:\/\/[^#\s]+?)\/?#signin=([\w-]+)$/.exec(input.link.trim());
  if (!m) throw new Error("Paste the whole sign-in link, like http://gg-macstudio:4317/#signin=…");
  const serverUrl = m[1]!.replace(/\/+$/, "");
  const uiToken = m[2]!;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(serverUrl + p, {
      method,
      headers: { authorization: `Bearer ${uiToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error(`Couldn't reach ${serverUrl}. Is the server running, and is this machine on the same network or tailnet?`);
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `The server said ${r.status}.`);
    return data;
  };
  const me = await call("GET", "/api/me");
  let nodeToken: string | undefined;
  if (input.runHelper) nodeToken = (await call("POST", "/api/tokens", { role: "node", label: `${hostname()} (desktop app)` })).token;
  const c: Config = { serverUrl, uiToken: enc(uiToken), nodeToken: nodeToken ? enc(nodeToken) : undefined, runHelper: input.runHelper };
  save(c);
  await runHelper(c);
  open(c);
  return { name: me.name };
});

function menu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "Opportunity Nav",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win?.reload() },
        {
          label: "Run the helper on this machine",
          type: "checkbox",
          checked: !!load()?.runHelper,
          click: async (item) => {
            const c = load();
            if (!c) return;
            c.runHelper = item.checked;
            save(c);
            await runHelper(c);
          },
        },
        { label: "Sign out and set up again", click: () => { save({ serverUrl: "", uiToken: "", runHelper: false }); void helper?.stop(); open(null); } },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  menu();
  const raw = load();
  const c = raw && raw.serverUrl && raw.uiToken ? raw : null;
  open(c);
  if (c) await runHelper(c);
  try {
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQUlEQVR4nGNgGAWjgP6A8T8DAwMDg/9/BgYGBmL8Z2BgYGBg+M/AwMDw/z8DAwPDfwYGBoZRMApGwSgYBaNgFAwAAEUlBf7pJ8Q3AAAAAElFTkSuQmCC",
    );
    tray = new Tray(icon);
    tray.setToolTip("Opportunity Nav");
    tray.on("click", () => (win ? win.show() : open(load())));
  } catch {
    // No tray on this desktop; the window is enough.
  }
  app.on("activate", () => !win && open(load()));
});

// Keep the helper running when the window closes; quit from the menu or tray.
app.on("window-all-closed", () => {
  if (!helper) app.quit();
});
app.on("before-quit", () => void helper?.stop());
