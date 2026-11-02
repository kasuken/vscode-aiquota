import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityTokenFile, loadAntigravityCredential, parseAntigravityCredential, readAntigravityKeyring } from "../src/antigravityAuth";
import { fetchAntigravityCli, fetchAntigravityQuota, normalizeAntigravitySummary } from "../src/antigravityCli";
import { createRequest, ProviderError } from "../src/providers";

const reset = "2026-12-01T00:00:00Z";
const secret = JSON.stringify({
  token: { access_token: "fixture-access", refresh_token: "fixture-refresh", expiry: reset },
  auth_method: "consumer", id_token_email: "private@example.test"
});
const summary = { groups: [
  { displayName: "Gemini", buckets: [
    { bucketId: "gemini-session", displayName: "5-hour limit", window: "5h", remainingFraction: .42, resetTime: reset },
    { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: .91, resetTime: reset }
  ] },
  { displayName: "Claude / GPT", buckets: [
    { displayName: "5-hour limit", remainingFraction: .7, resetTime: reset },
    { displayName: "Disabled", disabled: true, remainingFraction: 0 }
  ] }
] };
test("CLI auth parses keyring JSON and base64 secrets without returning refresh tokens or account details", () => {
  for (const raw of [secret, `go-keyring-base64:${Buffer.from(secret).toString("base64")}`]) {
    const credential = parseAntigravityCredential(raw);
    assert.deepEqual(credential, { token: "fixture-access", expiresAt: Date.parse(reset) });
    assert.ok(!JSON.stringify(credential).includes("fixture-refresh"));
    assert.ok(!JSON.stringify(credential).includes("private@example.test"));
  }
});
test("CLI auth rejects malformed credentials, header injection, invalid expiry and unsupported auth methods", () => {
  for (const raw of [
    "{broken", JSON.stringify({ token: { access_token: "fixture\r\nInjected: true" } }),
    JSON.stringify({ token: { access_token: "fixture", expiry: "invalid" } }),
    JSON.stringify({ token: { access_token: "fixture" }, auth_method: "enterprise" })
  ]) {
    assert.throws(() => parseAntigravityCredential(raw), ProviderError);
  }
});
test("CLI auth reads keyring values through captured output, not command arguments", async () => {
  const raw = await readAntigravityKeyring(1000, async (_file, args) => {
    assert.ok(!args.some(argument => argument.includes("fixture-access") || argument.includes("fixture-refresh")));
    return secret;
  }, "win32");
  assert.equal(raw, secret);
});
test("keyring absence permits file fallback while permission and D-Bus errors are explicit", async () => {
  assert.equal(await readAntigravityKeyring(1000, async () => "", "win32"), undefined);
  assert.equal(await readAntigravityKeyring(1000, async () => { throw Object.assign(new Error(), { code: 44 }); }, "darwin"), undefined);
  assert.equal(await readAntigravityKeyring(1000, async () => { throw Object.assign(new Error(), { code: "ENOENT" }); }, "linux"), undefined);
  await assert.rejects(readAntigravityKeyring(1000, async () => {
    throw Object.assign(new Error("private diagnostic"), { code: 1, stderr: "Cannot connect to D-Bus" });
  }, "linux"), /Cannot read Antigravity CLI's OS keyring/);
  await assert.rejects(readAntigravityKeyring(1000, async () => { throw new Error("private diagnostic"); }, "win32"), error =>
    error instanceof ProviderError && !error.message.includes("private diagnostic"));
});
test("CLI credential path honors AGY_DIR", () => {
  assert.equal(antigravityTokenFile({ AGY_DIR: "custom-cli" }, "home"), join("custom-cli", "antigravity-oauth-token"));
});
test("CLI keyring entries are used directly and explicit file paths bypass the keyring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiquota-cli-"));
  const file = join(dir, "antigravity-oauth-token");
  try {
    await writeFile(file, secret);
    let called = false;
    const credential = await loadAntigravityCredential(1000, file, async () => { called = true; throw new Error("Must not read keyring"); });
    assert.equal(credential?.token, "fixture-access");
    assert.equal(called, false);
    const fromKeyring = await loadAntigravityCredential(1000, undefined, async () => secret);
    assert.equal(fromKeyring?.token, "fixture-access");
    assert.equal(await loadAntigravityCredential(1000, join(dir, "missing"), async () => secret), undefined);
    await writeFile(file, "{broken");
    await assert.rejects(loadAntigravityCredential(1000, file), /Cannot parse/);
  } finally { await rm(dir, { recursive: true }); }
});
test("CLI quota summary preserves five-hour, weekly and third-party groups", () => {
  const result = normalizeAntigravitySummary(summary, { paidTier: { name: "Google AI Pro" }, currentTier: { name: "Free" } });
  assert.equal(result.plan, "Google AI Pro");
  assert.deepEqual(result.windows.map(window => [window.label, window.remaining]), [
    ["Gemini / 5-hour limit", 42], ["Gemini / Weekly", 91], ["Claude / GPT / 5-hour limit", 70]
  ]);
  assert.equal(result.windows[0]?.resetsAt, Date.parse(reset));
  assert.equal(result.windows[0]?.pool, result.windows[1]?.pool);
  assert.notEqual(result.windows[0]?.pool, result.windows[2]?.pool);
});
test("CLI quotas support wrapped summaries, exhausted protobuf defaults, and integer zero allowances", () => {
  for (const wrap of [(body: unknown) => body, (body: unknown) => ({ response: body }), (body: unknown) => ({ summary: body })]) {
    const result = normalizeAntigravitySummary(wrap({ buckets: [
      { displayName: "Weekly", resetTime: reset },
      { displayName: "5-hour", remainingAmount: "0", resetTime: reset }
    ] }), {});
    assert.deepEqual(result.windows.map(window => window.remaining), [0, 0]);
  }
});
test("CLI absolute allowances without a total are never fabricated as percentages", () => {
  assert.throws(() => normalizeAntigravitySummary({ groups: [{ buckets: [
    { displayName: "Weekly", remainingAmount: "500", resetTime: reset }
  ] }] }, {}), /no finite percentage/);
});
test("CLI quota parser rejects malformed responses and invalid fractions", () => {
  for (const body of [{}, { error: "private response" }, { groups: {} }, { groups: [{ buckets: null }] }]) {
    assert.throws(() => normalizeAntigravitySummary(body, {}), ProviderError);
  }
  for (const fraction of ["0.5", null, NaN, -1, 1.1]) {
    assert.throws(() => normalizeAntigravitySummary({ groups: [{ buckets: [
      { displayName: "Weekly", remainingFraction: fraction, resetTime: reset }
    ] }] }, {}), /invalid remaining quota/);
  }
});
test("CLI requests only read-only Cloud Code endpoints using the current keyring access token", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const result = await fetchAntigravityCli(2, undefined, async () => parseAntigravityCredential(secret),
    async (url, token, _headers, body) => {
      assert.equal(token, "fixture-access");
      calls.push({ url, body });
      return calls.length === 1 ? { currentTier: { name: "Pro" }, cloudaicompanionProject: { id: "project-one" } } : summary;
    });
  assert.equal(result?.state, "ok");
  assert.deepEqual(calls, [
    { url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", body: {} },
    { url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", body: { project: "project-one" } }
  ]);
  assert.ok(!JSON.stringify(result).includes("fixture-access"));
});
test("CLI quota queries permit a missing project but reject malformed project metadata", async () => {
  let calls = 0;
  const result = await fetchAntigravityCli(2, undefined, async () => ({ token: "fixture" }),
    async (_url, _token, _headers, body) => {
      calls++;
      assert.deepEqual(body, {});
      return calls === 1 ? { currentTier: { name: "Free" } } : summary;
    });
  assert.equal(result?.state, "ok");
  const invalid = await fetchAntigravityCli(2, undefined, async () => ({ token: "fixture" }), async () => ({ cloudaicompanionProject: {} }));
  assert.equal(invalid?.state, "error");
  assert.match(invalid?.message ?? "", /invalid Cloud Code project/);
});
test("missing and expired CLI sessions never trigger token refresh or quota requests", async () => {
  let requests = 0;
  const request = async () => { requests++; return summary; };
  assert.equal(await fetchAntigravityCli(1, undefined, async () => undefined, request), undefined);
  const expired = await fetchAntigravityCli(1, undefined, async () => ({ token: "fixture", expiresAt: 1 }), request);
  assert.equal(expired?.state, "auth");
  assert.match(expired?.message ?? "", /Run agy and \/usage/);
  assert.equal(requests, 0);
});
test("CLI auth rejection is explicit and does not expose errors containing credentials", async () => {
  const rejected = await fetchAntigravityCli(1, undefined, async () => ({ token: "fixture" }), async () => {
    throw new ProviderError("Login rejected.", "auth");
  });
  assert.equal(rejected?.state, "auth");
  const unexpected = await fetchAntigravityCli(1, undefined, async () => { throw new Error("private token value"); });
  assert.ok(!unexpected?.message?.includes("private token value"));
});
test("explicit missing CLI credential file does not silently select an IDE account", async () => {
  const result = await fetchAntigravityQuota(1, join(tmpdir(), `missing-cli-${Date.now()}.json`));
  assert.equal(result.state, "auth");
  assert.match(result.message ?? "", /configured token file/);
});
test("CLI cloud requests retain HTTPS, redirect rejection, and the fixed host allowlist", async () => {
  let redirected: RequestRedirect | undefined;
  const request = createRequest(1, async (url, init) => {
    assert.equal(String(url), "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
    redirected = init?.redirect;
    return new Response(JSON.stringify(summary));
  });
  await request("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", "fixture", {}, {});
  assert.equal(redirected, "error");
  await assert.rejects(request("http://daily-cloudcode-pa.googleapis.com", "fixture"), /unrecognized/);
  await assert.rejects(request("https://daily-cloudcode-pa.googleapis.com.example.test", "fixture"), /unrecognized/);
});
