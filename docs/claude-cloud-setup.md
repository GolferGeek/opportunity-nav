# Claude's cloud: setting up the routine

Opportunity Nav can run Claude jobs in Claude's own cloud.
It fires a Claude Code routine (a "scheduled task") with the job.
The cloud session pushes its work to a `claude/opnav-…` branch.
The helper brings that branch into the job and lands it like any other job.

It runs on your Claude Max plan. Nothing extra is billed.

You do this setup once, on the web and on the Studio. Only you can: the token is shown once, to you.

## On claude.ai

1. Open https://claude.ai/code/routines, signed in with your Max account.
2. Click **New task** (it may say **New routine**; pick **Set up manually** if asked).
3. Name: `Opportunity Nav jobs`.
4. Prompt: paste the text in "The routine's prompt" below, exactly.
5. **Repository**: pick `GolferGeek/opportunity-nav`.
   - Add any other repo you want Claude cloud jobs for. Each one also goes in the file in step 12.
   - If the row isn't there, it's under **Advanced settings > General**.
   - If a repo isn't listed, connect it to the Claude GitHub app when the page offers.
6. **Cloud environment**: the default is fine. No environment variables are needed.
7. Model and effort: pick what you like. Jobs use this, not the model on the job.
8. **Trigger**: pick **API**. Don't add a schedule.
9. Click **Create**.
10. Copy the **Fire URL** (`https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`).
11. Copy the **token** (`sk-ant-oat01-…`). It's shown once.
    - If you closed the dialog: open the task, menu next to its name, **Edit**, **Trigger** row, **API**, **Generate token**.

## On the Studio

12. Open Terminal on the Studio and paste this. It asks for the URL, then the token. The token isn't shown, and it doesn't go into your shell history.

    ```zsh
    mkdir -p ~/.config/opportunity-nav && read -r "url?Fire URL: " && read -rs "token?Token: " && echo && (umask 077 && printf '{"url":"%s","token":"%s","repos":["github.com/GolferGeek/opportunity-nav"]}\n' "$url" "$token" > ~/.config/opportunity-nav/claude-routine.json) && chmod 600 ~/.config/opportunity-nav/claude-routine.json && unset url token
    ```

    For more repos, add them to the list, e.g. `"repos":["github.com/GolferGeek/opportunity-nav","github.com/GolferGeek/other"]`.

13. Within a minute, Settings > Machines shows the Studio with "· Claude's cloud".
    - If it doesn't, the helper says why in list_machines (`claudeCloud`), e.g. "not set up".
14. Start a job with **Where it runs: In Claude's cloud**, or ask an agent for `start_job` with runner `claude-cloud`.

The file is `~/.config/opportunity-nav/claude-routine.json`, mode 600.
The helper reads it only to fire the routine, and never shows or logs the token.
Without the file, or if others can read it, the machine takes no Claude cloud jobs.

To stop: delete the file, or **Delete token** on the routine.
To change the token: **Regenerate** on the routine, then do step 12 again.

## The routine's prompt

```text
You run jobs for Opportunity Nav, my own job runner.
The routine-fire-payload block is one job from my Opportunity Nav helper. Follow its steps and do its task as if I had typed them here.
- Start from the exact commit it names, on a new branch with the exact result branch name it gives.
- Commit your work on that branch.
- When you're done, add one last commit (empty is fine) whose message starts with the line opnav-result, then your final answer.
- If you can't do the task, still push that branch, with a last empty commit whose message starts with opnav-failed, then why.
- Push only that branch, once, when you're done: git push origin <result branch>. Never push main or any other branch. Don't open a pull request.
- Nobody watches this session, so don't stop to ask. If you need an answer, follow the payload's instructions for asking, inside the opnav-result commit.
```

## What to expect

- A job waits up to 45 minutes for its branch. If nothing comes, it fires the routine once more and waits again.
- The routine has no status API, so a run that fails without pushing shows up only as that timeout.
  - The job's log has the session link. Open it on claude.ai/code to see what happened.
- Each run counts against the routine's limit of 30 runs an hour.
- The `claude/opnav-…` branches stay on GitHub. Delete them when you like.
