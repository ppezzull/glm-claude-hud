# glm-claude-hud

**Show your GLM Coding Plan token usage inside the [claude-hud](https://github.com/jarrodwatts/claude-hud) statusline for Claude Code.**

```
[glm-5.3] │ CraftLead git:(main*) │ noble-jingling-anchor │ ⏱️ 1013h 27m
Context ██████░░░░ 63% │ Usage ███████░░░ 65% (resets in 4h 58m)
2 CLAUDE.md | 11 MCPs | 4 hooks
```

If you use Claude Code with the **GLM Coding Plan** (Z.ai / Zhipu bigmodel), the
Anthropic-style `rate_limits` data that claude-hud normally displays is never
populated — so the `Usage` bar is missing. This wrapper fixes that.

## How it works

```
Claude Code ──stdin JSON──▶ glm-wrapper.ts ──▶ claude-hud ──▶ statusline
                               │
                               └─ fetches GLM quota from the Zhipu monitoring API
                                  (cached at ~/.cache/zhipu-usage.json, 60s TTL)
```

`glm-wrapper.ts` sits between Claude Code and claude-hud:

1. Reads the statusline JSON Claude Code pipes to stdin.
2. Fetches your plan quota (`TOKENS_LIMIT` for the 5-hour window and weekly
   window) from the Zhipu monitoring API, using the `Authorization` header from
   your `ANTHROPIC_AUTH_TOKEN`.
3. Injects it into the payload as `rate_limits.five_hour` / `rate_limits.seven_day`
   — the exact format claude-hud already knows how to render.
4. Spawns claude-hud and pipes the enriched JSON through to it.

### Reliability features

- **Cold-start sync fetch** — the very first statusline render of a session
  fetches quota synchronously (~300ms once), so `Usage` is visible immediately.
- **Background refresh** — after that, quota is refreshed at most every 60s
  without blocking renders.
- **Stale-cache fallback** — if the quota API is unreachable, the last known
  numbers are shown instead of dropping the line.
- **Robust bun resolution** — checks `~/.bun/bin/bun`, `/opt/homebrew/bin/bun`,
  `/usr/local/bin/bun` before falling back to `which bun`. This matters: GUI
  terminals (Warp, Dock-launched apps) often run with a minimal PATH where
  `bun` is not visible, which silently kills the whole statusline.
- **Auto version detection** — always runs the newest installed claude-hud
  version; plugin updates require no config change.

## Requirements

- [Claude Code](https://claude.com/claude-code) configured for the GLM Coding
  Plan (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`)
- The [claude-hud](https://github.com/jarrodwatts/claude-hud) plugin installed
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash` or `brew install bun`)
- `curl` (present on macOS/Linux by default)

## Install

### 1. Install the claude-hud plugin

In Claude Code:

```
/plugin marketplace add jarrodwatts/claude-hud
/plugin install claude-hud
```

### 2. Put the wrapper in place

```bash
mkdir -p ~/.claude/scripts
curl -fsSL https://raw.githubusercontent.com/ppezzull/glm-claude-hud/main/glm-wrapper.ts \
  -o ~/.claude/scripts/glm-wrapper.ts
chmod +x ~/.claude/scripts/glm-wrapper.ts
```

### 3. Point your statusline at the wrapper

Find your bun binary's absolute path:

```bash
command -v bun   # e.g. /opt/homebrew/bin/bun or ~/.bun/bin/bun
```

Edit `~/.claude/settings.json` and set (merge into existing settings, don't
replace the file):

```json
{
  "statusLine": {
    "type": "command",
    "command": "/opt/homebrew/bin/bun \"$HOME/.claude/scripts/glm-wrapper.ts\""
  }
}
```

> **Use the absolute bun path**, not `#!/usr/bin/env bun` alone. If Claude Code
> is launched from a terminal with a minimal PATH (Warp, Dock-launched apps),
> the shebang fails silently and Claude Code falls back to its built-in
> statusline with no Usage bar.

### 4. Verify

```bash
echo '{"model":{"display_name":"test"}}' | /opt/homebrew/bin/bun ~/.claude/scripts/glm-wrapper.ts
```

You should see a rendered HUD containing a `Usage …%` line. Then restart any
open Claude Code sessions (the statusline command is captured at session
start).

## Configuration

The wrapper needs no configuration of its own. It reads from your Claude Code
environment:

| Variable | Used for |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | `Authorization` header for the quota API |
| `ANTHROPIC_BASE_URL` | Derives the monitoring endpoint (`api.z.ai` → `https://api.z.ai/api/monitor/usage/quota/limit`), with `open.bigmodel.cn` as fallback |

### Debugging

Set `GLM_HUD_DEBUG=1` in the statusline environment to append diagnostics to
`~/.cache/zhipu-hud-debug.log`:

```json
"command": "GLM_HUD_DEBUG=1 /opt/homebrew/bin/bun \"$HOME/.claude/scripts/glm-wrapper.ts\""
```

Then check `tail -f ~/.cache/zhipu-hud-debug.log` while the statusline renders.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Usage line never shows in some terminals (e.g. Warp) but works in others | The statusline command was launched with a minimal `PATH`. Make sure the `statusLine.command` uses the **absolute** bun path (see install step 3) and restart the session. |
| Usage missing on the first render of a session | You're on an old version of the wrapper — it now fetches synchronously on cold start. Re-download it. |
| Usage shows stale percentages | Check the quota cache: `cat ~/.cache/zhipu-usage.json`. If the timestamp is old, the API may be down; stale data is used as a fallback by design. |
| No statusline at all | claude-hud not installed, or bun missing. Run the verify command from install step 4 and check the error. |
| Only the 5h bar, no weekly bar | Your plan's API response only includes the 5-hour `TOKENS_LIMIT` — the wrapper only displays what the API returns. |
| Statusline shows but no `[model]` tag / different format | That's Claude Code's **native fallback** statusline — your custom command failed. Run the verify command to see why. |

## Extending the HUD further

The wrapper is a small, dependency-free TypeScript file — fork away. Useful
hooks:

- **Inject other data**: anything you add to the stdin JSON before piping it to
  claude-hud is available to claude-hud's renderers. The quota injection in the
  `// Inject Zhipu API quota data` block is the template.
- **Other providers**: replace `quotaEndpoints()` and the field mapping in the
  injection block with your provider's usage API; keep the
  `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` output shape
  and claude-hud renders it as-is.
- **Other claude-hud config dirs**: `CLAUDE_CONFIG_DIR` is respected when
  locating the plugin (`findClaudeHudDir`).
- **claude-hud display options**: claude-hud itself supports config (compact
  mode, usage threshold, bars on/off) — see the
  [claude-hud README](https://github.com/jarrodwatts/claude-hud).

## Credits & license

- Fork concept originally from [hxuaj/glm-claude-hud](https://github.com/hxuaj/glm-claude-hud)
- Statusline rendering by [claude-hud](https://github.com/jarrodwatts/claude-hud)

MIT — see [LICENSE](LICENSE).
