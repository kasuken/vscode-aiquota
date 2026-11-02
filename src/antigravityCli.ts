import { Credential } from "./credentials";
import { loadAntigravityCredential } from "./antigravityAuth";
import { fetchAntigravity } from "./antigravity";
import { at, number, QuotaWindow, record, Snapshot, text, timestamp } from "./model";
import { createRequest, ProviderError } from "./providers";

type Request = ReturnType<typeof createRequest>;
type LoadCredential = (timeout: number, path?: string) => Promise<Credential | undefined>;
const cloudCode = "https://daily-cloudcode-pa.googleapis.com/v1internal:";

export function normalizeAntigravitySummary(data: unknown, assist: unknown): Pick<Snapshot, "plan" | "windows"> {
  const body = record(data);
  const summary = record(body.response ?? body.summary ?? data);
  if (body.error !== undefined || summary.error !== undefined) { throw new ProviderError("Antigravity CLI quota summary returned an error."); }
  const groups = summary.groups ?? (Array.isArray(summary.buckets) ? [{ displayName: "Gemini", buckets: summary.buckets }] : undefined);
  if (!Array.isArray(groups)) { throw new ProviderError("Antigravity CLI returned an unrecognized quota summary."); }
  const windows: QuotaWindow[] = [];
  for (const [index, group] of groups.entries()) {
    const buckets = at(group, "buckets");
    if (!Array.isArray(buckets)) { throw new ProviderError("Antigravity CLI returned invalid quota buckets."); }
    for (const bucket of buckets) {
      if (at(bucket, "disabled") === true) { continue; }
      const fraction = at(bucket, "remainingFraction");
      const amount = at(bucket, "remainingAmount");
      const reset = timestamp(at(bucket, "resetTime"));
      let left = number(fraction);
      if (fraction === undefined) {
        if (amount === 0 || amount === "0") { left = 0; }
        else if (amount !== undefined) {
          if (typeof amount === "number" && Number.isFinite(amount) && amount > 0 ||
              typeof amount === "string" && /^[1-9]\d*$/.test(amount)) { continue; }
          throw new ProviderError("Antigravity CLI returned an invalid remaining allowance.");
        } else if (reset !== undefined) { left = 0; }
      }
      if (left === undefined || left < 0 || left > 1) {
        throw new ProviderError("Antigravity CLI returned an invalid remaining quota fraction.");
      }
      const groupLabel = text(at(group, "displayName"));
      const bucketLabel = text(at(bucket, "displayName")) || text(at(bucket, "window")) || text(at(bucket, "bucketId"));
      if (!bucketLabel) { throw new ProviderError("Antigravity CLI returned an unnamed quota window."); }
      windows.push({ label: `${groupLabel ? `${groupLabel} / ` : ""}${bucketLabel}`, remaining: left * 100, resetsAt: reset, pool: `group-${index}` });
    }
  }
  if (!windows.length) {
    throw new ProviderError("Antigravity CLI reported no finite percentage quotas. Run /usage in agy to inspect the available allowances.");
  }
  return {
    plan: text(at(assist, "paidTier", "name")) || text(at(assist, "currentTier", "name")) || "Antigravity",
    windows
  };
}
export async function fetchAntigravityCli(
  timeoutSeconds: number, customPath?: string,
  load: LoadCredential = loadAntigravityCredential, request?: Request
): Promise<Snapshot | undefined> {
  const checkedAt = Date.now();
  const deadline = checkedAt + timeoutSeconds * 1000;
  const budget = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) { throw new ProviderError("Antigravity CLI quota request timed out."); }
    return milliseconds;
  };
  try {
    const credential = await load(budget(), customPath);
    if (!credential) { return undefined; }
    if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
      throw new ProviderError("Antigravity CLI's saved access token has expired. Run agy and /usage, then refresh AI Quota. Credentials are never refreshed by this extension.", "auth");
    }
    const post = (method: string, body: unknown) =>
      (request ?? createRequest(budget() / 1000))(`${cloudCode}${method}`, credential.token, { "User-Agent": "antigravity" }, body);
    const assist = await post("loadCodeAssist", {});
    const projectValue = at(assist, "cloudaicompanionProject");
    const project = typeof projectValue === "string" ? projectValue : at(projectValue, "id");
    if (projectValue !== undefined && (typeof project !== "string" || !project.trim())) {
      throw new ProviderError("Antigravity CLI returned an invalid Cloud Code project.");
    }
    const summary = await post("retrieveUserQuotaSummary", typeof project === "string" ? { project: project.trim() } : {});
    return { id: "antigravity", state: "ok", checkedAt, fetchedAt: Date.now(), ...normalizeAntigravitySummary(summary, assist) };
  } catch (error) {
    return {
      id: "antigravity", state: error instanceof ProviderError ? error.state : "error", checkedAt, windows: [],
      message: error instanceof ProviderError ? error.message : "Cannot read Antigravity CLI quota. Run /usage in agy, then refresh AI Quota."
    };
  }
}
export async function fetchAntigravityQuota(timeoutSeconds: number, customPath?: string): Promise<Snapshot> {
  const cli = await fetchAntigravityCli(timeoutSeconds, customPath);
  if (cli) { return cli; }
  if (customPath) {
    return { id: "antigravity", state: "auth", checkedAt: Date.now(), windows: [],
      message: "Antigravity CLI's configured token file was not found. Check aiquota.credentialPaths.antigravity." };
  }
  return fetchAntigravity(timeoutSeconds);
}
