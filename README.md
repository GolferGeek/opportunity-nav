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

A job started with `push` (a handoff brief with `push: true` does this) lands its work instead:
- Its worktree starts from the checkout's branch on origin, e.g. `main`.
- When it succeeds, the helper pushes it there. If origin moved on, it rebases first.
- If that conflicts or the push is refused, it pushes `opnav/<id>` instead, and the job's last progress line says so.
- It pushes only that one branch: never tags, never a submodule's commits, whatever the machine's Git settings say.

A job runs only in a checkout whose origin is the project's repo, as Git will really reach it (after any `insteadOf` or `pushInsteadOf` rewrite).
If it isn't, the job ends at once and says why. A pushing job checks again right before it pushes, and fetches and pushes only the addresses it checked.

A machine runs up to 3 jobs at once, each in its own worktree. Set `OPNAV_CAPACITY` (1 to 16) on the machine to change that.
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

A Claude job can also run in Claude's own cloud, through a Claude Code routine on your Max plan. A machine offers it once you've saved the routine's token on it: see [docs/claude-cloud-setup.md](docs/claude-cloud-setup.md).

- It starts from the checkout's branch on origin, so unpushed local changes aren't there.
- The cloud session pushes to a `claude/opnav-…` branch. The machine brings that in and lands it like any job (with push, on the checkout's branch).
- There's no status API: a run that never pushes shows up only as a timeout (45 minutes, then one more try).

## Developing

```sh
npm run check     # typecheck + tests. Server tests need OPNAV_TEST_DATABASE_URL (a throwaway DB; it's wiped).
npm run dev -w @opnav/server
npm run dev -w @opnav/web        # http://localhost:5317, proxying the API
```

Read [AGENTS.md](AGENTS.md) before changing code. There are no GitHub Actions. Checks run locally.
