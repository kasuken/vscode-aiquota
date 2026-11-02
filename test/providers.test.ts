import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialFiles, loadCredential, parseCredential } from "../src/credentials";
import { capacityStatus, display, mergeFailure, Snapshot, summarizeCapacity } from "../src/model";
import { createRequest, fetchProvider, normalize, ProviderError } from "../src/providers";

const credential = { token: "fixture-token", plan: "Pro" };
const options = { paths: {}, githubToken: async () => undefined };
const reset = "2026-12-01T00:00:00Z";
const noRequest = async (): Promise<never> => { throw new Error("Must not query provider"); };

test("Claude normalizes five-hour and weekly utilization", () => {
  const result = normalize("claude", { five_hour: { utilization: 76, resets_at: reset }, seven_day: { utilization: 12 } }, credential);
  assert.deepEqual(result.windows.map(window => window.remaining), [24, 88]);
  assert.equal(result.windows[0]?.resetsAt, Date.parse(reset));
});
test("Codex preserves plan and converts epoch reset timestamps", () => {
  const result = normalize("codex", { plan_type: "plus_team", rate_limit: {
    primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 9, limit_window_seconds: 604800 }
  } }, credential);
  assert.equal(result.plan, "Plus Team");
  assert.deepEqual(result.windows.map(window => [window.label, window.remaining]), [["5h", 72], ["7d", 91]]);
  assert.equal(result.windows[0]?.resetsAt, 1800000000000);
});
test("metered Codex plans are excluded", () => {
  assert.throws(() => normalize("codex", { plan_type: "usage_based" }, credential), (error: unknown) =>
    error instanceof ProviderError && error.state === "hidden");
});
test("Copilot skips unlimited snapshots and uses date-only resets", () => {
  const result = normalize("copilot", { copilot_plan: "individual", quota_reset_date: "2026-12-01",
    quota_snapshots: { premium_interactions: { percent_remaining: 64 }, chat: { unlimited: true } }
  }, credential);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.remaining, 64);
  assert.equal(result.windows[0]?.resetsAt, Date.parse(reset));
});
test("Copilot no-access accounts are excluded", () => {
  assert.throws(() => normalize("copilot", { access_type_sku: "no_access" }, credential),
    (error: unknown) => error instanceof ProviderError && error.state === "hidden");
});
test("OpenCode Go maps all three windows and clamps quota to 0..100", () => {
  const result = normalize("opencode", { usage: { rolling: { percent: 110 }, weekly: { percent: -10 }, monthly: { percent: 22 } } }, credential);
  assert.deepEqual(result.windows.map(window => window.remaining), [0, 100, 78]);
});
test("Freebuff calculates remaining daily allowance without division by zero", () => {
  assert.equal(normalize("freebuff", { freebucks: { daily: { limit: 200, spent: 40 } } }, credential).windows[0]?.remaining, 80);
  assert.throws(() => normalize("freebuff", { freebucks: { daily: { limit: 0 } } }, credential), ProviderError);
});
test("malformed numeric values never become quota", () => {
  assert.equal(normalize("claude", { five_hour: { utilization: "bad" }, seven_day: { utilization: NaN } }, credential).windows.length, 0);
});
test("API keys and OpenCode Zen credentials are excluded", () => {
  assert.equal(parseCredential("claude", { apiKey: "fixture" }), undefined);
  assert.equal(parseCredential("codex", { auth_mode: "apikey", tokens: { access_token: "fixture" } }), undefined);
  assert.equal(parseCredential("opencode", { opencode: { key: "fixture" } }), undefined);
});
test("Claude recognizes Max tiers and never rewrites credentials", () => {
  const data = { claudeAiOauth: { accessToken: "fixture", subscriptionType: "max", rateLimitTier: "default_max_20x", expiresAt: 123 } };
  assert.equal(parseCredential("claude", data)?.plan, "Max 20x");
  assert.equal(data.claudeAiOauth.accessToken, "fixture");
});
test("unsafe tokens are rejected, including header injection", () => {
  assert.equal(parseCredential("codex", { tokens: { access_token: "token\r\nInjected: true" } }), undefined);
});
test("Copilot reads nested CLI OAuth credentials", () => {
  assert.equal(parseCredential("copilot", { "github.com:client": { oauth_token: "fixture" } })?.token, "fixture");
});
test("credential path resolution honors CLI environment overrides", () => {
  const env = { CODEX_HOME: join("custom", "codex"), XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", LOCALAPPDATA: "local" };
  assert.equal(credentialFiles("codex", env, "home")[0], join("custom", "codex", "auth.json"));
  assert.ok(credentialFiles("copilot", env, "home").includes(join("local", "github-copilot", "apps.json")));
  assert.equal(credentialFiles("opencode", env, "home")[0], join("data", "opencode", "auth.json"));
});
test("credential loader uses configured file and surfaces malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiquota-test-"));
  const file = join(dir, "auth.json");
  try {
    await writeFile(file, JSON.stringify({ tokens: { access_token: "fixture" } }));
    assert.equal((await loadCredential("codex", { ...options, paths: { codex: file } }))?.token, "fixture");
    await writeFile(file, "{broken");
    await assert.rejects(loadCredential("codex", { ...options, paths: { codex: file } }), /JSON format/);
  } finally { await rm(dir, { recursive: true }); }
});
test("no credentials and expired logins never make a network request", async () => {
  const hidden = await fetchProvider("claude", options, noRequest, async () => undefined);
  assert.equal(hidden.state, "hidden");
  const expired = await fetchProvider("claude", options, noRequest, async () => ({ ...credential, expiresAt: 1 }));
  assert.equal(expired.state, "auth");
});
test("missing quota fields surface an error rather than showing full allowance", async () => {
  const result = await fetchProvider("codex", options, async () => ({}), async () => credential);
  assert.equal(result.state, "error");
  assert.match(result.message ?? "", /no recognized/);
});
test("requests use HTTPS, reject redirects, and keep tokens out of URLs", async () => {
  let observed: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.github.com/copilot_internal/user");
    observed = init;
    return new Response('{"ok":true}', { status: 200 });
  };
  await createRequest(1, fetcher)("https://api.github.com/copilot_internal/user", credential.token);
  assert.equal(observed?.redirect, "error");
  assert.equal((observed?.headers as Record<string, string>).Authorization, "Bearer fixture-token");
  await assert.rejects(createRequest(1, fetcher)("https://attacker.example", credential.token), /unrecognized/);
});
test("HTTP auth, rate limits and Go ineligibility have distinct states", async () => {
  for (const [status, url, expected] of [
    [401, "https://api.github.com/copilot_internal/user", "auth"],
    [429, "https://api.github.com/copilot_internal/user", "error"],
    [403, "https://opencode.ai/zen/go/v1/usage", "hidden"]
  ] as const) {
    await assert.rejects(createRequest(1, async () => new Response("", { status }))(url, "fixture"),
      (error: unknown) => error instanceof ProviderError && error.state === expected);
  }
});
test("network failures and malformed responses do not leak provider response content", async () => {
  const url = "https://api.github.com/copilot_internal/user";
  await assert.rejects(createRequest(1, async () => { throw new Error("secret-token"); })(url, "fixture"), /Network request failed/);
  await assert.rejects(createRequest(1, async () => new Response("secret-token"))(url, "fixture"), /Invalid JSON/);
});
test("timeouts abort the network request", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(createRequest(.01, fetcher)("https://api.github.com/copilot_internal/user", "fixture"), /timed out/);
});
const previous: Snapshot = {
  id: "claude", state: "ok", checkedAt: 1000, fetchedAt: 1000, plan: "Pro",
  windows: [{ label: "5h", remaining: 24, resetsAt: 10000 }]
};
test("auth and network failures preserve last known quota and plan", () => {
  const failed: Snapshot = { id: "claude", state: "auth", checkedAt: 2000, windows: [], message: "Expired" };
  const merged = mergeFailure(previous, failed);
  assert.equal(merged.plan, "Pro");
  assert.equal(merged.fetchedAt, 1000);
  assert.equal(display(merged, 300, 2000).windows[0]?.approximate, true);
});
test("hidden subscriptions discard cached quota instead of resurrecting it", () => {
  const hidden: Snapshot = { id: "claude", state: "hidden", checkedAt: 2000, windows: [] };
  assert.equal(mergeFailure(previous, hidden).windows.length, 0);
});
test("passed resets show approximate full quota without mutating cache", () => {
  const projected = display(previous, 300, 10001);
  assert.equal(projected.windows[0]?.remaining, 100);
  assert.equal(projected.windows[0]?.approximate, true);
  assert.equal(previous.windows[0]?.remaining, 24);
});
test("old quota becomes approximate after twelve refresh intervals", () => {
  const row = { ...previous, windows: [{ label: "7d", remaining: 60 }] };
  assert.equal(display(row, 30, 400000).windows[0]?.approximate, true);
});
test("capacity counts providers once and uses the tightest shared window instead of summing percentages", () => {
  const row = display({ ...previous, windows: [{ label: "5h", remaining: 24 }, { label: "7d", remaining: 68 }] }, 300, 2000);
  const summary = summarizeCapacity(["claude"], [row], 2000);
  assert.equal(summary.available, 1);
  assert.deepEqual(summary.entries[0]?.windows.map(window => [window.label, window.remaining]), [["5h", 24]]);
});
test("capacity keeps independent model allowances separate when one is exhausted", () => {
  const row = display({ ...previous, id: "antigravity", windows: [
    { pool: "gemini", label: "Gemini / 5h", remaining: 0 },
    { pool: "gemini", label: "Gemini / 7d", remaining: 30 },
    { pool: "claude", label: "Claude / 5h", remaining: 55 },
    { pool: "claude", label: "Claude / 7d", remaining: 70 }
  ] }, 300, 2000);
  const summary = summarizeCapacity(["antigravity"], [row], 2000);
  assert.equal(summary.available, 1);
  assert.equal(summary.entries[0]?.state, "partial");
  assert.deepEqual(summary.entries[0]?.windows.map(window => window.remaining), [0, 55]);
});
test("auth failures, stale quota, disconnected providers, and pending checks never count as confirmed capacity", () => {
  const rows = [
    display({ ...previous, id: "antigravity", state: "auth" }, 300, 2000),
    display({ ...previous, windows: [{ label: "7d", remaining: 60 }] }, 30, 400000),
    display({ ...previous, id: "codex", state: "error" }, 300, 2000),
    display({ ...previous, id: "opencode", state: "hidden" }, 300, 2000)
  ];
  const summary = summarizeCapacity(["antigravity", "claude", "codex", "opencode", "freebuff"], rows, 400000);
  assert.equal(summary.available, 0);
  assert.equal(summary.attention, 4);
  assert.equal(summary.entries[4]?.reason, "waiting");
  assert.equal(summary.nextReset, undefined);
});
test("a projected reset cannot restore confirmed capacity or contaminate an independent fresh allowance", () => {
  const row = display({ ...previous, windows: [
    { pool: "one", label: "5h", remaining: 0, resetsAt: 3000 },
    { pool: "one", label: "7d", remaining: 80, resetsAt: 20000 },
    { pool: "two", label: "Independent", remaining: 25, resetsAt: 30000 }
  ] }, 300, 4000);
  const summary = summarizeCapacity(["claude"], [row], 4000);
  assert.equal(summary.available, 1);
  assert.equal(summary.entries[0]?.state, "partial");
  assert.equal(summary.entries[0]?.windows[0]?.approximate, true);
  assert.equal(summary.entries[0]?.windows[1]?.approximate, false);
  assert.equal(summarizeCapacity(["claude"], [{ ...row, windows: row.windows.slice(0, 2) }], 4000).available, 0);
});
test("capacity distinguishes exhausted limits from unreported quotas and preserves small positive allowances", () => {
  const rows = [
    display({ ...previous, windows: [{ label: "5h", remaining: 0 }] }, 300, 2000),
    display({ ...previous, id: "copilot", windows: [] }, 300, 2000),
    display({ ...previous, id: "freebuff", windows: [{ label: "Day", remaining: .4 }] }, 300, 2000)
  ];
  const summary = summarizeCapacity(["claude", "copilot", "freebuff"], rows, 2000);
  assert.deepEqual(summary.entries.map(entry => entry.state), ["exhausted", "unknown", "available"]);
  assert.equal(summary.available, 1);
  assert.equal(summary.attention, 0);
  assert.deepEqual(summarizeCapacity([], rows, 2000), { entries: [], available: 0, attention: 0, nextReset: undefined });
});
test("next reset uses only selected, fresh windows and ignores earlier failed or projected values", () => {
  const rows = [
    display({ ...previous, windows: [{ label: "5h", remaining: 0, resetsAt: 5000 }, { label: "7d", remaining: 70, resetsAt: 20000 }] }, 300, 4000),
    display({ ...previous, id: "copilot", windows: [{ label: "Premium", remaining: 80, resetsAt: 4500 }] }, 300, 4000),
    display({ ...previous, id: "codex", state: "error", windows: [{ label: "5h", remaining: 50, resetsAt: 4100 }] }, 300, 4000)
  ];
  const summary = summarizeCapacity(["claude", "codex"], rows, 4000);
  assert.deepEqual(summary.nextReset, { id: "claude", label: "5h", resetsAt: 5000 });
});
test("status bar uses capacity counts, independent allowances and confirmed next reset rather than a single minimum", () => {
  const rows = [
    display({ ...previous, id: "antigravity", windows: [
      { pool: "gemini", label: "Gemini / 5h", remaining: 0, resetsAt: 3602000 },
      { pool: "claude", label: "Claude / 5h", remaining: 55, resetsAt: 7202000 }
    ] }, 300, 2000),
    display({ ...previous, id: "codex", state: "auth" }, 300, 2000),
    display({ ...previous, id: "freebuff", windows: [{ label: "Day", remaining: .4 }] }, 300, 2000)
  ];
  const status = capacityStatus(summarizeCapacity(["antigravity", "codex", "freebuff"], rows, 2000), 2000);
  assert.equal(status.text, "$(dashboard) AI Quota 2/3 available $(warning) 1");
  assert.match(status.tooltip, /0% left \(Gemini \/ 5h\); 55% left \(Claude \/ 5h\)/);
  assert.match(status.tooltip, /Freebuff: <1% left \(Day\)/);
  assert.match(status.tooltip, /Next reset: Antigravity \/ Gemini \/ 5h in 1h 0m/);
  assert.match(status.tooltip, /ChatGPT \/ Codex: Sign in needed/);
  assert.equal(status.warning, true);
});
test("status bar distinguishes empty selection, stale data and confirmed exhaustion", () => {
  const empty = capacityStatus(summarizeCapacity([], [], 2000), 2000);
  assert.match(empty.text, /Choose providers/);
  assert.equal(empty.warning, false);
  const stale = display({ ...previous, windows: [{ label: "5h", remaining: 80 }] }, 30, 400000);
  const unknown = capacityStatus(summarizeCapacity(["claude"], [stale], 400000), 400000);
  assert.match(unknown.text, /0\/1 available/);
  assert.match(unknown.tooltip, /Refresh to confirm/);
  assert.ok(!unknown.tooltip.includes("80%"));
  const exhausted = display({ ...previous, windows: [{ label: "5h", remaining: 0 }] }, 300, 2000);
  assert.equal(capacityStatus(summarizeCapacity(["claude"], [exhausted], 2000), 2000).warning, true);
  const ready = display({ ...previous, windows: [{ label: "5h", remaining: 80 }] }, 300, 2000);
  assert.equal(capacityStatus(summarizeCapacity(["claude"], [ready], 2000), 2000).warning, false);
});
