<p>
  <img src="media/logo.png" alt="AI Quota" width="480">
</p>

# AI Quota for VS Code

**Know which AI you can use next. Before you hit the limit.**

Track remaining quota and reset times for **Claude, ChatGPT / Codex,
Antigravity, GitHub Copilot, OpenCode Go, and Freebuff** without leaving your
editor. One dashboard. Six providers. No more checking six separate usage pages.

[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-aiquota)
&middot; [View on GitHub](https://github.com/kasuken/vscode-aiquota)
&middot; [Report an issue](https://github.com/kasuken/vscode-aiquota/issues)

![AI Quota in VS Code: sidebar and dashboard showing remaining quota, reset times, and a status bar with four of six providers available.](media/screenshot.png)

*Actual extension UI with clearly labeled sample accounts, not personal usage data.
The dashboard, sidebar, and status bar share the same capacity overview.*

## Stay in flow, not in usage pages

You are deep in a task. Claude is running low. Codex still has room. Your next
reset is two hours away. AI Quota makes that visible before an unexpected limit
interrupts your work.

- **See your options at a glance.** Remaining percentages and the next confirmed
  reset, with separate allowances where providers report them.
- **Keep quota where you work.** Open the full dashboard, leave the activity bar
  sidebar visible, or glance at the compact status bar.
- **Know what needs attention.** Spot low allowances, expired sessions, and
  disconnected providers without mistaking stale data for available capacity.
- **Use the logins you already have.** Reads supported CLI sessions; Copilot can
  also use your VS Code GitHub session. No API keys to paste into settings.
- **Make it yours.** Select only the providers you use, choose their order, and
  adjust automatic refresh. The interface follows your VS Code theme.

**Free, MIT-licensed, and open source. No analytics or telemetry.**

## Get started

1. **Install [AI Quota](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-aiquota)**
   from the VS Code Marketplace.
2. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on
   macOS) and run **AI Quota: Select Providers**.
3. Sign in through your providers' existing CLIs, then run
   **AI Quota: Open Dashboard**.
   For Copilot, you can also run **AI Quota: Sign In to GitHub**.
   For Antigravity, run `agy`, sign in, and use `/usage` once.

Click the **AI Quota activity bar icon** to open the sidebar, or click the
**status bar indicator** to open the dashboard. Checks refresh every five
minutes by default; use **AI Quota: Refresh** whenever you need a fresh check.

Nothing is read or queried until you choose a provider.

Prefer a terminal? Install with:

```shell
code --install-extension emanuelebartolesi.vscode-aiquota
```

Requires VS Code **1.100+**. You can also install a packaged `.vsix` with
**Extensions: Install from VSIX**.

## Provider support

| Provider | Credential source | Quota windows |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json`, or macOS Keychain | Five-hour and weekly |
| ChatGPT / Codex | `~/.codex/auth.json` with ChatGPT authentication | Primary and secondary rate limits |
| Antigravity | CLI's saved OS-keyring session or token file; legacy IDE's local service as fallback | CLI quota groups and their five-hour/weekly windows; per-model quotas from the legacy IDE |
| GitHub Copilot | VS Code GitHub session, or Copilot CLI `apps.json` / `hosts.json` | Finite premium and chat quotas |
| OpenCode Go | `~/.local/share/opencode/auth.json`, `opencode-go` entry | Rolling, weekly, monthly |
| Freebuff | `~/.config/manicode/credentials.json` | Daily Freebucks |

`~` means your home directory on every platform, including Windows. Claude
and Codex respect `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. XDG config/data
locations and Copilot's Windows `LOCALAPPDATA` location are supported.
Use `aiquota.credentialPaths` in **user settings** for other absolute paths.
Do not put tokens in settings. Workspace credential-path overrides are ignored.

Only flat-rate subscriptions are tracked, not pay-per-token API keys or
OpenCode Zen. Antigravity is **not Gemini CLI**; AI Quota does not read
`~/.gemini/oauth_creds.json` or use Gemini CLI's quota endpoints.

These are unofficial provider APIs and can change. A successful response with
no finite Copilot quotas is shown as such, not as an invented percentage.

### Antigravity setup and limitations

<details>
<summary>CLI setup, credential locations, and legacy IDE fallback</summary>

Select `antigravity` in **AI Quota: Select Providers**. Run **`agy`**, sign in,
and use **`/usage`** to refresh the CLI's saved session. Then refresh AI Quota.
The CLI does not need to expose an IDE language server, and multiple running
CLI sessions do not prevent detection.

The CLI reader uses its existing **OS keyring first**: Windows Credential Manager
(`gemini:antigravity`), macOS Keychain (service `gemini`, account `antigravity`),
or Linux Secret Service through `secret-tool`. Windows only calls the native
credential read/free APIs; it never creates, updates, or deletes credentials.

If no keyring entry exists, it reads
`~/.gemini/antigravity-cli/antigravity-oauth-token`, respecting `AGY_DIR`.
The keyring takes priority because this fallback file can contain an expired
token while the running CLI uses a fresh keyring entry. A keyring permission
error is reported, not silently hidden. Set `aiquota.credentialPaths.antigravity`
to an absolute token-file path to bypass the keyring explicitly.

The existing access token is sent only to
`https://daily-cloudcode-pa.googleapis.com` to read `loadCodeAssist` and
`retrieveUserQuotaSummary`. Reported quota groups, percentages, five-hour/weekly
windows, reset times, and plan names come from those responses; no model prompts
are sent. The extension never uses refresh tokens or modifies the CLI's login.
If the saved access token expires, run `agy` and `/usage` and refresh AI Quota.
An expired or rejected CLI session is not silently replaced with a different
IDE account. CLI enterprise authentication is not currently supported.

Only when no CLI credentials exist does AI Quota try the legacy IDE's
read-only `GetUserStatus` service. Keep one legacy IDE workspace open; multiple
IDE language servers are treated as ambiguous. This fallback uses PowerShell
and netstat on Windows, ps and lsof on macOS, and ps and ss (or lsof) on Linux.
It only contacts verified language-server ports on `127.0.0.1`.

The legacy IDE service uses a self-signed certificate, so certificate verification
is disabled **only for that fixed loopback fallback**. HTTP-only local services
are retried on the same verified port after a TLS protocol mismatch. CLI Cloud
Code requests use normal HTTPS verification. Redirects are never followed.

These are **unofficial monitoring integrations** and may require updates after
Antigravity releases. Purchased AI-credit balances are not inferred from quota
percentages. Positive remaining-amount-only buckets without a total are not
fabricated as percentages. A protobuf quota with a reset time but an omitted
zero fraction is displayed as exhausted.

Existing `gemini` provider selections migrate to `antigravity` without reusing
Gemini CLI's cached quotas. Remove obsolete `credentialPaths.gemini` overrides;
the Antigravity CLI credential file has a different format and location.

Official documentation:

- [Plans and quota refresh policies](https://antigravity.google/docs/plans)
- [Models and availability](https://antigravity.google/docs/models)
- [Authentication](https://antigravity.google/docs/install)
- [CLI quota panel: /usage and /quota](https://antigravity.google/docs/cli/commands/usage)
- [CLI status-line quota payload](https://antigravity.google/docs/cli/statusline)

The official pages document the product behavior, not the internal monitoring
APIs. CLI quota-summary fields were verified against public integrations in
[Omarchy](https://github.com/omacom/omarchy/blob/master/bin/omarchy-agent-usage-agy)
and [Raycast](https://github.com/raycast/extensions/tree/master/extensions/agent-usage/src/antigravity).
Legacy IDE request and response fields were verified against the public
[Antigravity Quota Watcher implementation](https://github.com/wusimpl/AntigravityQuotaWatcher)
(`src/quotaService.ts`, `src/types.ts`, and process detectors). The client here is
an independent implementation restricted to status reads.

</details>

## Quota you can read, not a made-up score

The status bar shows, for example, **AI Quota 4/6 available** with an attention
count. Hover to see remaining allowances and the next confirmed reset; click
to open the dashboard.

Capacity is **not a universal credit balance**: providers use different units.
Five-hour and weekly windows for one allowance are represented by their tightest
limit, never added together. Independent Antigravity model groups and finite
Copilot chat/premium allowances remain separate. Expired, stale, projected, and
missing values do not count as confirmed capacity. Unquantified or potentially
unlimited usage is labeled rather than converted into a percentage.

## Your credentials stay yours

AI Quota reads existing sessions and sends quota requests to the selected
providers. It does not proxy your credentials through an AI Quota server.
Tokens are never cached, logged, or passed to the dashboard.

<details>
<summary>Privacy, caching, network behavior, and data freshness</summary>

- Checks run every five minutes by default, with an eight-second request timeout.
- Failed requests retain the last successful values, marked `~` (approximate).
- A passed reset is projected as `~100%` until a successful check confirms usage.
- Values older than twelve refresh intervals are also marked approximate.
- Selected providers' normalized quota values are cached in VS Code's local
  extension storage. Tokens are never cached, logged, or passed to webviews.
- CLI credentials are read-only: no token refresh, rotation, or writes.
- External requests use HTTPS and a fixed provider-host allowlist, including
  Antigravity CLI's Cloud Code quota service. Legacy IDE status calls remain on
  loopback. All requests reject redirects.
- No analytics or telemetry is collected by this extension.

The extension runs locally even in remote workspaces. It reads credentials
from the computer running VS Code, not a remote container or SSH host.

</details>

## Settings and commands

| Command | What it does |
| --- | --- |
| **AI Quota: Open Dashboard** | Open your full capacity overview |
| **AI Quota: Select Providers** | Choose which subscriptions to check |
| **AI Quota: Refresh** | Check selected providers now |
| **AI Quota: Sign In to GitHub** | Connect a GitHub session for Copilot |
| **AI Quota: Open Settings** | Customize refresh, display, and credential paths |
| **AI Quota: Show Logs** | Inspect actionable provider errors without tokens |

Search VS Code settings for `AI Quota`, or start with these **user settings**:

```json
{
  "aiquota.providers": ["claude", "codex", "copilot"],
  "aiquota.refreshIntervalSeconds": 300,
  "aiquota.showStatusBar": true
}
```

Provider IDs are `claude`, `codex`, `antigravity`, `copilot`, `opencode`, and
`freebuff`; their order in the array is their display order.

## FAQ

**Does this increase my quota or switch models for me?**

No. AI Quota is a read-only monitor. It helps you decide what to use next;
it does not change subscription limits, route prompts, or switch providers.

**Why is a provider asking me to sign in again?**

The saved session may have expired. Sign in through that provider's CLI and
refresh AI Quota. For Antigravity, run `agy` and `/usage`. Use
**AI Quota: Show Logs** for details.

**What does `~` mean?**

The value is approximate: it may be cached after a failed check, older than
the freshness window, or projected after a reset. It is not confirmed capacity.

**Does this track API spending?**

No. It tracks supported flat-rate subscriptions, not pay-per-token API keys,
OpenCode Zen, or a combined monetary balance.

**Is this an official provider extension?**

No. AI Quota is an independent project, not affiliated with or endorsed by the
listed providers. Unofficial quota APIs can change; please report broken
integrations with provider names and sanitized logs, never credentials.

## Help make quota checking one less distraction

If AI Quota saves you a trip to a usage page:

- [Star the project on GitHub](https://github.com/kasuken/vscode-aiquota) so other
  developers can find it.
- [Leave an honest Marketplace review](https://marketplace.visualstudio.com/items?itemName=emanuelebartolesi.vscode-aiquota&ssr=false#review-details).
- Share it with the teammate juggling AI subscriptions.
- [Report a bug or suggest an improvement](https://github.com/kasuken/vscode-aiquota/issues).
  Include your OS, VS Code version, provider, and sanitized error message.
  Never attach credential files or tokens.

Contributions are welcome. For a new provider integration, open an issue first
to discuss authentication and which quota information can be read safely.

## Development

Requires Node.js 22+ and VS Code 1.100+.

```powershell
npm ci
npm run compile
npm run lint
npm test
npm run test:integration
npm run test:ui
npm run package
```

Press **F5** to launch the extension development host. Integration and UI tests
use isolated profiles and do not change your normal VS Code settings or
credentials. On Windows they use the standard per-user VS Code installation;
set `VSCODE_EXECUTABLE_PATH` for another location or platform.

The UI test launches actual VS Code with Playwright, checks the real extension
webview, and saves wide/narrow screenshots in `.test-data`. Its clearly labeled
sample data is only injectable in extension development/test mode and is never
written to the production quota cache. Set `AIQUOTA_UI_EMPTY=1` to exercise the
empty state or `AIQUOTA_UI_THEME="Default Light Modern"` for the light theme.
Set `AIQUOTA_UI_CAPACITY_EDGES=1` to exercise shared exhausted limits, independent
model pools, stale values, unquantified usage, and sub-one-percent allowances.
For an explicitly opted-in live CLI check, set `AIQUOTA_UI_LIVE_CLI=1` before
running `npm run test:ui`. This reads your saved CLI session and real quota;
normal UI tests use fixtures and integration tests use a missing-file override
so they never read your OS keyring.

### Brand assets and screenshots

- [Extension icon](media/icon.png) (256 x 256 PNG; [SVG source](media/icon.svg)).
- [Logo](media/logo.png) (1520 x 400 PNG; [SVG source](media/logo.svg)).
- [Social sharing image](media/social.png) (1280 x 640 PNG; [SVG source](media/social.svg)).
- [README screenshot](media/screenshot.png): actual VS Code UI using the
  development-only sample accounts.

To refresh the README screenshot, run `npm run test:ui` and copy
`.test-data/dashboard-dark-sidebar.png` to `media/screenshot.png`. Keep the sample
data notice visible; do not use personal account data in public screenshots.

Use the PNG logo in documentation and the PNG sharing image for social posts.
The SVG sources are available for editing. To regenerate PNG branding exports,
run `npm run branding` (requires Playwright's Chromium:
`npx playwright install chromium`).

## License

[MIT](LICENSE). See [third-party notices](THIRD-PARTY-NOTICES) for acknowledgments.