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

`push: true` lands the work on the checkout's branch and pushes it, rebasing first if origin moved.
If that fails, it pushes the job's branch `opnav/<id>` instead and says so.
`commit: true`, or neither: the work stays on `opnav/<id>` on that machine.

## Results

The watcher writes the report and STATUS line from the job's result.
Questions show in Opportunity Nav, under What's happening.
