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
    const credential = string(sys.env.GEMINI_API_KEY ?? sys.env.GOOGLE_API_KEY);
    const token = string(oauth.access_token);
    const refreshToken = string(oauth.refresh_token);
    if (!token && !refreshToken && !google.active && !credential) return;
    const claims = jwt(string(oauth.id_token));
    return { token, refreshToken, credential, id: string(claims.sub) ?? string(claims.email ?? google.active)?.toLowerCase() };
  },
  async read() {
    // Gemini CLI documents its interactive /stats command for quota.
    // Its OAuth sign-in is reserved for the CLI itself.
    return { windows: [], unavailable: "Open Gemini CLI and run /stats to see usage." };
  },
};
