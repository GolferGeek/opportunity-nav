# Running handoff briefs on Opportunity Nav workers

Write the brief in `~/Work/handoff/inbox` as usual.
Add frontmatter to choose where and how it runs.

## Where

`worker: any` runs on any machine that's free.
`worker: <machine name>` runs on that machine.
`worker: studio` runs on the Mac Studio through Opportunity Nav.
`worker: cloudroom` runs in Cloudroom's cloud sandbox.
No `worker:` runs on the Studio as before.

## How

`agent:` is `claude`, `codex` or `agy`. The default is `claude`.
`model:` and `effort:` pass through to the agent.
`needs: docker, database` sends it only to a machine that has them.

## Where the work lands

`push: true` lands the work on the repo's default branch (where origin's HEAD points, `main` or `master`) and pushes it. If origin moved on, it replays the job's commits on top first.
A brief that names a branch on purpose lands there instead, unless that branch is already merged into the default one.
It never lands on a branch just because some worktree on the machine has it checked out.
If that fails, it pushes the job's branch `opnav/<id>` instead and says so.
`commit: true`, or neither: the work stays on `opnav/<id>` on that machine.
Either way, anything the agent leaves uncommitted is committed for it on `opnav/<id>`.

## Results

The watcher writes the report and STATUS line from the job's result.
Questions show in Opportunity Nav, under What's happening.

## Taking turns in a repo

Jobs in the same repo take turns.
A brief for a machine other than the Studio (`worker: omarchy`, `worker: cloudroom`), without `push: true`, only waits for that machine's jobs in the repo.
It doesn't wait for the Studio, and the Studio doesn't wait for it.
`push: true` and `worker: any` briefs wait for every job in the repo, on any machine.
`worker: studio` takes turns with the Studio's own jobs.

Once a job is on Opportunity Nav, a machine runs several at once, in the same repo too.
Only fetching, setting up worktrees and pushing go one at a time per checkout.
A brief brought into the backlog follows the backlog's rules instead: see [backlog.md](backlog.md).
