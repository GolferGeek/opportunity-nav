// Bundle the Electron main process (with the node helper inside) and preload into plain JS.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const common = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["electron"], sourcemap: true, logLevel: "warning" };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
await cp("src/setup.html", "dist/setup.html");
console.log("Built dist/");
