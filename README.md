# Opportunity Nav

Matt Weber's home base for everything he's building: a tree of areas and projects, what's in flight, questions waiting on him, roadblocks, and what his AI subscriptions have left. He drives it, and so do his agents. It isn't hard-coded to him, though: anyone can run their own.

See [INTENTION.md](INTENTION.md) for why it exists.

## How it fits together

One app, three pieces:

- **Server** (`apps/server`): Postgres plus an API. It holds everything: your tree, jobs, questions and usage. It runs on one always-on machine.
- **Desktop app** (`apps/desktop`): the window you use. It also runs the **helper** (`apps/node`), so the agents on that machine report their usage and can take jobs. Headless machines run the helper as a background service instead.
- **Agent doors:** A2A at `/a2a` (agent card at `/.well-known/agent-card.json`) and MCP at `/mcp`. Grok Bot or any other agent can read the tree, add to it, answer questions and start jobs.
- **Reviews pick their agent:** `start_review` sends a review to Antigravity or Codex, whichever has more subscription usage left.
  - An agent's usage left is its tightest window, on its best account. A window past its reset time counts as unused.
  - Antigravity's Claude and GPT allowances don't count, since a review runs its default Gemini model.
  - Antigravity takes a fair share: with no reading for its Gemini model, it counts as half left.
  - A reading that isn't current (its last check failed, it needs a sign-in, or it's over 30 minutes old) ranks below every current one. The reply says how old it is. The dashboard marks it "Not current".
  - If no online machine with a free slot can run that agent (with the repo, and any Docker or database the job needs), the other one goes. A machine's helper runs one job at a time unless it says otherwise.
  - A reading belongs to the machine and account it came from. The usage that counts is the account a free machine is signed in to. If the machines that run the agent aren't all on that account, the review goes to that machine.
  - An agent with 0% left never gets a review. If both are at 0%, the review is refused and the reply says why.
  - A review doesn't inherit the project's default model unless it goes to the project's default agent.
  - The reply says which agent was picked and why.

Usage comes straight from each provider, using the sign-in its own CLI already saved on that machine. It's read-only, tokens are never refreshed and never sent anywhere else. See [docs/subscription-usage.md](docs/subscription-usage.md).

## Set up

You need Node 24 or newer and Postgres.

**1. Server** (on your always-on machine)

```sh
git clone https://github.com/GolferGeek/opportunity-nav && cd opportunity-nav
npm ci && npm run build -w @opnav/web
cp .env.example .env              # set DATABASE_URL and PUBLIC_URL
npm run admin -w @opnav/server -- setup --name "Your name"   # prints a sign-in link
npm start -w @opnav/server
```

On a Mac, `deploy/install-server-macos.sh` does all of this. It also runs the server as a LaunchAgent and publishes it on your tailnet over HTTPS with `tailscale serve`.

**2. Desktop app** (on each machine you use)

```sh
npm run dist -w @opnav/desktop    # builds a .dmg / AppImage into apps/desktop/release
npm run install:linux -w @opnav/desktop    # Linux: build and install to ~/.local/share/opportunity-nav/desktop
```

To update a running app on Linux, use `install:linux`: it asks the app to quit (`opportunity-nav --quit`), waits, replaces the files and starts it again. Don't `pkill` it: signalling all of its processes at once makes Electron abort with a core dump.

Open it and paste the sign-in link. Leave **Use this machine's agents** on, and it connects the helper for you.

**3. Headless machines** (no screen)

Create a machine token in **Settings → Connect a machine**, then:

```sh
OPNAV_SERVER_URL=https://your-server OPNAV_NODE_TOKEN=… npx opnav-node install-service
```

**4. Agents**

Create an agent token in **Settings → Connect an agent**. Give the agent the card URL and the token.

## Jobs

Start a job from any project: pick the agent, the model, and local or cloud. A machine that has the project's repo checked out and that agent signed in picks it up. If the agent needs you, the job stops with a question in **What's happening**. Your answer resumes the same session on the same machine.

Coding jobs run in a separate Git worktree on branch `opnav/<first 8 characters of the job ID>`. Workers commit there and never push.

When a job's worktree is new, the helper installs the repo's packages before the agent starts, so the agent can run the repo's tests:
- npm (`package-lock.json`): `npm ci --offline --ignore-scripts`. pnpm (`pnpm-lock.yaml`): `pnpm install --offline --frozen-lockfile --ignore-scripts`.
- Offline only: packages come from this machine's npm cache or pnpm store, never the registry. No package scripts run.
- Lockfiles are never changed, and nothing is committed. Anything tracked the install touched is put back.
- It is skipped when `node_modules` isn't ignored by Git, or the repo uses another package manager.
- If it can't install (a package isn't in the cache, or it takes over 2 minutes), the job log says why and the job goes on without packages.

A job started with `push` (a handoff brief with `push: true` does this) lands its work instead:
- It lands on the project's default branch, the one origin's HEAD points to (`main` or `master`), unless the job names a branch on purpose. Never on a branch just because the checkout happens to have it checked out.
- Its worktree starts from that branch on origin.
- When it succeeds, the helper asks the server first, then pushes it there.
- If origin moved on, it replays the job's commits on top (Git 2.44 or later), on a temporary ref: `opnav/<id>` itself is never rewritten, so a retry checks the same commits and knows when its earlier push already landed.
- If that conflicts or the push is refused, it pushes `opnav/<id>` instead, and the job's last progress line says so.
- It pushes only that one branch: never tags, never a submodule's commits, whatever the machine's Git settings say.
- Safety net, checked right before it pushes: if the landing branch isn't the default branch and the job didn't name it, or it's already merged into the default branch, nothing is pushed. The last progress line says "Not pushed" and why, and the work stays on `opnav/<id>`.

