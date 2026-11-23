// Bundle the Electron main process (with the node helper inside) and preload into plain JS.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { system } from "../node/src/system.ts";
import { sourceVersion } from "../node/src/version.ts";

await mkdir("dist", { recursive: true });
// The helper inside reports the version and commit it was built from.
const version = await sourceVersion(system(), fileURLToPath(new URL("../node/src", import.meta.url)));
const define = { __OPNAV_HELPER_VERSION__: JSON.stringify(version), "import.meta.dirname": "undefined" };
const common = { bundle: true, define, platform: "node", target: "node22", format: "cjs", external: ["electron"], sourcemap: true, logLevel: "warning" };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
await cp("src/setup.html", "dist/setup.html");
console.log(`Built dist/ (helper ${version})`);
