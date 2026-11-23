import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./system.ts";
import type { System } from "./system.ts";

// The desktop build bakes the version in (apps/desktop/build.mjs), since the
// bundled app has no checkout to ask.
declare const __OPNAV_HELPER_VERSION__: string | undefined;

/** The package version plus the commit it was built from: 0.1.0+eeb12c2, with .dirty if files were changed. */
export async function sourceVersion(sys: System, dir: string): Promise<string> {
  let base = "0.0.0";
  try {
    base = String(JSON.parse(await readFile(join(dir, "..", "package.json"), "utf8")).version || base);
  } catch {
    // Keep the placeholder.
  }
  const commit = await command(sys, "git", ["rev-parse", "--short=7", "HEAD"], dir);
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return base;
  const dirty = await command(sys, "git", ["status", "--porcelain", "--untracked-files=no"], dir);
  return `${base}+${commit}${dirty ? ".dirty" : ""}`;
}

/** This helper's version, as its heartbeat reports it. */
export async function helperVersion(sys: System): Promise<string> {
  if (typeof __OPNAV_HELPER_VERSION__ === "string" && __OPNAV_HELPER_VERSION__) return __OPNAV_HELPER_VERSION__;
  return sourceVersion(sys, import.meta.dirname);
}
