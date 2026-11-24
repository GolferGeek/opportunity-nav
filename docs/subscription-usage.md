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
| **Cursor** | cursor-agent's sign-in: the OS secret store (Linux Secret Service `cursor-credentials`/`cursor-user` when `auth.json` says `storedIn: os-secret-store`; macOS Keychain `cursor-access-token`/`cursor-user`), else the editor's `state.vscdb` | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/<Method>` with a Bearer token: `GetCurrentPeriodUsage`, `GetPlanInfo`, `GetAggregatedUsageEvents` | Included total for the period, auto and named-model meters, on-demand spend, and tokens by model per day |
| **Grok Bot** | On macOS, the Grok Bot app's own sign-in (`sand-secrets.json`, decrypted with the Keychain item `Grok Bot Safe Storage`, which needs one Always Allow); otherwise the Cursor sign-in | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus` | Weekly included usage |
| **Grok (CLI)** | Grok's `auth.json` | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, and `/v1/billing` for the monthly quota | Billing-period credits and monthly quota |
| **Antigravity (`agy`)** | The keyring, or `~/.gemini/antigravity-cli/antigravity-oauth-token` | `https://daily-cloudcode-pa.googleapis.com` `v1internal:loadCodeAssist` (plan), then `v1internal:retrieveUserQuotaSummary` | 5-hour and weekly windows, plus any Claude or GPT allowance |
| **Local models** (Studio MLX/Ollama, Spark) | none | Nothing to meter. Count tokens from logs if wanted. | n/a |

Gemini CLI isn't read any more: personal Google accounts moved to Antigravity (`agy`).

Antigravity's answer is a list of groups (`<group>:<bucket>` in window ids). A group named Gemini holds the plan's own 5-hour and weekly limits; "Claude and GPT models" (`3p-5h`, `3p-weekly`) limits only those models.
As of 2026-11-23 Google sends Matt's account no Gemini group at all, only the Claude and GPT one (checked on the Studio and Omarchy).
Omarchy's gauge then shows that first group as "Session" and "Weekly"; Opportunity Nav doesn't pretend it's Gemini.
The card leads with Gemini rows when Google sends them, hides the Claude and GPT rows while they're unused, and says when there's no Gemini limit.
The review picker counts a Gemini reading when there is one; only with none does Antigravity count as half left.

### One card per account

Each card is keyed on the account itself (its id or email), never on a sign-in, so every machine signed in to the same account reports the same card.
Antigravity often saves no id_token, only `id_token_email` beside the token; the helper keys on that email.
When an adapter learns the account only from a reading (Grok, or Antigravity without an email), the helper remembers it per sign-in (`~/.local/state/opnav/usage/identity-*.json`, a hash of the sign-in, never the sign-in) so a later stale reading keeps the same key.
A report can name older keys (`aliases`); the server folds those cards into this one. A folded card is hidden and points at the survivor (`merged_into`), so reports from older helpers still land on the right card. Nothing is deleted.
To fold a duplicate by hand: `node --env-file=~/.config/opportunity-nav/server.env apps/server/src/admin.ts merge-usage --from <id> --into <id>`.

The card's windows are shared by everyone on the account, but each machine's own last poll (its status and time) is kept too.
The review picker judges a machine by its own poll: one whose last poll needs a sign-in never gets a review, and one whose own reading is old ranks as not current, even when another machine on the account has a healthy reading.

## Risks

- **The Claude, Cursor, Grok and Cloud Code endpoints aren't documented public APIs.** They're what the providers' own tools call, so they can change without notice. Keep each one behind its own adapter so one breaking doesn't take down the rest.
- Cloudroom has a Claude fallback that sends a tiny message pretending to be Claude Code and reads the rate-limit headers. **Don't copy that.** Use the usage endpoint.
- Some logins live in OS keyrings (macOS Keychain, Linux Secret Service), so each platform needs its own code to read them.

## Shape for the plan

- One adapter per provider with the same interface: `detect()` (is this agent here and signed in?), `readUsage()` (windows: label, used %, resets at, stale, message), `plan()`. Cloudroom's `gui/plugins/provider-usage/usage-source-contract.ts` is a good model.
- The reporter runs on each machine on a timer, upserts rows into the `subscriptions` and `usage_windows` tables, and marks them stale on failure.
- Omarchy users get a shortcut: read `~/.local/state/omarchy/agents/usage/*.json` directly. That's only an optimisation, not the main path.
