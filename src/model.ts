export const providerIds = ["claude", "codex", "antigravity", "copilot", "opencode", "freebuff"] as const;
export type ProviderId = typeof providerIds[number];
export type CredentialProviderId = Exclude<ProviderId, "antigravity">;
export const providerNames: Record<ProviderId, string> = {
  claude: "Claude", codex: "ChatGPT / Codex", antigravity: "Antigravity",
  copilot: "GitHub Copilot", opencode: "OpenCode Go", freebuff: "Freebuff"
};
export interface QuotaWindow {
  label: string;
  remaining: number;
  resetsAt?: number;
  pool?: string;
}
export interface Snapshot {
  id: ProviderId;
  state: "ok" | "hidden" | "auth" | "error";
  plan?: string;
  message?: string;
  windows: QuotaWindow[];
  checkedAt: number;
  fetchedAt?: number;
}
export interface DisplayWindow extends QuotaWindow { approximate: boolean }
export interface DisplaySnapshot extends Omit<Snapshot, "windows"> { windows: DisplayWindow[] }
export interface CapacityEntry {
  id: ProviderId;
  state: "available" | "partial" | "exhausted" | "unknown";
  reason?: "waiting" | "auth" | "error" | "hidden" | "stale" | "unreported";
  windows: DisplayWindow[];
}
export interface CapacityOverview {
  entries: CapacityEntry[];
  available: number;
  attention: number;
  nextReset?: { id: ProviderId; label: string; resetsAt: number };
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.some(id => id === value);
}
export function providerSelection(values: unknown[]): ProviderId[] {
  return [...new Set(values.map(value => value === "gemini" ? "antigravity" : value).filter(isProviderId))];
}
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => record(current)[key], value);
}
export function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : "";
}
export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) { return value * 1000; }
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function pretty(value: unknown): string {
  return text(value).replace(/[_-]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}
export function windowLabel(seconds: unknown): string {
  const amount = number(seconds);
  if (amount === undefined || amount <= 0) { return "Window"; }
  if (amount >= 86400) { return `${Math.floor(amount / 86400)}d`; }
  if (amount >= 3600) { return `${Math.floor(amount / 3600)}h`; }
  return `${Math.floor(amount / 60)}m`;
}
export function quota(label: string, used: unknown, reset: unknown): QuotaWindow | undefined {
  const percent = number(used);
  if (percent === undefined) { return undefined; }
  return { label, remaining: Math.max(0, Math.min(100, 100 - percent)), resetsAt: timestamp(reset) };
}
export function display(snapshot: Snapshot, ttlSeconds: number, now = Date.now()): DisplaySnapshot {
  return {
    ...snapshot,
    windows: snapshot.windows.map(window => {
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      return {
        ...window,
        remaining: reset ? 100 : window.remaining,
        approximate: reset || snapshot.state !== "ok" || !snapshot.fetchedAt ||
          now - snapshot.fetchedAt > ttlSeconds * 12 * 1000
      };
    })
  };
}
export function mergeFailure(previous: Snapshot | undefined, current: Snapshot): Snapshot {
  if (current.state === "ok" || current.state === "hidden" || !previous) { return current; }
  return { ...current, plan: current.plan ?? previous.plan, windows: previous.windows, fetchedAt: previous.fetchedAt };
}
export function summarizeCapacity(selected: ProviderId[], snapshots: DisplaySnapshot[], now = Date.now()): CapacityOverview {
  let nextReset: CapacityOverview["nextReset"];
  const entries = selected.map((id): CapacityEntry => {
    const snapshot = snapshots.find(row => row.id === id);
    if (!snapshot) { return { id, state: "unknown", reason: "waiting", windows: [] }; }
    if (snapshot.state !== "ok") { return { id, state: "unknown", reason: snapshot.state, windows: [] }; }
    if (!snapshot.windows.length) { return { id, state: "unknown", reason: "unreported", windows: [] }; }
    const pools = new Map<string, DisplayWindow[]>();
    for (const window of snapshot.windows) {
      const pool = window.pool ?? "shared";
      const members = pools.get(pool) ?? [];
      members.push(window);
      pools.set(pool, members);
      if (!window.approximate && window.resetsAt !== undefined && window.resetsAt > now &&
          (!nextReset || window.resetsAt < nextReset.resetsAt)) {
        nextReset = { id, label: window.label, resetsAt: window.resetsAt };
      }
    }
    // Shared windows constrain one allowance; independent pools must not be collapsed.
    const windows = [...pools.values()].map(members => ({
      ...members.reduce((lowest, window) => window.remaining < lowest.remaining ? window : lowest),
      approximate: members.some(window => window.approximate)
    }));
    const available = windows.some(window => !window.approximate && window.remaining > 0);
    const unverified = windows.some(window => window.approximate);
    const exhausted = windows.some(window => !window.approximate && window.remaining === 0);
    return {
      id, windows, reason: unverified ? "stale" : undefined,
      state: available ? unverified || exhausted ? "partial" : "available" : unverified ? "unknown" : "exhausted"
    };
  });
  return {
    entries, nextReset,
    available: entries.filter(entry => entry.state === "available" || entry.state === "partial").length,
    attention: entries.filter(entry => entry.reason && entry.reason !== "waiting" && entry.reason !== "unreported").length
  };
}
export function capacityStatus(capacity: CapacityOverview, now = Date.now()): { text: string; tooltip: string; warning: boolean } {
  const total = capacity.entries.length;
  if (!total) {
    return {
      text: "$(dashboard) AI Quota: Choose providers",
      tooltip: "Your AI capacity\nNo providers selected.\nOpen AI Quota to choose providers.",
      warning: false
    };
  }
  const issues: Record<NonNullable<CapacityEntry["reason"]>, string> = {
    waiting: "Waiting for first check", auth: "Sign in needed", error: "Unavailable",
    hidden: "Not connected", stale: "Refresh to confirm", unreported: "No finite quota reported"
  };
  const lines = [
    "Your AI capacity",
    `${capacity.available} ${capacity.available === 1 ? "provider has" : "providers have"} confirmed quota available; ${total} selected.`,
    ""
  ];
  for (const entry of capacity.entries) {
    const allowances = entry.state === "unknown"
      ? issues[entry.reason ?? "unreported"]
      : entry.windows.map(window => {
        const remaining = window.remaining > 0 && window.remaining < 1 ? "<1" : String(Math.round(window.remaining));
        return `${window.approximate ? "Unverified" : `${remaining}% left`} (${window.label})`;
      }).join("; ");
    const detail = entry.state === "partial" ? entry.reason === "stale"
      ? " Some allowances unverified." : " Some allowances exhausted." :
      entry.state === "exhausted" ? " Quota exhausted." : "";
    lines.push(`${providerNames[entry.id]}: ${allowances}.${detail}`);
  }
  const next = capacity.nextReset;
  if (next && next.resetsAt > now) {
    const minutes = Math.ceil((next.resetsAt - now) / 60000);
    const duration = minutes < 60 ? `${minutes}m` : minutes < 1440
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
    lines.push("", `Next reset: ${providerNames[next.id]} / ${next.label} in ${duration}.`);
  }
  if (capacity.attention) {
    lines.push(`${capacity.attention} ${capacity.attention === 1 ? "provider needs" : "providers need"} attention.`);
  }
  lines.push("", "Open AI Quota for all allowances and reset times.");
  return {
    text: `$(dashboard) AI Quota ${capacity.available}/${total} available${capacity.attention ? ` $(warning) ${capacity.attention}` : ""}`,
    tooltip: lines.join("\n"),
    warning: capacity.attention > 0 || capacity.available === 0 && capacity.entries.some(entry => entry.state === "exhausted")
  };
}
