import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalWork, ExternalWorkReport } from "@opnav/shared";
import { claudeActivity, codexActivity, redact, shortText } from "./activity.ts";
import { localPath, parse, timestamp } from "./system.ts";
import type { System } from "./system.ts";

const stages = [["inbox", "queued"], ["working", "running"], ["done", "succeeded"]] as const;

const headerPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatter(text: string) {
  const fields = new Map<string, string>();
  const header = headerPattern.exec(text)?.[1];
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

type Detail = NonNullable<ExternalWork["detail"]>;

async function logActivity(path: string): Promise<Detail["activity"]> {
  const file = await open(path).catch(error => {
    if (!missing(error)) throw error;
  });
  if (!file) return [];
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 512 * 1024));
    const offset = size - buffer.length;
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
    if (offset) lines.shift();
    const activity: NonNullable<Detail["activity"]> = [];
    for (const line of lines) {
      const prefix = /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\]?[ \t]+/.exec(line);
      const body = prefix ? line.slice(prefix[0].length) : line;
      const event = parse(body);
      const at = timestamp(event.timestamp ?? event.at ?? prefix?.[1]);
      let messages = [...claudeActivity(event), ...codexActivity(event)];
      // The Studio's print-mode log mixes stderr with the final reply. Only
      // forward recognizable activity from lines with no structured author.
      if (!Object.keys(event).length && /^(?:Read |Edited |Ran: |Searched for |Listed )/.test(body)) {
        const text = shortText(body);
        if (text) messages = [text];
      }
      for (const text of messages) {
        if (activity.at(-1)?.text === text) continue;
        activity.push({ at, text });
        if (activity.length > 100) activity.shift();
      }
    }
    return activity;
  } finally {
    await file.close();
  }
}

export async function handoffReport(sys: System, dir: string, briefs = new Map<string, string>()): Promise<ExternalWorkReport> {
  const status = await readFile(join(dir, "STATUS.md"), "utf8").catch(error => {
    if (missing(error)) return "";
    throw error;
  });
  const done = new Map<string, string>();
  const starts = new Map<string, { repo: string; at?: string }>();
  for (const line of status.split(/\r?\n/)) {
    const end = /^\S+(?: \d\d:\d\d:\d\d)? DONE ([^:]+):/.exec(line);
    const start = /^(\S+(?: \d\d:\d\d:\d\d)?) START (.+?) \(in ([^;)]+)/.exec(line);
    if (end?.[1]) done.set(end[1], redact(line));
    if (start?.[2] && start[3]) starts.set(start[2], { repo: start[3], at: timestamp(start[1]) });
  }
  const items = new Map<string, ExternalWork>();
  let complete = true;
  for (const [folder, status] of stages) {
    const entries = await readdir(join(dir, folder), { withFileTypes: true }).catch(error => {
      if (missing(error)) return [];
      throw error;
    });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".") ||
          (folder === "done" && entry.name.endsWith(".task.md") &&
            entries.some(report => report.name === entry.name.replace(/\.task\.md$/, ".md")))) continue;
      const path = join(dir, folder, entry.name);
      try {
        files.push({ name: entry.name, path, info: await stat(path) });
      } catch (error) {
        if (!missing(error)) throw error;
        complete = false;
      }
    }
    if (folder === "done") files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.name.localeCompare(b.name));
    for (const [index, { name, path, info }] of files.entries()) {
      const id = name.slice(0, -3);
      const start = starts.get(id) ?? starts.get(name);
      const previous = items.get(name);
      const detailed = folder !== "done" || index < 10;
      try {
        const body = await readFile(path, "utf8");
        const fields = frontmatter(body);
        const repo = fields.get("repo") ?? start?.repo ?? previous?.repo;
        const title = redact(fields.get("title") ?? previous?.title ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? id);
        if (folder !== "done") {
          briefs.set(name, redact(`${title} | repo: ${repo ?? "default"} | priority: ${fields.get("priority") ?? "normal"}\n${body.replace(headerPattern, "").trim()}`).slice(0, 20_000));
        } else if (detailed && !briefs.has(name)) {
          const saved = await readFile(join(dir, "done", id + ".task.md"), "utf8").catch(error => {
            if (missing(error)) return "";
            throw error;
          });
          if (saved) {
            const task = frontmatter(saved);
            briefs.set(name, redact(`${task.get("title") ?? title} | repo: ${task.get("repo") ?? repo ?? "default"} | priority: ${task.get("priority") ?? "normal"}\n${saved.replace(headerPattern, "").trim()}`).slice(0, 20_000));
          }
        }
        items.set(name, { source: "handoff", externalId: name, title, status,
          repo: repo && localPath(sys, repo), updatedAt: info.mtime.toISOString(),
          startedAt: start?.at ?? previous?.startedAt ?? info.mtime.toISOString(),
          summary: folder === "done" ? done.get(id) ?? done.get(name) : undefined,
          questions: folder === "done" ? questionsFrom(redact(body)) : [],
          detail: detailed ? {
            brief: briefs.get(name),
            // The watcher's event stream (Claude stream-json) when it writes one; else its plain log.
            activity: await logActivity(join(dir, "logs", id + ".events.jsonl")).then(a => a?.length ? a
              : logActivity(join(dir, "logs", id + ".log"))),
            report: folder === "done" ? redact(body).slice(0, 50_000) : undefined,
          } : undefined,
        });
      } catch (error) {
        if (!missing(error)) throw error;
        complete = false;
      }
    }
  }
  if (complete) {
    for (const name of briefs.keys()) if (!items.get(name)?.detail) briefs.delete(name);
  }
  // A move between directories during a scan can skip a file for one poll.
  return { items: [...items.values()], complete: complete ? ["handoff"] : [] };
}
