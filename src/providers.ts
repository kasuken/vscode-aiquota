import { Credential, CredentialOptions, loadCredential } from "./credentials";
import { at, CredentialProviderId, number, pretty, quota, QuotaWindow, Snapshot, text, windowLabel } from "./model";

type Request = (url: string, token: string, headers?: Record<string, string>, body?: unknown) => Promise<unknown>;
export class ProviderError extends Error {
  constructor(message: string, public readonly state: "auth" | "error" | "hidden" = "error") { super(message); }
}
const allowedHosts = new Set([
  "api.anthropic.com", "chatgpt.com",
  "api.github.com", "opencode.ai", "www.codebuff.com", "daily-cloudcode-pa.googleapis.com"
]);
export function createRequest(timeoutSeconds: number, fetcher: typeof fetch = fetch): Request {
  return async (url, token, headers = {}, body) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || !allowedHosts.has(target.hostname)) {
      throw new ProviderError("Refusing to send credentials to an unrecognized endpoint.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "AI-Quota-VSCode",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.status === 401 || response.status === 403) {
        if (target.hostname === "opencode.ai" && response.status === 403) {
          throw new ProviderError("No OpenCode Go subscription found.", "hidden");
        }
        throw new ProviderError("Login rejected. Open this provider's CLI to sign in again.", "auth");
      }
      if (!response.ok) {
        throw new ProviderError(response.status === 429
          ? "Rate limited. Showing last known values." : `HTTP ${response.status}. Showing last known values.`);
      }
      try { return await response.json() as unknown; }
      catch { throw new ProviderError("Invalid JSON response. Showing last known values."); }
    } catch (error) {
      if (error instanceof ProviderError) { throw error; }
      throw new ProviderError(controller.signal.aborted
        ? "Request timed out. Showing last known values."
        : "Network request failed. Check your connection; showing last known values.");
    } finally { clearTimeout(timer); }
  };
}
const windows = (...items: (QuotaWindow | undefined)[]): QuotaWindow[] =>
  items.filter((item): item is QuotaWindow => item !== undefined);
export function normalize(id: CredentialProviderId, data: unknown, credential: Credential): Pick<Snapshot, "plan" | "windows"> {
  switch (id) {
    case "claude":
      return { plan: credential.plan, windows: windows(...["five_hour", "seven_day"].map((key, index) =>
        quota(index === 0 ? "5h" : "7d", at(data, key, "utilization"), at(data, key, "resets_at")))) };
    case "codex":
      if (text(at(data, "plan_type")).includes("usage_based")) { throw new ProviderError("Metered plans are not tracked.", "hidden"); }
      return { plan: pretty(at(data, "plan_type")) || "Subscription", windows: windows(...["primary_window", "secondary_window"].map(key =>
        quota(windowLabel(at(data, "rate_limit", key, "limit_window_seconds")),
          at(data, "rate_limit", key, "used_percent"), at(data, "rate_limit", key, "reset_at")))) };
    case "copilot": {
      if (at(data, "access_type_sku") === "no_access") { throw new ProviderError("No Copilot subscription found.", "hidden"); }
      const reset = at(data, "quota_reset_date_utc") || at(data, "quota_reset_date");
      const snapshots = at(data, "quota_snapshots");
      if (snapshots === undefined || snapshots === null || typeof snapshots !== "object") {
        throw new ProviderError("Quota snapshots are missing from the response.");
      }
      return { plan: pretty(at(data, "copilot_plan")) || "Subscription",
        windows: windows(...["premium_interactions", "chat"].map(key => {
          if (at(snapshots, key, "unlimited") === true) { return undefined; }
          const left = number(at(snapshots, key, "percent_remaining"));
          const window = quota(key === "chat" ? "Chat" : "Premium", left === undefined ? undefined : 100 - left, reset);
          return window ? { ...window, pool: key } : undefined;
        })) };
    }
    case "opencode":
      return { plan: "Go", windows: windows(...["rolling", "weekly", "monthly"].map((key, index) =>
        quota(["5h", "7d", "Month"][index] ?? key, at(data, "usage", key, "percent"), at(data, "usage", key, "resetsAt")))) };
    case "freebuff": {
      const limit = number(at(data, "freebucks", "daily", "limit"));
      const spent = number(at(data, "freebucks", "daily", "spent")) ?? 0;
      if (limit === undefined || limit <= 0) { throw new ProviderError("No daily Freebuff allowance found.", "hidden"); }
      return { plan: "Free", windows: windows(quota("Day", spent / limit * 100, at(data, "freebucks", "daily", "resetAt"))) };
    }
  }
}
export async function fetchProvider(
  id: CredentialProviderId, options: CredentialOptions, request: Request,
  load: typeof loadCredential = loadCredential, now = Date.now()
): Promise<Snapshot> {
  let plan: string | undefined;
  try {
    const credential = await load(id, options);
    if (!credential) {
      return { id, state: "hidden", windows: [], checkedAt: now,
        message: "No subscription credentials found. Sign in with the provider's CLI, then refresh." };
    }
    plan = credential.plan;
    if (credential.expiresAt !== undefined && credential.expiresAt <= now) {
      throw new ProviderError("Login expired. Open this provider's CLI to renew it, then refresh.", "auth");
    }
    let data: unknown;
    switch (id) {
      case "claude": data = await request("https://api.anthropic.com/api/oauth/usage", credential.token, { "anthropic-beta": "oauth-2025-04-20" }); break;
      case "codex": data = await request("https://chatgpt.com/backend-api/wham/usage", credential.token,
        credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}); break;
      case "copilot": data = await request("https://api.github.com/copilot_internal/user", credential.token); break;
      case "opencode": data = await request("https://opencode.ai/zen/go/v1/usage", credential.token); break;
      case "freebuff": data = await request("https://www.codebuff.com/api/v1/freebuff/session", credential.token); break;
    }
    const result = normalize(id, data, credential);
    if (!result.windows.length && id !== "copilot") { throw new ProviderError("The provider returned no recognized quota windows."); }
    return { id, ...result, state: "ok", checkedAt: now, fetchedAt: now };
  } catch (error) {
    return {
      id, plan, state: error instanceof ProviderError ? error.state : "error",
      message: error instanceof ProviderError ? error.message :
        error instanceof Error && /^(Cannot read|Credential paths)/.test(error.message) ? error.message : "Could not read quota. Open AI Quota logs for details.",
      windows: [], checkedAt: now
    };
  }
}
