import * as vscode from "vscode";
import { ExtensionApi } from "../src/extension";
import { Snapshot } from "../src/model";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("emanuelebartolesi.vscode-aiquota");
  if (!extension) { throw new Error("AI Quota is not installed"); }
  const api = await extension.activate();
  const now = Date.now();
  let rows: Snapshot[] = [
    { id: "claude", plan: "Max 5x", state: "ok", checkedAt: now, fetchedAt: now,
      windows: [{ label: "5h", remaining: 24, resetsAt: now + 10800000 }, { label: "7d", remaining: 68, resetsAt: now + 345600000 }] },
    { id: "codex", plan: "Plus", state: "ok", checkedAt: now, fetchedAt: now,
      windows: [{ label: "5h", remaining: 82, resetsAt: now + 7200000 }, { label: "7d", remaining: 91, resetsAt: now + 432000000 }] },
    { id: "copilot", plan: "Pro", state: "ok", checkedAt: now, fetchedAt: now,
      windows: [{ label: "Premium", remaining: 56, resetsAt: now + 1728000000 }] },
    { id: "antigravity", plan: "Google AI Pro", state: "auth", checkedAt: now, fetchedAt: now - 600000,
      message: "Antigravity CLI session expired. Run agy and /usage, then refresh AI Quota.",
      windows: [{ label: "Gemini / 5-hour", remaining: 12, resetsAt: now + 3600000 }, { label: "Gemini / Weekly", remaining: 76, resetsAt: now + 604800000 }] },
    { id: "opencode", state: "hidden", checkedAt: now, windows: [],
      message: "No subscription credentials found. Sign in with the provider's CLI, then refresh." },
    { id: "freebuff", plan: "Free", state: "ok", checkedAt: now, fetchedAt: now,
      windows: [{ label: "Day", remaining: 90, resetsAt: now + 36000000 }] }
  ];
  if (process.env.AIQUOTA_UI_CAPACITY_EDGES === "1") {
    rows = [
      { id: "claude", state: "ok", checkedAt: now, fetchedAt: now,
        windows: [{ label: "5h", remaining: 0, resetsAt: now + 3600000 }, { label: "7d", remaining: 60, resetsAt: now + 604800000 }] },
      { id: "antigravity", state: "ok", checkedAt: now, fetchedAt: now, windows: [
        { pool: "gemini", label: "Gemini / 5h", remaining: 0, resetsAt: now + 7200000 },
        { pool: "gemini", label: "Gemini / Weekly", remaining: 30, resetsAt: now + 604800000 },
        { pool: "claude", label: "Claude / 5h", remaining: 55, resetsAt: now + 7200000 },
        { pool: "claude", label: "Claude / Weekly", remaining: 70, resetsAt: now + 604800000 }
      ] },
      { id: "copilot", state: "ok", checkedAt: now, fetchedAt: now, windows: [] },
      { id: "codex", state: "ok", checkedAt: now, fetchedAt: now - 3660000,
        windows: [{ label: "5h", remaining: 85, resetsAt: now + 1800000 }] },
      { id: "freebuff", state: "ok", checkedAt: now, fetchedAt: now,
        windows: [{ label: "Day", remaining: .4, resetsAt: now + 10800000 }] }
    ];
  }
  if (process.env.AIQUOTA_UI_LIVE_CLI === "1") {
    await vscode.workspace.getConfiguration("aiquota").update("providers", ["antigravity"], vscode.ConfigurationTarget.Global);
    for (let attempt = 0; attempt < 150 && !api.snapshots().some(row => row.id === "antigravity"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const snapshot = api.snapshots().find(row => row.id === "antigravity");
    if (snapshot?.state !== "ok" || !snapshot.windows.length) {
      throw new Error(snapshot?.message || "Antigravity CLI did not return live quota.");
    }
  } else {
    api.preview?.(process.env.AIQUOTA_UI_EMPTY === "1" ? [] : rows);
  }
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("aiquota.open");
  // Keep the extension test host alive while Playwright inspects its actual webview.
  await new Promise<void>(() => {});
}
