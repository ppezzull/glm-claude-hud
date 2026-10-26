#!/usr/bin/env bun
/**
 * glm-wrapper.ts — GLM Usage Wrapper for claude-hud
 *
 * Sits between Claude Code and the claude-hud statusline plugin. It reads the
 * JSON that Claude Code pipes in, injects Zhipu AI (GLM Coding Plan) quota
 * data from the monitoring API, then hands everything to claude-hud for
 * rendering — so the HUD shows real GLM token usage percentages.
 *
 * Behavior:
 *   - Quota data is cached at ~/.cache/zhipu-usage.json (60s TTL).
 *   - Expired cache is refreshed in the background (non-blocking).
 *   - On a cold start (no usable cache) it fetches synchronously so the Usage
 *     line is present on the very first statusline render.
 *   - If the quota API is unreachable, stale cached data is used rather than
 *     dropping the Usage line entirely.
 *
 * Based on hxuaj/glm-claude-hud, with the following improvements:
 *   1. Quota endpoint auto-detect — derives the monitor URL from
 *      ANTHROPIC_BASE_URL (works with api.z.ai), falls back to open.bigmodel.cn.
 *   2. Robust bun resolution — checks well-known absolute paths first, so the
 *      statusline still works in environments with a minimal PATH (Warp, GUI
 *      launchers, cron...).
 *   3. claude-hud entry — prefers src/index.ts, falls back to dist/index.js.
 *   4. Cold-start sync fetch + stale-cache fallback (see Behavior above).
 *
 * Debug: set GLM_HUD_DEBUG=1 to append diagnostics to
 * ~/.cache/zhipu-hud-debug.log.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, appendFileSync, openSync, readSync, closeSync } from "node:fs";
import { spawn, execSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CACHE_PATH = join(homedir(), ".cache", "zhipu-usage.json");
const CACHE_TTL = 60_000; // 60 seconds
const DEBUG_LOG = join(homedir(), ".cache", "zhipu-hud-debug.log");

function debug(msg: string) {
  if (process.env.GLM_HUD_DEBUG !== "1") return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [pid=${process.pid}] ${msg}\n`);
  } catch {}
}

function ensureCacheDir() {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Build the monitor quota URL from the configured Anthropic base URL, with a fallback. */
function quotaEndpoints(): string[] {
  const base = (process.env.ANTHROPIC_BASE_URL || "").trim();
  const urls: string[] = [];
  if (base) {
    // api.z.ai/api/anthropic      -> api.z.ai/api/monitor/usage/quota/limit
    // open.bigmodel.cn/api/anthropic -> open.bigmodel.cn/api/monitor/usage/quota/limit
    const root = base.replace(/\/anthropic\/?$/, "").replace(/\/$/, "");
    if (root) urls.push(`${root}/api/monitor/usage/quota/limit`);
  }
  urls.push("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  // de-dup, preserve order
  return Array.from(new Set(urls));
}

function refreshCacheBackground() {
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!token) return;
  ensureCacheDir();
  try {
    const child = spawn(
      "bash",
      [
        "-c",
        quotaEndpoints()
          .map(
            (url) =>
              `curl -sf --max-time 5 -H "Authorization: ${token}" "${url}" -o "${CACHE_PATH}" && grep -q '"code":200' "${CACHE_PATH}" && exit 0`
          )
          .join(" || ") + " || true",
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch {}
}

function readCache(): any[] | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, "utf8");
    const resp = JSON.parse(raw);
    // Use stale cache as fallback rather than dropping it — a failed/slow
    // background refresh should never blank out the GLM usage line entirely.
    if (resp.code === 200 && resp.data?.limits) return resp.data.limits;
  } catch {}
  return null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (!done) { done = true; resolve(data); }
    };
    const timer = setTimeout(finish, 250);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => { data += c; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function findClaudeHudDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const base = join(configDir, "plugins/cache/claude-hud/claude-hud");
  try {
    if (!existsSync(base)) return "";
    const versions = readdirSync(base)
      .filter((name) => {
        const p = join(base, name);
        return statSync(p).isDirectory() && /^\d+\.\d+\.\d+$/.test(name);
      })
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      });
    if (versions.length === 0) return "";
    return join(base, versions[versions.length - 1]) + "/";
  } catch { return ""; }
}

