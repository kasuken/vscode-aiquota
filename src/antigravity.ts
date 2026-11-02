import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import { at, number, QuotaWindow, record, Snapshot, text, timestamp } from "./model";
import { ProviderError } from "./providers";

interface LocalProcess { pid: number; csrfToken: string }
export interface LocalSession { ports: number[]; csrfToken: string }
type RunCommand = (file: string, args: string[], timeout: number) => Promise<string>;
type LocalRequest = (port: number, csrfToken: string, timeout: number, secure?: boolean) => Promise<unknown>;
const statusPath = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

function validPort(value: number): boolean { return Number.isInteger(value) && value > 0 && value <= 65535; }
function processInfo(pid: unknown, command: unknown): LocalProcess | undefined {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof command !== "string") { return undefined; }
  const executable = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
  const path = executable?.[1] ?? executable?.[2] ?? "";
  if (!/(?:^|[\\/])language_server_(?:windows|linux|macos)_(?:x64|arm64)(?:\.exe)?$/i.test(path)) { return undefined; }
  const antigravityPath = /[\\/]antigravity(?:\.app| ide)?[\\/]/i.test(path);
  const appData = /(?:^|\s)--app_data_dir(?:=|\s+)"?antigravity"?(?:\s|$)/i.test(command);
  if (!antigravityPath && !appData) { return undefined; }
  const token = /(?:^|\s)--csrf_token(?:=|\s+)(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))(?=\s|$)/.exec(command);
  const csrfToken = token?.[1] ?? token?.[2];
  return csrfToken ? { pid, csrfToken } : undefined;
}
export function parseAntigravityProcesses(stdout: string, platform = process.platform): LocalProcess[] {
  let candidates: (LocalProcess | undefined)[];
  if (platform === "win32") {
    let data: unknown;
    try { data = stdout.trim() ? JSON.parse(stdout) as unknown : []; }
    catch { throw new ProviderError("Cannot parse Antigravity process information. Restart Antigravity and refresh."); }
    candidates = (Array.isArray(data) ? data : [data]).map(row => processInfo(at(row, "ProcessId"), at(row, "CommandLine")));
  } else {
    candidates = stdout.split(/\r?\n/).map(line => {
      const match = /^\s*(\d+)\s+\d+\s+(.+)$/.exec(line);
      return match ? processInfo(Number(match[1]), match[2]) : undefined;
    });
  }
  return [...new Map(candidates.filter((item): item is LocalProcess => !!item).map(item => [item.pid, item])).values()];
}
export function parseAntigravityPorts(stdout: string, pid: number, format: "netstat" | "ss" | "lsof"): number[] {
  const ports: number[] = [];
  let lsofPid: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    let address: string | undefined;
    if (format === "netstat") {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === "TCP" && fields[3] === "LISTENING" && Number(fields[4]) === pid) { address = fields[1]; }
    } else if (format === "ss") {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === "LISTEN" && new RegExp(`\\bpid=${pid}(?:,|\\))`).test(line)) { address = fields[3]; }
    } else {
      if (/^p\d+$/.test(line)) { lsofPid = Number(line.slice(1)); }
      if (line.startsWith("n") && lsofPid === pid) { address = line.slice(1); }
    }
    const match = address && /^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*):(\d+)$/.exec(address);
    const port = match ? Number(match[1]) : 0;
    if (validPort(port)) { ports.push(port); }
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}
const runCommand: RunCommand = async (file, args, timeout) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
};
function remaining(deadline: number): number {
  const time = deadline - Date.now();
  if (time <= 0) { throw new ProviderError("Antigravity quota check timed out. Keep Antigravity running and refresh."); }
  return time;
}
export async function discoverAntigravity(timeout: number, run: RunCommand = runCommand): Promise<LocalSession> {
  const deadline = Date.now() + timeout;
  const windows = process.platform === "win32";
  const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
  let stdout: string;
  try {
    stdout = windows
      ? await run(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $session=(Get-Process -Id ${process.pid}).SessionId; @(
          Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" |
          Where-Object { $_.SessionId -eq $session } |
          Select-Object ProcessId,CommandLine
        ) | ConvertTo-Json -Compress`
      ], remaining(deadline))
      : await run("/bin/ps", ["-ww", "-u", String(process.getuid?.()), "-o", "pid=,ppid=,args="], remaining(deadline));
  } catch {
    throw new ProviderError("Cannot inspect local Antigravity processes. Check process permissions and refresh.");
  }
  const processes = parseAntigravityProcesses(stdout);
  if (!processes.length) { throw new ProviderError("Antigravity is not running locally. Open Antigravity, sign in, and refresh."); }
  if (processes.length > 1) { throw new ProviderError("Multiple Antigravity servers found. Keep one Antigravity window open and refresh to select its account."); }
  const server = processes[0];
  if (!server) { throw new ProviderError("Antigravity process discovery failed."); }
  let ports: number[];
  try {
    if (windows) {
      ports = parseAntigravityPorts(await run(join(system, "netstat.exe"), ["-ano", "-p", "tcp"], remaining(deadline)), server.pid, "netstat");
    } else if (process.platform === "darwin") {
      ports = parseAntigravityPorts(await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(server.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], remaining(deadline)), server.pid, "lsof");
    } else {
      try {
        ports = parseAntigravityPorts(await run("/usr/bin/ss", ["-H", "-ltnp"], remaining(deadline)), server.pid, "ss");
      } catch (error) {
        if (record(error).code !== "ENOENT") { throw error; }
        ports = parseAntigravityPorts(await run("/usr/bin/lsof", ["-nP", "-a", "-p", String(server.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], remaining(deadline)), server.pid, "lsof");
      }
    }
  } catch {
    throw new ProviderError("Cannot discover Antigravity's local listening ports. Check process permissions; Linux requires ss or lsof.");
  }
  if (!ports.length) { throw new ProviderError("Antigravity's local quota service is not ready. Open an Antigravity workspace and refresh."); }
  return { ports, csrfToken: server.csrfToken };
}
class LocalConnectionError extends Error {
  constructor(public readonly code: unknown) { super("Cannot connect to Antigravity's local quota service. Restart Antigravity and refresh."); }
}
export const requestAntigravityStatus: LocalRequest = (port, csrfToken, timeout, secure = true) => new Promise((resolve, reject) => {
  if (!validPort(port) || !/^[A-Za-z0-9_-]+$/.test(csrfToken)) {
    reject(new ProviderError("Invalid Antigravity local connection information.")); return;
  }
  const body = JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } });
  // Antigravity uses a self-signed certificate. This exception is confined to a
  // fixed loopback address and ports verified to belong to its language server.
  const request = (secure ? https : http).request({
    hostname: "127.0.0.1", port, path: statusPath, method: "POST",
    ...(secure ? { rejectUnauthorized: false } : {}),
    headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": csrfToken
    }
  }, response => {
    if (response.statusCode !== 200) {
      response.resume();
      reject(new ProviderError(response.statusCode === 401 || response.statusCode === 403
        ? "Antigravity rejected the local session. Sign in again in Antigravity and refresh."
        : `Antigravity local API returned HTTP ${response.statusCode}. Restart Antigravity and refresh.`,
      response.statusCode === 401 || response.statusCode === 403 ? "auth" : "error"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { request.destroy(new ProviderError("Antigravity quota response is too large.")); return; }
      chunks.push(chunk);
    });
    response.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { reject(new ProviderError("Antigravity returned invalid quota JSON. Restart Antigravity and refresh.")); }
    });
    response.on("error", () => reject(new ProviderError("Antigravity's quota response was interrupted. Refresh to retry.")));
  });
  const timer = setTimeout(() => request.destroy(new ProviderError("Antigravity quota request timed out.")), timeout);
  request.on("close", () => clearTimeout(timer));
  request.on("error", error => reject(error instanceof ProviderError ? error : new LocalConnectionError(record(error).code)));
  request.end(body);
});
export function normalizeAntigravity(data: unknown): Pick<Snapshot, "plan" | "windows"> {
  const status = at(data, "userStatus");
  const configs = at(status, "cascadeModelConfigData", "clientModelConfigs");
  if (!Array.isArray(configs)) {
    throw new ProviderError("Antigravity did not report model quotas. Sign in and open a workspace in Antigravity, then refresh.");
  }
  const windows: QuotaWindow[] = [];
  for (const [index, config] of configs.entries()) {
    const info = at(config, "quotaInfo");
    if (!info || typeof info !== "object") { continue; }
    const label = text(at(config, "label")) || text(at(config, "modelOrAlias", "model"));
    if (!label) { continue; }
    const fraction = at(info, "remainingFraction");
    const reset = timestamp(at(info, "resetTime"));
    // Protobuf JSON omits a zero-valued remainingFraction for exhausted models.
    const left = fraction === undefined && reset !== undefined ? 0 : number(fraction);
    if (left === undefined || left < 0 || left > 1) {
      throw new ProviderError("Antigravity returned an unrecognized model quota. Showing last known values.");
    }
    windows.push({ label, remaining: left * 100, resetsAt: reset, pool: `model-${index}` });
  }
  if (!windows.length) { throw new ProviderError("Antigravity returned no finite model quotas. Sign in and refresh."); }
  return {
    plan: text(at(status, "userTier", "name")) || text(at(status, "planStatus", "planInfo", "planName")) || "Antigravity",
    windows
  };
}
export async function fetchAntigravity(
  timeoutSeconds: number,
  discover: (timeout: number) => Promise<LocalSession> = discoverAntigravity,
  request: LocalRequest = requestAntigravityStatus
): Promise<Snapshot> {
  const checkedAt = Date.now();
  const deadline = checkedAt + timeoutSeconds * 1000;
  try {
    const session = await discover(remaining(deadline));
    let lastError: unknown;
    for (const port of session.ports) {
      try {
        let data: unknown;
        try { data = await request(port, session.csrfToken, remaining(deadline)); }
        catch (error) {
          if (!(error instanceof LocalConnectionError) || error.code !== "EPROTO") { throw error; }
          data = await request(port, session.csrfToken, remaining(deadline), false);
        }
        return { id: "antigravity", ...normalizeAntigravity(data), state: "ok", checkedAt, fetchedAt: Date.now() };
      } catch (error) { lastError = error; }
    }
    if (lastError instanceof Error) { throw lastError; }
    throw new ProviderError("Antigravity's local quota service is not ready. Open an Antigravity workspace and refresh.");
  } catch (error) {
    return {
      id: "antigravity", state: error instanceof ProviderError ? error.state : "error", windows: [], checkedAt,
      message: error instanceof ProviderError || error instanceof LocalConnectionError ? error.message :
        "Cannot read Antigravity quota. Restart Antigravity and refresh."
    };
  }
}
