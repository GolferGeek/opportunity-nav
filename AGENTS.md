# Working on Opportunity Nav

Read INTENTION.md (why) and docs/subscription-usage.md (usage at the source) first.

## Layout
- `packages/shared` — zod contracts shared by everything. Node ⇄ server API is in `src/routes.ts`. Change a contract only on main, in its own commit, and tell the other builder.
- `apps/server` — Fastify + Postgres (Drizzle): data, UI API, A2A, MCP. Owner: Claude.
- `apps/web` — React + Vite UI. Owner: Claude.
- `apps/desktop` — Electron shell; embeds the node helper. Owner: Claude.
- `apps/node` — the per-machine helper: usage adapters, job runners, handoff watcher. Runs inside the desktop app or as a service. Owner: Codex.

## Rules
- Node 24+ runs `.ts` directly (type stripping): erasable TypeScript only (no enums, namespaces, parameter properties). Relative imports use `.ts` extensions.
- `npm run check` (typecheck + tests) passes before every merge. No GitHub Actions; checks run locally.
- Never commit, log or print secrets or tokens. Usage adapters read sign-ins read-only and never refresh them.
- Nothing hard-coded to one person. Matt's setup is seed data.
- UI text: plain words, one thought per line, quiet by default.
- Work on your own branch (`claude/...`, `codex/...`); the other builder reviews before merging to main.
- An Opportunity Nav job works on `opnav/<id>` instead. One started with push (a brief with `push: true`, or a backlog item with `push`) lands on main by itself when it succeeds, so its brief's required checks must pass first; if they can't, end with a question, which stops the landing.