/**
 * Resolve the bun binary. Well-known absolute paths are checked first because
 * the statusline may run in environments with a minimal PATH (e.g. Warp or
 * other GUI-launched terminals) where `bun` is not on PATH.
 */
function findBun(): string {
  const candidates = [
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  } catch {
    return "bun";
  }
}

// ─── Contribution 3 (from nebula fleet wrapper, 2026-10-09): context_window synthesis ───
// On proxied model ids (GLM via Z.AI) Claude Code cannot size the context window,
// so it omits stdin.context_window and claude-hud renders no Context line at all.
// These two helpers synthesize it from the session transcript.

/** Context window for the current model: env override > "[1m]" suffix > 200k. */
function contextWindowFor(modelId: string): number {
  const fromEnv = Number(process.env.GLM_HUD_CONTEXT_WINDOW);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (/\[1m\]/i.test(modelId)) return 1_000_000;
  return 200_000;
}

/**
 * Last usage block from the session transcript, or null. Reads only the tail
 * of the file (256k) so large sessions stay cheap; malformed lines are skipped.
 */
function lastTranscriptUsage(
  transcriptPath: unknown
): { input: number; output: number; cacheCreation: number; cacheRead: number } | null {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return null;
  try {
    const TAIL = 256 * 1024;
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(transcriptPath, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.includes("\"usage\"")) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const u = entry?.message?.usage ?? entry?.usage;
      if (!u) continue;
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const cacheCreation = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      if (input + output + cacheCreation + cacheRead === 0) continue;
      return { input, output, cacheCreation, cacheRead };
    }
  } catch {}
  return null;
}

// ─── Contribution 1: inter-session seat name next to the project/user segment ───
// Walks the ancestor chain to the claude TUI process (same match as watchdog.sh),
// then reads that session's bus seat name from the inter-session state file.

function findClaudePid(): number {
  let pid = process.pid;
  for (let hop = 0; hop < 6; hop++) {
    let row = "";
    try {
      row = execSync(`ps -o ppid=,command= -p ${pid}`, { encoding: "utf8", timeout: 1000 });
    } catch { break; }
    const m = row.match(/\s*(\d+)\s+(.*)/);
    if (!m) break;
    const ppid = Number(m[1]);
    const cmd = m[2];
    if (/(^|\/)claude( |$)/.test(cmd) && !/mcp|daemon|helper|bg-|attach|npm|node/.test(cmd)) return pid;
    if (ppid <= 1) break;
    pid = ppid;
  }
  return 0;
}

function seatState(pid: number): { name?: string; listener_pid?: number } | null {
  const dir = join(homedir(), ".claude/data/inter-session/clients");
  const candidates = [join(dir, `${pid}.session`)];
  // Linux fleet boxes run persistent seats with INTER_SESSION_PPID_OVERRIDE
  // (state keyed to ppid 1, not the claude pid) — fall back to any live state.
  try {
    for (const e of readdirSync(dir)) {
      if (e.endsWith(".session")) candidates.push(join(dir, e));
    }
  } catch { /* dir missing */ }
  for (const f of candidates) {
    try {
      const st = JSON.parse(readFileSync(f, "utf8"));
      const lpid = Number(st.listener_pid || 0);
      if (st.name && lpid) {
        try { process.kill(lpid, 0); return st; } catch { /* stale */ }
      }
    } catch { /* unreadable */ }
  }
  return null;
}

function seatName(): string {
  const pid = findClaudePid();
  if (!pid) return "";
  try {
    const st = seatState(pid);
    if (!st) return "";
    // Hide watchdog-assigned auto names (seat-<pid>): only show real seats
    const name = String(st.name);
    return /^seat-\d+$/.test(name) ? "" : name;
  } catch { return ""; }
}

