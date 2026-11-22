import { join } from "node:path";
import { json, localPath, string } from "../system.ts";
import { jwt } from "./common.ts";
import type { Adapter } from "./common.ts";

export const gemini: Adapter = {
  provider: "gemini",
  commands: ["gemini"],
  async detect(sys) {
    const dir = join(localPath(sys, sys.env.GEMINI_CLI_HOME ?? "~"), ".gemini");
    const oauth = await json(join(dir, "oauth_creds.json"));
    const google = await json(join(dir, "google_accounts.json"));
    if (!oauth.access_token && !google.active && !sys.env.GEMINI_API_KEY) return;
    const claims = jwt(string(oauth.id_token));
    return { id: string(claims.sub) ?? string(google.active)?.toLowerCase() };
  },
  async read() {
    // Gemini CLI documents its interactive /stats command for quota.
    // Its OAuth sign-in is reserved for the CLI itself.
    return { windows: [], unavailable: "Open Gemini CLI and run /stats to see usage." };
  },
};
