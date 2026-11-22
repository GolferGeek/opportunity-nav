import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalWork, ExternalWorkReport } from "@opnav/shared";
import { localPath } from "./system.ts";
import type { System } from "./system.ts";

const stages = [["inbox", "queued"], ["working", "running"], ["done", "succeeded"]] as const;

function frontmatter(text: string) {
  const fields = new Map<string, string>();
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  for (const line of header?.split(/\r?\n/) ?? []) {
    const match = /^([\w-]+):\s*(.*?)\s*(?:\s+#.*)?$/.exec(line);
    if (match?.[1] && match[2]) fields.set(match[1], match[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return fields;
}

function questionsFrom(text: string): string[] {
  const questions: string[] = [];
  let inQuestions = false;
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^```|^~~~/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading) {
      inQuestions = /^(?:open )?questions?\b/i.test(heading);
      continue;
    }
    const inline = /^(?:[-*]\s+)?\*{0,2}(?:open )?questions?\*{0,2}:\*{0,2}\s*(.*)$/i.exec(line);
    if (inline) inQuestions = true;
    const value = (inline?.[1] ?? line.replace(/^(?:[-*+] |\d+[.)] )/, "")).trim();
    if (inQuestions && value && !/^(?:none|n\/a|no questions)(?:[. ]|$)/i.test(value) && !/^```|^~~~/.test(value)) {
      questions.push(value);
    }
  }
  return questions;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function handoffReport(sys: System, dir: string): Promise<ExternalWorkReport> {
  const status = await readFile(join(dir, "STATUS.md"), "utf8").catch(error => {
    if (missing(error)) return "";
    throw error;
  });
  const done = new Map<string, string>();
  const repos = new Map<string, string>();
  for (const line of status.split(/\r?\n/)) {
    const end = /^\S+(?: \d\d:\d\d:\d\d)? DONE ([^:]+):/.exec(line);
    const start = /^\S+(?: \d\d:\d\d:\d\d)? START (.+?) \(in (.+?);/.exec(line);
    if (end?.[1]) done.set(end[1], line);
    if (start?.[1] && start[2]) repos.set(start[1], start[2]);
  }
  const items = new Map<string, ExternalWork>();
  let complete = true;
  for (const [folder, status] of stages) {
    const entries = await readdir(join(dir, folder), { withFileTypes: true }).catch(error => {
      if (missing(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const path = join(dir, folder, entry.name);
      try {
        const [body, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        const fields = frontmatter(body);
        const id = entry.name.slice(0, -3);
        const previous = items.get(entry.name);
        const repo = fields.get("repo") ?? repos.get(id) ?? previous?.repo;
        const title = fields.get("title") ?? previous?.title ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id;
        items.set(entry.name, { source: "handoff", externalId: entry.name, title, status,
          repo: repo && localPath(sys, repo), updatedAt: info.mtime.toISOString(),
          summary: folder === "done" ? done.get(id) ?? done.get(entry.name) : undefined,
          questions: folder === "done" ? questionsFrom(body) : [],
        });
      } catch (error) {
        if (!missing(error)) throw error;
        complete = false;
      }
    }
  }
  // A move between directories during a scan can skip a file for one poll.
  return { items: [...items.values()], complete: complete ? ["handoff"] : [] };
}
