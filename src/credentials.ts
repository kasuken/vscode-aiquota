import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { at, CredentialProviderId, number, ProviderId, record, text } from "./model";

export interface Credential { token: string; plan?: string; accountId?: string; expiresAt?: number }
export interface CredentialOptions {
  paths: Partial<Record<ProviderId, string>>;
  githubToken: () => Promise<string | undefined>;
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.~+/=:-]+$/.test(value);
}
async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return undefined; }
    throw new Error("Cannot read credentials. Check the credential file permissions and JSON format.");
  }
}
export function credentialFiles(id: CredentialProviderId, env = process.env, home = homedir()): string[] {
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  switch (id) {
    case "claude": return [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json")];
    case "codex": return [join(env.CODEX_HOME || join(home, ".codex"), "auth.json")];
    case "copilot": return [
      join(config, "github-copilot", "apps.json"), join(config, "github-copilot", "hosts.json"),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "github-copilot", "apps.json")] : [])
    ];
    case "opencode": return [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json")];
    case "freebuff": return [join(config, "manicode", "credentials.json")];
  }
}
function findOAuth(value: unknown): string | undefined {
  const object = record(value);
  if (validToken(object.oauth_token)) { return object.oauth_token; }
  for (const child of Object.values(object)) {
    if (typeof child === "object" && child !== null) {
      const token = findOAuth(child);
      if (token) { return token; }
    }
  }
  return undefined;
}
export function parseCredential(id: CredentialProviderId, data: unknown): Credential | undefined {
  let token: unknown;
  let plan: string | undefined;
  let expiresAt: number | undefined;
  let accountId: string | undefined;
  switch (id) {
    case "claude": {
      const oauth = at(data, "claudeAiOauth");
      const subscription = text(at(oauth, "subscriptionType"));
      if (!subscription) { return undefined; }
      token = at(oauth, "accessToken");
      const tier = text(at(oauth, "rateLimitTier"));
      plan = tier.includes("max_20x") ? "Max 20x" : tier.includes("max_5x") ? "Max 5x" : prettyPlan(subscription);
      expiresAt = number(at(oauth, "expiresAt"));
      break;
    }
    case "codex":
      if (at(data, "auth_mode") && at(data, "auth_mode") !== "chatgpt") { return undefined; }
      token = at(data, "tokens", "access_token");
      if (validToken(at(data, "tokens", "account_id"))) { accountId = String(at(data, "tokens", "account_id")); }
      break;
    case "copilot": token = findOAuth(data); break;
    case "opencode": token = at(data, "opencode-go", "key"); plan = "Go"; break;
    case "freebuff": token = at(data, "default", "authToken"); plan = "Free"; break;
  }
  return validToken(token) ? { token, plan, expiresAt, accountId } : undefined;
}
function prettyPlan(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}
export async function loadCredential(id: CredentialProviderId, options: CredentialOptions): Promise<Credential | undefined> {
  if (id === "copilot") {
    const token = await options.githubToken();
    if (validToken(token)) { return { token }; }
  }
  const custom = options.paths[id];
  if (custom && !isAbsolute(custom)) { throw new Error("Credential paths must be absolute."); }
  for (const file of custom ? [custom] : credentialFiles(id)) {
    const data = await readJson(file);
    if (data !== undefined) { return parseCredential(id, data); }
  }
  if (id === "claude" && process.platform === "darwin" && !custom) {
    try {
      const { stdout } = await promisify(execFile)("security", [
        "find-generic-password", "-s", "Claude Code-credentials", "-w"
      ], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return parseCredential(id, JSON.parse(stdout) as unknown);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 44) { return undefined; }
      throw new Error("Cannot read Claude credentials from macOS Keychain. Open Claude or configure a credential file.");
    }
  }
  return undefined;
}