Which checkout: when a machine has several checkouts of a repo, a job runs in one on the default branch first, then the repo's own checkout before linked worktrees (`git worktree add`), then by path. A job that names a branch runs in a checkout on that branch.

Stop vs push: the server decides, under the job's lock.
- A Stop accepted before the helper asks to push wins: nothing is pushed, and the job ends cancelled even if its result comes in after.
- Once the server has said "push", the push wins: Stop is refused for that turn (it answers `publishing`), and the result stands.

A job runs only in a checkout whose origin is the project's repo, as Git will really reach it (after any `insteadOf` or `pushInsteadOf` rewrite).
If it isn't, the job ends at once and says why. A pushing job checks again right before it pushes, and fetches and pushes only the addresses it checked.

A machine runs up to 3 jobs at once, each in its own worktree. Set `OPNAV_CAPACITY` (1 to 16) on the machine to change that.
Jobs that run in a cloud (Claude's cloud, Cloudroom) have their own slots on top of those: up to 2 at once, set with `OPNAV_CLOUD_CAPACITY` (0 to 8).
The machine only waits on them, so they never take a local slot, and a full cloud never holds up a local job. Bringing the cloud's work back in happens in the cloud slot too.
Settings > Machines shows both, e.g. "Local 2 of 3 · cloud 1 of 2". A machine's job limit (set_machine) lowers its local slots only.
Jobs in the same repo prepare their worktrees and push one at a time, so each push lands on top of the last.

To restart or update a machine's helper without cutting a job off, stop it taking new jobs first:
- **Settings → Machines → Stop new jobs**, or `npm run admin -w @opnav/server -- jobs-off --machine <name>` on the server.
- Wait until it shows no jobs running (`… -- machines`), restart it, then turn it back on (`jobs-on`).
- Jobs waiting meanwhile stay queued for the other machines, or for it.

## Handoff briefs on any machine

The Mac Studio's handoff watcher (`~/Work/handoff`) can send a brief to Opportunity Nav instead of running it itself. A brief opts in with `worker:` in its frontmatter: `any`, a machine's name, or `cloudroom`. The watcher starts the job, waits for it, and writes the brief's report from the job's result. See `~/Work/handoff/PROTOCOL.md`. The worktree stays available for follow-up turns and review under `~/.local/share/opportunity-nav/worktrees`, or `$XDG_DATA_HOME/opportunity-nav/worktrees`.

How to write a brief for a worker: [docs/handoff-workers.md](docs/handoff-workers.md).

Run `opnav-node worktrees --prune` on the worker machine to remove clean, idle worktrees whose branch has been merged into its starting branch or whose job was first seen more than 14 days ago. Git branches stay available for review.

How much a job can do on a machine is that machine's choice (`OPNAV_WORKER_AUTONOMY`):
- `edit` (the default): edit files in the job worktree and run commands in a sandbox.
- `full`: no sandbox and no prompts.

## The backlog

Add work to one ranked backlog (`add_to_backlog`, `set_app_ranking`) and machines pull the next item themselves when they have room, keeping the rules: on hold, waiting on another item, one local-model job per machine, one pushing job per repo and branch. `get_lined_up` (and Lined up on the Dashboard) says what's running, what's next, what's left and whether it's running low. See [docs/backlog.md](docs/backlog.md), including how to bring in the handoff hold folders.

## Running jobs in Cloudroom

A job can run on your own machine (the default) or in Cloudroom's cloud sandbox. A machine with the Cloudroom app installed and signed in offers the cloud option automatically.

- It runs Claude Code, Codex or Antigravity on your own subscription.
- It starts from the repo's default branch on GitHub, so unpushed local changes aren't there.
- It pushes its work to a branch named `opnav/<first 8 characters of the job ID>` for you to review. It never opens a pull request or touches the default branch.

## Running Claude jobs in Claude's cloud

A Claude job can also run in Claude's own cloud, through a Claude Code routine on your Max plan. A machine offers it once you've saved the routine's token on it, and only for the repos its routine file lists: see [docs/claude-cloud-setup.md](docs/claude-cloud-setup.md).

Repos compare exactly, case and all, except on GitHub (which ignores case). Before 2026-11-23 a project's repo was stored lower-cased: if one on another host has capitals in its path, set its repo again in the project's settings, or no machine will take its jobs.

- It starts from the project's default branch on origin (or the branch the job names), so unpushed local changes aren't there.
- The cloud session pushes to a `claude/opnav-…` branch. The machine brings that in and lands it like any job (with push, on that same branch).
- There's no status API: a run that never pushes shows up only as a timeout (45 minutes, then one more try).

## Developing

```sh
npm run check     # typecheck + tests. Server tests need OPNAV_TEST_DATABASE_URL (a throwaway DB; it's wiped).
npm run dev -w @opnav/server
npm run dev -w @opnav/web        # http://localhost:5317, proxying the API
```

Read [AGENTS.md](AGENTS.md) before changing code. There are no GitHub Actions. Checks run locally.
