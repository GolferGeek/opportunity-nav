import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Turn } from "@opnav/shared";
import { command } from "./system.ts";
import type { System } from "./system.ts";

export async function geminiInvocation(sys: System, binary: string, turn: Turn) {
  const help = await command(sys, binary, ["--help"]);
  const format = help.includes("stream-json") ? "stream-json" : /--output-format/.test(help) ? "json" : "text";
  const session = turn.kind === "continue" && /--resume\b/.test(help) &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(turn.providerSessionId ?? "") ? turn.providerSessionId : undefined;
  const dir = join(sys.env.XDG_STATE_HOME ?? join(sys.home, ".local/state"), "opportunity-nav", "gemini");
  const path = join(dir, turn.job.id + ".txt");
  const input = turn.kind === "start" ? turn.job.prompt : session ? turn.answer!.text : [
    turn.job.prompt,
    "Previous reply:",
    await readFile(path, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    }),
    "User's answer:",
    turn.answer!.text,
  ].join("\n\n");
  const args = ["-p", "", ...(format === "text" ? [] : ["--output-format", format]),
    ...(session ? ["--resume", session] : []), ...(turn.job.model ? [`--model=${turn.job.model}`] : [])];

  return {
    args, input, format,
    async remember(reply: string) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, reply, { flag: "wx", mode: 0o600 });
      try {
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    },
  };
}