// ─── Contribution 2: context color scale (research-based thresholds) ───
// claude-hud colors the context with a flat 3-level scale and buffers the shown
// percent against the autocompact point (raw/(autocompact%)). We recolor bar,
// percent and transcript size on the Context line using the SHOWN percent so
// color and number always agree.
//
// Thresholds on the shown percent (100% = autocompact fires; with the default
// 80% autocompact this equals raw/0.8):
//   green  < 50  → raw < 40%  — safe zone: below the 30–40% band where the
//                             RULER benchmark sees "effective context" break
//                             down vs the claimed window
//   yellow 50–70 → raw 40–56% — watch
//   orange 70–85 → raw 56–68% — degradation zone ("lost in the middle",
//                             context rot grows with input length)
//   red    85–95 → raw 68–76% — approaching/past Claude Code's ~75% compaction
//                             trigger; quality and cost both degrade
//   violet ≥ 95  → compaction imminent/overdue — act now (/compact or restart)
//
// Research: arxiv.org/abs/2307.03172 (Lost in the Middle), NVIDIA RULER
// (arxiv.org/abs/2404.06654), Chroma "Context Rot" (trychroma.com/research/context-rot).

const HUD_RESET = "\x1b[0m";
const CONTEXT_COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[31m",
  violet: "\x1b[35m",
} as const;

function contextColor(shownPct: number): string {
  if (shownPct >= 95) return CONTEXT_COLORS.violet;
  if (shownPct >= 85) return CONTEXT_COLORS.red;
  if (shownPct >= 70) return CONTEXT_COLORS.orange;
  if (shownPct >= 50) return CONTEXT_COLORS.yellow;
  return CONTEXT_COLORS.green;
}

