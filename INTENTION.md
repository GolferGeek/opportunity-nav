# Opportunity Nav — Original Intention

*Written 2026-11-22 from Matt Weber's conversation with his CEO agent (Grok Bot). This is the starting intention, not a spec. Codex and Matt will turn it into a plan and build it.*

## Why it exists

Matt codes and runs many projects at once: coding projects, writing projects, client work, and new opportunities he is spending real money on (Claude, Codex, Gemini, Cursor, Grok Bot). Tools like Claude's own room views have their own idea of how work is organized, and Matt has to work around them. They are noisy. Opportunity Nav is the opposite: **Matt's view of everything he cares about building**, organized his way, quiet by default.

This is the place he lives all day. It is built for Matt first. If someone else likes it, great; if not, that's fine.

## The core idea

- A **hierarchy (tree) of everything Matt cares about**: areas, then projects, then the work inside each one, ordered by what matters most to him.
- At every node he can see **what is being worked on, by whom**, the **questions for him** that are slowing things down, and the **roadblocks**.
- He can **act right there**: answer a question, clear a roadblock, fix something, start something new, add a new project.
- **Agentically driven.** He can say "add this thing," "I didn't like this," or "do it this way," and it acts on whatever he is looking at.
- **Two ways in, one brain.** At his desk he navigates visually. When he's away, Grok Bot and his other agents navigate and act on it by his voice or prompts.

## Layout

- **Left nav**: the tree. Drilling happens mostly here.
- **Favorites** at the top of the left nav: one click to the projects he lives in, no drilling.
- **Main window, two panes side by side** (he's usually on a large screen):
  1. **What's happening**: every job in flight, every question for Matt, every roadblock, grouped in his project order. Click one, it opens, he answers or fixes it in place. This is what he wants to see first.
  2. **Dashboard**: subscription fees, subscription status and usage (Claude, Codex, Gemini, Cursor, Grok Bot, and so on), plus a one-line status for each project.
- Drill into any node for detail. Quiet by design: show only what needs Matt or what he asked to see.

## Workers and models

- Workers include Claude Code, Codex, Gemini (CLI), Cursor (including cloud agents), Grok Bot, and local models (Mac Studio with MLX/Ollama, DGX Spark).
- For any job, Matt chooses **the provider, the exact model, and local versus cloud**. Defaults can be set per project.
- Work can start from and track **GitHub issues** or **Cursor Origin issues**.
- A **board of current work** across everything: what's where, and who is working on what, in project-hierarchy order.
- **Subscription status** for each coding subscription: cost, usage against limits, reset times. This is important and needs real thought about how to get it for each provider.

## Not hard-coded to Matt

- Everything (the tree, projects, favorites, questions, jobs, connected agents, models, subscriptions) lives in a **database**, including status across sessions.
- A new user starts with an empty tree and a **"connect your agents"** step. If they only have Claude, they only see Claude. If they only have Gemini, they only see Gemini.
- Each kind of agent or provider gets a **small adapter** (start a job, read its status, report usage). Adding a provider means adding an adapter, not rewriting the app.
- Other users connect their own GitHub if they use issues, and tie their agents to the app's **A2A endpoints**.
- Matt's own setup is simply the first user's data.

## Agent access

- **A2A endpoints are first-class** (Matt prefers A2A), published with an agent card at `/.well-known/agent-card.json`.
- An **MCP interface** as a second door is welcome if it's cheap.
- Agents can read the tree and status, add projects and items, answer or route questions, and start jobs.

## Platform and stack (open for the plan)

- Matt's machines: Mac Studio (always-on, headless coding box), M2 Max MacBook Pro running Omarchy Linux (daily driver), a MacBook Pro on macOS, and a DGX Spark.
- He has described it as a Mac app that "should just work." Electron was discussed so one codebase runs on macOS and Omarchy Linux. A native Mac app is the alternative. The plan should recommend one.
- Database: Postgres, either hosted Supabase or local Postgres on the Studio (Neon was also mentioned). The plan should recommend one.
- Existing context it should read from in Matt's setup: the Mac Studio handoff watcher (`~/Work/handoff/inbox`, `STATUS.md`, `done/`), the coding agents' own logs and usage, and GitHub/Origin issues.

## Rules that carry over

- No GitHub Actions on Matt's repos; checks run locally.
- No secrets, keys, or tokens committed or printed.
- Plain words in the UI. One thought per line. Low noise.

## Possible build order (a starting suggestion, not a requirement)

1. Data model and database (users, areas, projects, jobs, questions, agents, models, subscriptions), nothing hard-coded.
2. Left nav tree with favorites.
3. The two panes: what's happening, and the dashboard.
4. Answer a question or add a project from the app.
5. A2A endpoints so Grok Bot can read and add.
6. Adapters for real status: handoff watcher, Claude Code, Codex, Gemini, Cursor, GitHub and Origin issues, and subscription usage.
7. Start jobs from the app with provider, model, and local-or-cloud choice.
8. Voice and prompt control throughout.
