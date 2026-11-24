# The backlog

One ranked list of work. Products and Matt add to it; Opportunity Nav starts the next item by itself whenever a machine has room. Nobody moves brief files by hand.

## How the next item is picked

When a machine with a free slot asks for work, it gets the first item, in this order, that it can run and that nothing holds back:

1. A job whose question was just answered (it resumes first).
2. Jobs started right away with `start_job` or `start_review`, oldest first.
3. Backlog items, by their **app's place in the app ranking**, then their **place inside the app**. Apps not in the ranking come after the ranked ones, in tree order (priority, then your own order).

An item is held back, wherever it sits, while:

- it's **on hold** (`held: true`). A held item never starts.
- it **waits on another item** (`after`) that hasn't succeeded. `after` can name another item's `key`, a job id, or a handoff brief's name. A brief still in the old queue counts once the Studio's handoff watcher sees its report in `done/`.
- it **uses local models** (`localModel: true`) and another local-model job runs on that machine. Only a machine with Ollama models takes one. On Matt's setup that's the Studio: one local-model job at a time.
- it **pushes** (`push: true`) and another pushing job is running for the same repo and branch.

The usual checks still apply: the agent is signed in there, the repo is checked out (on the item's `branch`, if it names one), the machine has what it `needs` (Docker, a database), a pinned `machine`, and the machine's slots. A machine's slots are its helper's capacity, or less if its owner set a `jobLimit`.

Nothing here changes the commit and push rules. Nothing goes to prod, is deleted or costs money without Matt.

## Actions (A2A, MCP, and the app's command bar)

All are on the agent card at `/.well-known/agent-card.json`. Over A2A, send a data part `{"action": "<name>", "input": {...}}`.

| Action | What it does |
|---|---|
| `add_to_backlog` | Add an item. `item` or `repo` (which project), `prompt`, and optionally `title`, `app`, `provider` (claude, codex, agy…), `model`, `effort`, `machine`, `needs`, `push`, `branch`, `after`, `localModel`, `held`, `key`, `top`, `before`. |
| `update_backlog_item` | `{jobId, changes}`. Before it starts: `held` true or false, `top: true`, `before: <job id>` (null = last), `app`, `title`, `prompt`, `provider`, `model`, `machine` (null = any), `needs`, `push`, `branch`, `after`, `localModel`. |
| `cancel_job` | `{jobId}`. Drops a waiting item, or stops a running one. |
| `set_app_ranking` | `{apps: ["Legal", "Agents Only", ...]}`. Replaces the whole ranking. |
| `get_lined_up` | Read-only. See below. |
| `set_machine` | `{machine, jobLimit?, takingJobs?}`. `jobLimit` keeps a machine below its helper's capacity; null clears it. |

`app` is free text. It defaults to the project's title. Use it when the work's app isn't its own project (Legal's items run in the Local repo, for example). Names match without regard to case.

### What's lined up

`get_lined_up {next?, all?, sinceHours?}` returns:

- `running`: jobs running now, with machine, agent, app and start time.
- `next`: the next `next` items (default 5; `all: true` lists all of them, held ones too), in the order they'll start. Each has `ready` (it starts as soon as one of `canRunOn` has a free slot), or `why` it's waiting. Examples: "On hold", "Waits for <name>", "Waits for the local models", "Waits for main to be free", or each machine's reason.
- `total`: waiting, ready, held, running.
- `perApp`: per app, running, ready, waiting (held back), on hold. In ranking order.
- `perMachine`: per online machine, its slots, running, free, and how many ready items it could take.
- `runningLow`: `low` is true when fewer items are ready than the online machines taking jobs have slots. Includes the counts and a one-line `text`.
- `finished`: backlog items that ended in the last `sinceHours` (default 24).
- `ranking`: the app ranking.

The app shows the same data under **Waiting to start**, at the top of the Dashboard: a line saying these are queued jobs that start by themselves, one line of counts, a running-low line when it applies, and the next three. **Show all** lists everything, per app and per machine, with Hold / Let go, Top of app and Drop. What's happening no longer lists waiting backlog items. Once one starts it shows there like any job.

## Bringing in the handoff queue

`apps/server/src/backlog-import.ts` reads briefs from the handoff hold folders and adds each one with `add_to_backlog`. It runs on the Studio and signs in with the dispatcher's agent token (`~/.config/handoff/opnav`).

```sh
cd ~/.local/share/opportunity-nav/app
npm run -s backlog-import -w @opnav/server -- \
  --app legal=Legal --app agents-only="Agents Only" --app opnav="Opportunity Nav" --app pi=Pi --app offering=Offering \
  ~/Work/handoff/hold/free ~/Work/handoff/hold/routed ~/Work/handoff/hold/cap-switch-2026-11-23
```

Without `--apply` it only prints what it would add. With `--apply` it does the import.

- **Key:** each item's `key` is the brief's name, so a brief can't be added twice.
- **Front matter:** `title`, `repo`, `priority`, `commit`, `push`, `after`, `worker`, `agent`, `model`, `effort`, `needs` and `local_model` map the way the routed dispatcher maps them.
  - `branch:` names the branch a pushing job lands on, on purpose. Without it, it lands on the repo's default branch.
  - No `worker:`, or `studio`: pinned to the Studio. A pushing job lands on the repo's default branch (see README, Jobs), whatever branch its checkout is on.
  - `any`: any machine.
  - `cloudroom`: Cloudroom.
  - Any other name: that machine.
- **Order:** inside an app, `priority: high` goes first, then normal, then low, then by name.
- **App:** the brief's `app:` if it has one. Otherwise the longest `--app` slug that matches its name after the date. Otherwise the project's title.
- **Skipped:** briefs already in `working/` or `done/`, and briefs whose repo has no `origin` (e.g. `~/Work/handoff` itself). Those stay with the old queue.
- **Met dependencies:** an `after:` whose report is already in `done/` is dropped.

**No double starts.** With `--apply`, each brief is first moved out of the folder the dispatchers read, into `~/Work/handoff/backlog/`, before it's added. A dispatcher moves a brief to `working/` with `mv` and skips it if it's gone. So whoever moves it first owns it. If the backlog refuses a brief, it goes back where it was.

**Local models during the switch.** If the old queue is running a local-model job when you import, the imported local-model items also wait for it (`after`).

**After the switch.** A brief left in the old queue whose `after:` names an imported brief would wait for a `done/` report that never comes, so the importer warns about it. Bring those in too.

**Reports.** Backlog items report in Opportunity Nav: `get_job`, `get_lined_up.finished`, and the job drawer. They don't write `done/` files.
