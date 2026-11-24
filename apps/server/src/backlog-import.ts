/**
 * Bring waiting handoff briefs into the Opportunity Nav backlog.
 *
 *   npm run -s backlog-import -w @opnav/server -- [--apply] [--app <slug>=<App> ...] <dir> [<dir> ...]
 *
 * Reads each brief's front matter (title, repo, priority, commit, push, after,
 * worker, agent, model, effort, needs, local_model, app) and adds it with
 * add_to_backlog, keyed by the brief's name so it can never be added twice.
 * Without --apply it only says what it would do.
 *
 * So the old dispatchers and the backlog can't both start a brief, --apply
 * first moves the brief out of the folder the dispatchers read (to --move-to,
 * default <handoff>/backlog/). The move is one rename, and a dispatcher moves a
 * brief to working/ with mv and skips it if it's gone, so whoever moves it first owns it. If the backlog
 * refuses it, the brief goes back where it was.
 *
 * Mapping, the same as the routed dispatcher's:
 *   worker: (none) / studio / here  → pinned to this machine (--studio, default this host's name), from the repo checkout's current branch
 *   worker: any                     → any machine that can
 *   worker: cloudroom               → runner cloudroom
 *   worker: <name>                  → pinned to that machine
 *   agent → provider (default claude); push: true → push; after → after; local_model → localModel (only where the
 *   Studio's models are: not for a brief pinned to another machine or a cloud)
 *   priority high/urgent first, then normal, then low, then by name, inside each app
 *   app: front matter app:, else the longest --app slug prefix that matches the name after its date, else the project's title
 *
 * Signs in like the dispatcher: --config (default ~/.config/handoff/opnav), line 1 server URL, line 2 agent token.
 * Never prints the token.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: "boolean", default: false },
    app: { type: "string", multiple: true, default: [] },
    config: { type: "string" },
    handoff: { type: "string" },
    "move-to": { type: "string" },
    studio: { type: "string" },
  },
});

const home = homedir();
const expand = (p: string) => p.replace(/^~(?=\/|$)/, home);
const H = resolve(expand(values.handoff ?? "~/Work/handoff"));
const moveTo = resolve(expand(values["move-to"] ?? join(H, "backlog")));
const studio = values.studio ?? hostname();
const appMap = (values.app ?? []).map((a) => {
  const i = a.indexOf("=");
  if (i < 1) throw new Error(`--app takes <slug>=<App>, not "${a}".`);
  return { slug: a.slice(0, i).trim().toLowerCase(), app: a.slice(i + 1).trim() };
}).sort((a, b) => b.slug.length - a.slug.length);

function frontMatter(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const m = /^([\w-]+):\s*(.*?)\s*(?:\s+#.*)?$/.exec(line);
    if (m?.[1] && m[2] !== undefined && !out.has(m[1])) out.set(m[1], m[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}
const body = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return lines.slice(end + 1).join("\n");
};
const truthy = (v?: string) => /^(true|yes|1)$/i.test(v ?? "");
const band = (p?: string) => (/^(high|urgent)$/i.test(p ?? "") ? 0 : /^low$/i.test(p ?? "") ? 2 : 1);
const git = (repo: string, ...args: string[]) => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

interface Plan {
  name: string;
  file: string;
  app?: string;
  band: number;
  input?: Record<string, unknown>;
  skip?: string;
  note?: string;
}

function plan(file: string): Plan {
  const name = basename(file, ".md");
  const text = readFileSync(file, "utf8");
  const fm = frontMatter(text);
  const p: Plan = { name, file, band: band(fm.get("priority")) };
  if (existsSync(join(H, "done", `${name}.md`))) return { ...p, skip: "already done (done/ has its report)" };
  if (existsSync(join(H, "working", `${name}.md`))) return { ...p, skip: "running in the old queue (working/ has it)" };
  const repo = fm.get("repo") ? resolve(expand(fm.get("repo")!)) : join(home, "projects");
  if (!existsSync(repo) || !statSync(repo).isDirectory()) return { ...p, skip: `repo ${repo} isn't here` };
  const remote = git(repo, "remote", "get-url", "origin");
  if (!remote) return { ...p, skip: `${repo} has no origin remote, so it can't be an Opportunity Nav job; leave it to the old queue` };

  const worker = (fm.get("worker") ?? "").trim().toLowerCase();
  const agent = (fm.get("agent") ?? "claude").trim().toLowerCase();
  let machine: string | undefined, runner: string | undefined, branch: string | undefined;
  if (worker === "" || worker === "studio" || worker === "here" || worker === studio.toLowerCase()) {
    machine = studio;
    branch = git(repo, "branch", "--show-current") || undefined;
  } else if (worker === "cloudroom") runner = "cloudroom";
  else if (worker !== "any") machine = fm.get("worker")!.trim();
  const localModel = truthy(fm.get("local_model")) && !runner && (!machine || machine === studio);
  const push = truthy(fm.get("push"));
  const commit = push || truthy(fm.get("commit"));
  const gitNote = push
    ? "Commit your work on this job's branch. When you finish, Opportunity Nav lands it on the branch this checkout is on (e.g. main) and pushes it; don't push yourself. No pull requests."
    : commit
      ? "Commit your work on this job's branch. Don't push. It stays on that branch, on this machine, for review."
      : "Don't push. Whatever you leave is kept on this job's branch, on this machine, for review.";
  const title = fm.get("title") || name;
  const prompt = `You are processing a handoff brief from Grok Bot (Coding Manager) on behalf of the user. It came from the Mac Studio's handoff queue and runs here as an Opportunity Nav backlog job.
Read this repo's AGENTS.md, CLAUDE.md or CODING.md first if it has them.

Brief: ${title}

${body(text).trim()}

Git: ${gitNote}
Work only inside this checkout. Don't write a report file or a STATUS line in ~/Work/handoff. Instead, end your final reply with the report itself, in sections: Summary, Changes (files, and commits if any), Not done / questions.`;
  const slug = name.replace(/^\d{4}-\d\d-\d\d-/, "").toLowerCase();
  const app = fm.get("app") || appMap.find((a) => slug === a.slug || slug.startsWith(`${a.slug}-`))?.app;
  const needs = (fm.get("needs") ?? "").replace(/[[\]"]/g, "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // A dependency whose report is already in done/ is met; leave it out.
  const after = (fm.get("after") ?? "").split(",").map((s) => s.trim().replace(/\.md$/, "")).filter(Boolean)
    .filter((a) => !existsSync(join(H, "done", `${a}.md`)));
  const input: Record<string, unknown> = {
    repo: remote, prompt, title, provider: agent, key: name, push,
    ...(app ? { app } : {}),
    ...(machine ? { machine } : {}),
    ...(runner ? { runner } : {}),
    ...(branch ? { branch } : {}),
    ...(fm.get("model") ? { model: fm.get("model") } : {}),
    ...(fm.get("effort") ? { effort: fm.get("effort")!.toLowerCase() } : {}),
    ...(needs.length ? { needs } : {}),
    ...(after.length ? { after } : {}),
    ...(localModel ? { localModel: true } : {}),
  };
  const note = worker === "" ? "ran in place with claude -p before; now in a helper worktree on the Studio (no untracked .env or node_modules there)" : undefined;
  return { ...p, app, input, note };
}

/** Live local-model jobs in the old queue (.run/<name>.job, line 5 = local_model, pid alive). */
function oldLocalModelJobs(): string[] {
  const run = join(H, ".run");
  if (!existsSync(run)) return [];
  return readdirSync(run).filter((f) => f.endsWith(".job")).filter((f) => {
    const lines = readFileSync(join(run, f), "utf8").split("\n");
    if (lines[4]?.trim() !== "local_model") return false;
    try { process.kill(Number(lines[1]), 0); return true; } catch { return false; }
  }).map((f) => f.replace(/\.job$/, ""));
}

