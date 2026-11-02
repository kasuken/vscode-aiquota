import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import {
  discoverAntigravity, fetchAntigravity, normalizeAntigravity, parseAntigravityPorts,
  parseAntigravityProcesses, requestAntigravityStatus
} from "../src/antigravity";
import { display, mergeFailure, providerSelection, Snapshot } from "../src/model";
import { ProviderError } from "../src/providers";

const reset = "2026-12-01T00:00:00Z";
const data = {
  userStatus: {
    email: "private@example.test", userTier: { name: "Google AI Pro" },
    cascadeModelConfigData: { clientModelConfigs: [
      { label: "Gemini Pro", modelOrAlias: { model: "gemini-pro" }, quotaInfo: { remainingFraction: .35, resetTime: reset } },
      { label: "Claude Sonnet", modelOrAlias: { model: "claude-sonnet" }, quotaInfo: { remainingFraction: .8, resetTime: reset } },
      { label: "Not available" }
    ] }
  }
};
const command = String.raw`"C:\Apps\Antigravity\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe" --csrf_token fixture-token --extension_server_port 1234`;
async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
test("Antigravity tracks all reported models, including non-Gemini models", () => {
  const result = normalizeAntigravity(data);
  assert.equal(result.plan, "Google AI Pro");
  assert.deepEqual(result.windows.map(window => [window.label, window.remaining]), [["Gemini Pro", 35], ["Claude Sonnet", 80]]);
  assert.equal(result.windows[0]?.resetsAt, Date.parse(reset));
  assert.notEqual(result.windows[0]?.pool, result.windows[1]?.pool);
  assert.ok(!JSON.stringify(result).includes("private@example.test"));
});
test("Antigravity supports free plans and falls back to reported plan metadata", () => {
  const status = { ...data.userStatus, userTier: undefined, planStatus: { planInfo: { planName: "Free" } } };
  assert.equal(normalizeAntigravity({ userStatus: status }).plan, "Free");
});
test("an omitted protobuf fraction with a reset represents exhausted quota, never full quota", () => {
  const result = normalizeAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: "Gemini Flash", quotaInfo: { resetTime: reset } },
    { label: "Claude", quotaInfo: { remainingFraction: 0, resetTime: reset } }
  ] } } });
  assert.deepEqual(result.windows.map(window => window.remaining), [0, 0]);
});
test("missing and malformed Antigravity quota data surfaces an error", () => {
  for (const body of [{}, { userStatus: {} }, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } }]) {
    assert.throws(() => normalizeAntigravity(body), ProviderError);
  }
  for (const fraction of ["0.5", null, NaN, -1, 1.1]) {
    assert.throws(() => normalizeAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { label: "Gemini Pro", quotaInfo: { remainingFraction: fraction, resetTime: reset } }
    ] } } }), /unrecognized/);
  }
});
test("legacy Gemini provider selections migrate without reordering or duplicates", () => {
  assert.deepEqual(providerSelection(["copilot", "gemini", "claude", "antigravity", "unknown"]), ["copilot", "antigravity", "claude"]);
});
test("Windows discovery accepts only identifiable Antigravity language servers", () => {
  const results = parseAntigravityProcesses(JSON.stringify([
    { ProcessId: 42, CommandLine: command },
    { ProcessId: 43, CommandLine: command.replaceAll("Antigravity", "OtherEditor").replaceAll("antigravity", "other") },
    { ProcessId: 44, CommandLine: command.replace("language_server_windows_x64.exe", "unrelated.exe") },
    { ProcessId: 45, CommandLine: command.replace("--csrf_token fixture-token", "") }
  ]), "win32");
  assert.deepEqual(results, [{ pid: 42, csrfToken: "fixture-token" }]);
});
test("Unix discovery supports quoted CSRF flags and macOS application paths", () => {
  const stdout = [
    '42 1 /Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm64 --csrf_token="fixture-token"',
    '43 1 /opt/editor/language_server_linux_x64 --app_data_dir=antigravity --csrf_token=other-token',
    '44 1 /opt/editor/language_server_linux_x64 --csrf_token=unrelated-token'
  ].join("\n");
  assert.deepEqual(parseAntigravityProcesses(stdout, "darwin"), [
    { pid: 42, csrfToken: "fixture-token" }, { pid: 43, csrfToken: "other-token" }
  ]);
});
test("Windows listening-port discovery requires exact PID ownership and a local binding", () => {
  assert.deepEqual(parseAntigravityPorts([
    "TCP 127.0.0.1:5000 0.0.0.0:0 LISTENING 42",
    "TCP 127.0.0.1:5001 0.0.0.0:0 LISTENING 142",
    "TCP 10.1.1.1:5002 0.0.0.0:0 LISTENING 42",
    "TCP 127.0.0.1:5003 127.0.0.1:6000 ESTABLISHED 42",
    "TCP [::1]:5004 [::]:0 LISTENING 42"
  ].join("\n"), 42, "netstat"), [5000, 5004]);
});
test("Linux and macOS port parsers exclude other processes", () => {
  assert.deepEqual(parseAntigravityPorts([
    'LISTEN 0 128 127.0.0.1:5000 0.0.0.0:* users:(("language_server",pid=42,fd=10))',
    'LISTEN 0 128 127.0.0.1:5001 0.0.0.0:* users:(("other",pid=142,fd=10))'
  ].join("\n"), 42, "ss"), [5000]);
  assert.deepEqual(parseAntigravityPorts("p42\nn127.0.0.1:5000\np142\nn127.0.0.1:5001", 42, "lsof"), [5000]);
});
test("local discovery reports stopped applications and ambiguous accounts explicitly", async () => {
  const empty = process.platform === "win32" ? "[]" : "";
  await assert.rejects(discoverAntigravity(1000, async () => empty), /not running locally/);
  const multiple = process.platform === "win32" ? JSON.stringify([
    { ProcessId: 42, CommandLine: command }, { ProcessId: 43, CommandLine: command }
  ]) : [
    "42 1 /opt/antigravity/language_server_linux_x64 --csrf_token=fixture",
    "43 1 /opt/antigravity/language_server_linux_x64 --csrf_token=fixture"
  ].join("\n");
  await assert.rejects(discoverAntigravity(1000, async () => multiple), /Multiple Antigravity/);
});
test("GetUserStatus uses loopback, CSRF authentication, and a read-only RPC payload", async () => {
  let calls = 0;
  const server = await localServer((request, response) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/exa.language_server_pb.LanguageServerService/GetUserStatus");
    assert.equal(request.headers["x-codeium-csrf-token"], "fixture-token");
    assert.equal(request.headers["connect-protocol-version"], "1");
    assert.equal(request.headers.authorization, undefined);
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), { metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } });
      response.end(JSON.stringify(data));
    });
  });
  try {
    const snapshot = await fetchAntigravity(2, async () => ({ ports: [server.port], csrfToken: "fixture-token" }));
    assert.equal(snapshot.state, "ok");
    assert.equal(snapshot.windows[0]?.remaining, 35);
    assert.equal(calls, 1, "Only the read-only status call reaches the HTTP endpoint");
    assert.ok(!JSON.stringify(snapshot).includes("fixture-token"));
  } finally { await server.close(); }
});
test("local requests never follow redirects or disclose raw error responses", async () => {
  let calls = 0;
  const server = await localServer((_request, response) => {
    calls++;
    response.writeHead(302, { Location: "https://example.test/collect" });
    response.end("private-response-data");
  });
  try {
    await assert.rejects(requestAntigravityStatus(server.port, "fixture", 1000, false),
      (error: unknown) => error instanceof ProviderError && /HTTP 302/.test(error.message) && !error.message.includes("private-response-data"));
    assert.equal(calls, 1);
    await assert.rejects(requestAntigravityStatus(server.port, "fixture\r\nInjected: true", 1000, false), /Invalid Antigravity/);
    assert.equal(calls, 1);
  } finally { await server.close(); }
});
test("local request timeouts and invalid JSON are explicit failures", async () => {
  const invalid = await localServer((_request, response) => response.end("private-not-json"));
  try {
    await assert.rejects(requestAntigravityStatus(invalid.port, "fixture", 1000, false), /invalid quota JSON/);
  } finally { await invalid.close(); }
  const hanging = await localServer(() => {});
  try {
    await assert.rejects(requestAntigravityStatus(hanging.port, "fixture", 20, false), /timed out/);
  } finally { await hanging.close(); }
});
test("stopped Antigravity retains last known quotas as approximate", async () => {
  const previous: Snapshot = {
    id: "antigravity", state: "ok", checkedAt: Date.now(), fetchedAt: Date.now(),
    plan: "Google AI Pro", windows: [{ label: "Claude Sonnet", remaining: 35, resetsAt: Date.parse(reset) }]
  };
  const failed = await fetchAntigravity(1, async () => { throw new ProviderError("Antigravity is not running locally."); });
  assert.equal(failed.state, "error");
  const result = display(mergeFailure(previous, failed), 300);
  assert.equal(result.windows[0]?.remaining, 35);
  assert.equal(result.windows[0]?.approximate, true);
});
