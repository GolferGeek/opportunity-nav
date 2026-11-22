# Subscription usage: getting it at the source

*Research notes, 2026-11-22. Input for the plan, not a spec.*

Opportunity Nav has to read each provider's usage itself, so it works for anyone who clones it, not just on Omarchy. Omarchy's Agents bar panel already does this for about 23 providers. It's MIT-licensed, so we can port its approach with credit. Cloudroom (`davidondrej/cloudroom-core`, Apache 2.0) does the same for Claude and Codex.

Reference source on an Omarchy machine:
- `/usr/share/omarchy/bin/omarchy-agent-usage-<provider>`: one collector per provider.
- `/usr/share/omarchy/shell/plugins/agents/collectors.py`: shared plumbing.
- `/usr/share/omarchy/shell/plugins/agents/README.md`: what each collector reads.

## The key fact: usage comes from the sign-in already on the machine

None of these providers gives you a usage API key. Every method reuses the login the agent's own CLI saved on that machine and asks the provider's endpoint with it.

So Opportunity Nav needs a **small usage reporter on each machine** where the agents are signed in: the Studio, the Omarchy laptop, the other MacBook, the Spark. Each one reports to the database. The app reads from the database. A new user installs the reporter wherever their agents run, and it only reports the agents it finds there ("only Claude means only Claude").

## Rules worth copying from Omarchy

- **Read tokens and never refresh them.** Each CLI refreshes its own token when it runs. If we refresh it, we can sign the CLI out.
- **An expired token isn't a broken sign-in.** If the refresh token is still valid, say "start Claude Code to refresh" and keep the last numbers.
- **Keep the last good answer for each account.** Show its age, and reset a window to zero once its reset time has passed.
- **Never show "couldn't get usage" as 0% used.**
- **Never log, print or store tokens.** The reporter sends percentages, not credentials.
- Retry soon after a network failure. Otherwise refresh about every 15 minutes.

## By provider

| Provider | Sign-in it reuses | Where usage comes from | What comes back |
|---|---|---|---|
| **Claude Code** | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (on macOS, the Keychain item `Claude Code-credentials`) | `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20` | 5-hour and 7-day windows plus any model-specific window, each with `utilization` and `resets_at`. The plan tier is in the CLI profile (`oauthAccount`) or the credentials. |
| **Codex** | `~/.codex/auth.json` (`CODEX_HOME`) | Starts `codex app-server` and sends JSON-RPC: `initialize`, then `account/rateLimits/read` (`account/read` as a fallback for the plan). This is Codex's own interface, which makes it the most stable option. | `rateLimitsByLimitId` (or the older `rateLimits`): primary and secondary windows with used % and reset time, a spend cap if there is one, and the plan. An API-key login has no plan limits. |
| **Cursor** | Cursor CLI's `auth.json`, or the editor's `state.vscdb` | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/<Method>` with a Bearer token: `GetCurrentPeriodUsage`, `GetPlanInfo`, `GetAggregatedUsageEvents` | Included total for the period, auto and named-model meters, on-demand spend, and tokens by model per day |
| **Grok Bot** | The Cursor sign-in | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus` | Weekly included usage |
| **Grok (CLI)** | Grok's `auth.json` | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, and `/v1/billing` for the monthly quota | Billing-period credits and monthly quota |
| **Antigravity (`agy`)** | The keyring, or `~/.gemini/antigravity-cli/antigravity-oauth-token` | `https://daily-cloudcode-pa.googleapis.com` `v1internal:loadCodeAssist` (plan), then `v1internal:retrieveUserQuotaSummary` | 5-hour and weekly windows, plus any Claude or GPT allowance |
| **Gemini CLI** | `~/.gemini/oauth_creds.json` (to check) | Probably the same Cloud Code API as agy. Omarchy has no Gemini CLI collector, so this needs testing. | To check |
| **Local models** (Studio MLX/Ollama, Spark) | none | Nothing to meter. Count tokens from logs if wanted. | n/a |

## Risks

- **The Claude, Cursor, Grok and Cloud Code endpoints aren't documented public APIs.** They're what the providers' own tools call, so they can change without notice. Keep each one behind its own adapter so one breaking doesn't take down the rest.
- Cloudroom has a Claude fallback that sends a tiny message pretending to be Claude Code and reads the rate-limit headers. **Don't copy that.** Use the usage endpoint.
- Some logins live in OS keyrings (macOS Keychain, Linux Secret Service), so each platform needs its own code to read them.

## Shape for the plan

- One adapter per provider with the same interface: `detect()` (is this agent here and signed in?), `readUsage()` (windows: label, used %, resets at, stale, message), `plan()`. Cloudroom's `gui/plugins/provider-usage/usage-source-contract.ts` is a good model.
- The reporter runs on each machine on a timer, upserts rows into the `subscriptions` and `usage_windows` tables, and marks them stale on failure.
- Omarchy users get a shortcut: read `~/.local/state/omarchy/agents/usage/*.json` directly. That's only an optimisation, not the main path.