async function call(action: string, input: unknown): Promise<any> {
  const [url, token] = readFileSync(expand(values.config ?? "~/.config/handoff/opnav"), "utf8").split(/\r?\n/).map((s) => s.trim());
  if (!url || !token) throw new Error("No Opportunity Nav sign-in (line 1 URL, line 2 agent token).");
  const r = await fetch(`${url.replace(/\/+$/, "")}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "backlog-import", parts: [{ kind: "data", data: { action, input } }] } } }),
  });
  const out: any = await r.json().catch(() => ({}));
  const data = out?.result?.parts?.find((p: any) => p.kind === "data")?.data;
  const err = out?.error?.message ?? data?.error;
  if (!r.ok || err) throw new Error(err ?? `HTTP ${r.status}`);
  return data.result;
}

async function main() {
  if (!positionals.length) throw new Error("Name the folders to bring in, e.g. ~/Work/handoff/hold/free.");
  const files = positionals.flatMap((d) => {
    const dir = resolve(expand(d));
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
  });
  const plans = files.map(plan).sort((a, b) => (a.app ?? "").localeCompare(b.app ?? "") || a.band - b.band || a.name.localeCompare(b.name));
  // While the old queue runs a local-model job, local-model briefs wait for it here too.
  const busy = oldLocalModelJobs();
  for (const p of plans) if (p.input?.localModel && busy.length) p.input.after = [...((p.input.after as string[]) ?? []), ...busy];

  if (values.apply) mkdirSync(moveTo, { recursive: true });
  const imported = new Set<string>();
  for (const p of plans) {
    const where = p.input ? [p.input.app ?? "(project)", p.input.provider, p.input.machine ?? (p.input.runner ?? "any machine"),
      p.input.push ? "push" : "", p.input.branch ? `branch ${p.input.branch}` : "", p.input.localModel ? "local model" : "",
      (p.input.after as string[] | undefined)?.length ? `after ${(p.input.after as string[]).join(", ")}` : ""].filter(Boolean).join(" · ") : "";
    if (p.skip) { console.log(`skip  ${p.name}: ${p.skip}`); continue; }
    if (!values.apply) {
      console.log(`would add  ${p.name}  [${where}]${p.note ? `\n      note: ${p.note}` : ""}`);
      imported.add(p.name.toLowerCase());
      continue;
    }
    const dest = join(moveTo, basename(p.file));
    try {
      if (existsSync(dest)) throw Object.assign(new Error("already moved"), { code: "EEXIST" });
      renameSync(p.file, dest); // atomic: fails with ENOENT if a dispatcher took it first
    } catch (e) {
      console.log(`skip  ${p.name}: couldn't take it from ${p.file} (${(e as NodeJS.ErrnoException).code}); the old queue may have started it`);
      continue;
    }
    try {
      const job = await call("add_to_backlog", p.input);
      console.log(`added ${p.name} → job ${job.id}  [${where}]`);
      imported.add(p.name.toLowerCase());
    } catch (e) {
      try { if (!existsSync(p.file)) renameSync(dest, p.file); } catch {}
      console.log(`refused ${p.name}: ${(e as Error).message} (left where it was)`);
    }
  }

  // Briefs left in the old queue that wait on one that moved: their done/ report won't appear.
  const queueDirs = [join(H, "inbox"), ...(existsSync(join(H, "hold")) ? readdirSync(join(H, "hold")).map((d) => join(H, "hold", d)) : [])]
    .filter((d) => existsSync(d) && statSync(d).isDirectory());
  for (const d of queueDirs) for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
    const name = basename(f, ".md");
    if (imported.has(name.toLowerCase())) continue;
    const after = (frontMatter(readFileSync(join(d, f), "utf8")).get("after") ?? "").replace(/\.md$/, "").trim();
    if (after && imported.has(after.toLowerCase())) console.log(`warn  ${name} (still in ${d}) waits for ${after}, which ${values.apply ? "is" : "would be"} in the backlog now: bring it in too, or it waits for a done/ report that won't come`);
  }
  if (busy.length) console.log(`note  the old queue is running local-model job(s) ${busy.join(", ")}; local-model items wait for them`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