/** Post-process claude-hud output: seat name on line 1, context color scale. */
function postprocess(out: string, stdin: any): string {
  const lines = out.split("\n");

  // Seat name at the RIGHT END of the counts row, same grey as its items:
  //   "1 CLAUDE.md | 5 MCPs | 4 hooks | pezbrain"
  const seat = seatName();
  if (seat) {
    const countsIdx = lines.findIndex((l) => l.includes("CLAUDE.md") && l.includes("MCPs"));
    if (countsIdx >= 0 && !lines[countsIdx].includes(seat)) {
      lines[countsIdx] += `\x1b[2m | ${seat}\x1b[0m`;
    }
  }

  // Context color scale: recolor bar + percent + transcript size on the Context line
  const ci = lines.findIndex((l) => l.includes("Context") && l.includes("%"));
  if (ci >= 0) {
    const pm = lines[ci].match(/\x1b\[(?:31|32|33)m(\d{1,3})%/);
    if (pm) {
      const c = contextColor(Number(pm[1]));
      lines[ci] = lines[ci]
        .replace(/\x1b\[(?:31|32|33)m(█+)/, `${c}$1`)
        .replace(/\x1b\[(?:31|32|33)m(\d{1,3}%)/, `${c}$1`)
        .replace(/\x1b\[2m( · [\d.]+[KMGT]?B)/, `${c}$1`);
    }
  }
  return lines.join("\n");
}

(async () => {
  const raw = (await readStdin()).trim();
  if (!raw) return;

  let stdin: any;
  try { stdin = JSON.parse(raw); } catch { return; }

  // Refresh cache in background when expired (non-blocking)
  try {
    if (!existsSync(CACHE_PATH) || Date.now() - statSync(CACHE_PATH).mtimeMs > CACHE_TTL) {
      refreshCacheBackground();
    }
  } catch {}

  // If there is no usable cached data (e.g. first render of a session),
  // fetch synchronously so the Usage line shows immediately instead of
  // appearing only after the background refresh lands (~60s later).
  if (!readCache()) {
    debug("cold start: no usable cache, fetching synchronously");
    const token = process.env.ANTHROPIC_AUTH_TOKEN;
    if (token) {
      ensureCacheDir();
      for (const url of quotaEndpoints()) {
        try {
          execSync(
            `curl -sf --max-time 3 -H "Authorization: ${token}" "${url}" -o "${CACHE_PATH}"`,
            { timeout: 4000 }
          );
          if (readCache()) { debug(`sync fetch ok via ${url}`); break; }
        } catch (e: any) { debug(`sync fetch failed via ${url}: ${e?.message ?? e}`); }
      }
    }
  }

  // Inject Zhipu API quota data
  // The API returns 3 quota types:
  //   TOKENS_LIMIT (unit=3, number=5) -> 5-hour rolling window, resets in ~hours
  //   TOKENS_LIMIT (unit=6, number=1) -> weekly, resets in ~7 days
  //   TIME_LIMIT   (unit=5, number=1) -> monthly, resets in ~30 days (not displayed)
  const limits = readCache();
  if (limits) {
    const fiveHour = limits.find(
      (l: any) => l.type === "TOKENS_LIMIT" && l.unit === 3 && l.number === 5
    );
    const weekly = limits.find(
      (l: any) => l.type === "TOKENS_LIMIT" && l.unit === 6 && l.number === 1
    );

    stdin.rate_limits = {};
    if (fiveHour) {
      stdin.rate_limits.five_hour = {
        used_percentage: fiveHour.percentage,
        resets_at: Math.floor(fiveHour.nextResetTime / 1000),
      };
    }
    if (weekly) {
      stdin.rate_limits.seven_day = {
        used_percentage: weekly.percentage,
        resets_at: Math.floor(weekly.nextResetTime / 1000),
      };
    }
  }

  // Synthesize context_window when Claude Code omits it (proxied model ids like
  // glm-5.3): fill level from the transcript's last usage block, window size from
  // the "[1m]" model suffix or GLM_HUD_CONTEXT_WINDOW (default 200k). Without
  // this the Context line (and the new color scale) never renders on GLM setups.
  if (!stdin.context_window || !(stdin.context_window.context_window_size > 0)) {
    const usage = lastTranscriptUsage(stdin.transcript_path);
    const win = contextWindowFor(
      [stdin.model?.id, stdin.model?.display_name].filter(Boolean).join(" ")
    );
    if (usage) {
      const used = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
      if (used > 0) {
        const pct = Math.round((used / win) * 100);
        stdin.context_window = {
          context_window_size: win,
          used_percentage: pct,
          remaining_percentage: Math.max(0, 100 - pct),
          current_usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_creation_input_tokens: usage.cacheCreation,
            cache_read_input_tokens: usage.cacheRead,
          },
          total_input_tokens: used,
        };
      }
    }
  }

  // Find and run claude-hud
  const pluginDir = findClaudeHudDir();
  if (!pluginDir) return;

  // Entry point: prefer bun-runnable TS source, fall back to compiled bundle.
  const tsEntry = join(pluginDir, "src/index.ts");
  const jsEntry = join(pluginDir, "dist/index.js");
  const entry = existsSync(tsEntry) ? tsEntry : existsSync(jsEntry) ? jsEntry : "";
  if (!entry) return;

  // Set COLUMNS so claude-hud detects terminal width correctly
  const childEnv = { ...(process.env as Record<string, string>) };
  if (!childEnv.COLUMNS) {
    try {
      childEnv.COLUMNS = execSync("tput cols 2>/dev/null", {
        encoding: "utf8", timeout: 1000,
      }).trim() || "200";
    } catch { childEnv.COLUMNS = "200"; }
  }

  const child = spawn(
    findBun(),
    ["--env-file", "/dev/null", entry],
    { env: childEnv, stdio: ["pipe", "pipe", "pipe"] }
  );

  const timeout = setTimeout(() => { child.kill(); }, 3000);

  child.stdin.write(JSON.stringify(stdin));
  child.stdin.end();

  let output = "";
  child.stdout.on("data", (c: Buffer) => { output += c.toString(); });
  child.stdout.on("end", () => {
    clearTimeout(timeout);
    if (output) process.stdout.write(postprocess(output, stdin));
  });
  child.on("error", () => { clearTimeout(timeout); });
})();
