// Electron's own installer sometimes leaves dist/ half-extracted (seen with Node 26).
// If the binary is missing, unpack the zip it already downloaded, with the OS's own
// tool (ditto keeps the macOS app bundle's symlinks intact).
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const dir = path.dirname(require.resolve("electron/package.json"));
const { version } = require("electron/package.json");
const mac = process.platform === "darwin";
const exe = mac ? "Electron.app/Contents/MacOS/Electron" : "electron";
if (existsSync(path.join(dir, "dist", exe)) && existsSync(path.join(dir, "path.txt"))) process.exit(0);

const cache = process.env.electron_config_cache ?? (mac ? path.join(homedir(), "Library/Caches/electron") : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "electron"));
const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
const zip = existsSync(cache) ? readdirSync(cache).map((d) => path.join(cache, d, name)).find(existsSync) : undefined;
if (!zip) {
  execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
  if (existsSync(path.join(dir, "dist", exe))) process.exit(0);
  console.error(`Electron ${version} isn't installed and ${name} isn't in ${cache}.`);
  process.exit(1);
}
rmSync(path.join(dir, "dist"), { recursive: true, force: true });
mkdirSync(path.join(dir, "dist"));
if (mac) execFileSync("ditto", ["-xk", zip, path.join(dir, "dist")]);
else execFileSync("unzip", ["-q", zip, "-d", path.join(dir, "dist")]);
writeFileSync(path.join(dir, "path.txt"), exe);
console.log(`Unpacked Electron ${version} from ${zip}`);
