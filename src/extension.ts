import * as vscode from "vscode";
import { CredentialOptions } from "./credentials";
import { capacityStatus, display, isProviderId, mergeFailure, ProviderId, providerIds, providerNames, providerSelection, record, Snapshot, summarizeCapacity } from "./model";
import { createRequest, fetchProvider } from "./providers";
import { fetchAntigravityQuota } from "./antigravityCli";
import { webviewHtml } from "./webview";

interface Configuration {
  providers: ProviderId[];
  interval: number;
  timeout: number;
  showStatusBar: boolean;
  paths: CredentialOptions["paths"];
}
export interface ExtensionApi {
  refresh(): Promise<void>;
  snapshots(): Snapshot[];
  preview?: (snapshots: Snapshot[] | undefined) => void;
}
function validSnapshot(value: unknown): value is Snapshot {
  const row = record(value);
  return isProviderId(row.id) && ["ok", "hidden", "auth", "error"].includes(String(row.state)) &&
    typeof row.checkedAt === "number" && Number.isFinite(row.checkedAt) &&
    (row.fetchedAt === undefined || typeof row.fetchedAt === "number" && Number.isFinite(row.fetchedAt)) &&
    (row.plan === undefined || typeof row.plan === "string") &&
    (row.message === undefined || typeof row.message === "string") &&
    Array.isArray(row.windows) && row.windows.every(value => {
      const window = record(value);
      return typeof window.label === "string" && typeof window.remaining === "number" &&
        Number.isFinite(window.remaining) && window.remaining >= 0 && window.remaining <= 100 &&
        (window.pool === undefined || typeof window.pool === "string") &&
        (window.resetsAt === undefined || typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt));
    });
}
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel("AI Quota", { log: true });
  const savedProviders = vscode.workspace.getConfiguration("aiquota").inspect<unknown[]>("providers")?.globalValue;
  if (savedProviders?.includes("gemini")) {
    await vscode.workspace.getConfiguration("aiquota").update("providers", providerSelection(savedProviders), vscode.ConfigurationTarget.Global);
    output.info("Migrated Gemini CLI selection to Antigravity. Gemini CLI quota cache is not reused.");
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.name = "AI Quota";
  status.command = "aiquota.open";
  const cached: unknown = context.globalState.get("quotaCache", []);
  let cache: Snapshot[] = Array.isArray(cached) ? cached.filter(validSnapshot) : [];
  let preview: Snapshot[] | undefined;
  let panel: vscode.WebviewPanel | undefined;
  const views = new Set<vscode.Webview>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let flight: Promise<void> | undefined;
  let disposed = false;
  let generation = 0;
  const config = (): Configuration => {
    const settings = vscode.workspace.getConfiguration("aiquota");
    const localPaths = settings.inspect<CredentialOptions["paths"]>("credentialPaths")?.globalValue ?? {};
    return {
      providers: providerSelection(settings.get<unknown[]>("providers", [])),
      interval: Math.max(30, Math.min(86400, settings.get<number>("refreshIntervalSeconds", 300))),
      timeout: Math.max(1, Math.min(60, settings.get<number>("requestTimeoutSeconds", 8))),
      showStatusBar: settings.get<boolean>("showStatusBar", true), paths: localPaths
    };
  };
  const current = () => {
    const settings = config();
    const selected = preview ? preview.map(row => row.id) : settings.providers;
    const snapshots = (preview ?? cache).filter(row => selected.includes(row.id)).map(row => display(row, settings.interval));
    return { selected, snapshots, capacity: summarizeCapacity(selected, snapshots), interval: settings.interval, refreshing: !!flight, preview: !!preview };
  };
  const publish = () => {
    if (disposed) { return; }
    const state = current();
    for (const view of views) { void view.postMessage({ type: "state", state }); }
    const summary = capacityStatus(state.capacity);
    status.text = summary.text;
    status.tooltip = `${state.preview ? "Preview data. Sample accounts, not your actual quota.\n\n" : ""}${summary.tooltip}`;
    status.accessibilityInformation = { label: status.tooltip };
    status.backgroundColor = summary.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    if (config().showStatusBar) { status.show(); } else { status.hide(); }
  };
  async function refresh(): Promise<void> {
    if (flight) { return flight; }
    if (preview || disposed) { publish(); return; }
    const settings = config();
    const version = generation;
    const options: CredentialOptions = {
      paths: settings.paths,
      githubToken: async () => {
        const session = await vscode.authentication.getSession("github", ["read:user"], { silent: true });
        return session?.accessToken;
      }
    };
    // Defer work until flight is assigned so every refresh publishes its busy state.
    flight = Promise.resolve().then(async () => {
      const results = await Promise.all(settings.providers.map(async id => {
        const row = id === "antigravity"
          ? await fetchAntigravityQuota(settings.timeout, settings.paths.antigravity)
          : await fetchProvider(id, options, createRequest(settings.timeout));
        if (row.state !== "ok") { output.warn(`${providerNames[id]}: ${row.message}`); }
        return mergeFailure(cache.find(previous => previous.id === id), row);
      }));
      if (disposed || version !== generation) { return; }
      cache = results;
      await context.globalState.update("quotaCache", cache);
    }).catch(() => {
      output.error("Quota refresh or cache persistence failed. Check VS Code storage permissions.");
      void vscode.window.showErrorMessage("AI Quota could not save quota data. See AI Quota logs.");
    }).finally(() => { flight = undefined; publish(); });
    publish();
    return flight;
  }
  const open = () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel("aiquota.dashboard", "AI Quota", vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    });
    const webview = panel.webview;
    attach(webview);
    panel.onDidDispose(() => { views.delete(webview); panel = undefined; }, undefined, context.subscriptions);
  };
  function attach(webview: vscode.Webview, compact = false): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] };
    views.add(webview);
    const allowed = new Set(["open", "refresh", "selectProviders", "settings", "logs", "signIn", "antigravityHelp"]);
    context.subscriptions.push(webview.onDidReceiveMessage((message: unknown) => {
      const type = record(message).type;
      if (type === "ready") { publish(); }
      else if (typeof type === "string" && allowed.has(type)) {
        void vscode.commands.executeCommand(`aiquota.${type}`);
      }
    }));
    webview.html = webviewHtml(webview, context.extensionUri, compact);
  }
  const selectProviders = async () => {
    const selected = config().providers;
    const result = await vscode.window.showQuickPick(providerIds.map(id => ({
      label: providerNames[id], description: id, picked: selected.includes(id), id
    })), { canPickMany: true, title: "AI Quota providers", placeHolder: "Only selected providers' credentials will be read." });
    if (result !== undefined) {
      const chosen = new Set(result.map(item => item.id));
      const ordered = [...selected.filter(id => chosen.has(id)), ...result.map(item => item.id).filter(id => !selected.includes(id))];
      await vscode.workspace.getConfiguration("aiquota").update("providers", ordered, vscode.ConfigurationTarget.Global);
    }
  };
  context.subscriptions.push(
    output, status,
    vscode.commands.registerCommand("aiquota.open", open),
    vscode.commands.registerCommand("aiquota.refresh", refresh),
    vscode.commands.registerCommand("aiquota.selectProviders", selectProviders),
    vscode.commands.registerCommand("aiquota.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:emanuelebartolesi.vscode-aiquota")),
    vscode.commands.registerCommand("aiquota.logs", () => output.show()),
    vscode.commands.registerCommand("aiquota.antigravityHelp", () => vscode.env.openExternal(vscode.Uri.parse("https://antigravity.google/docs/cli/commands/usage"))),
    vscode.commands.registerCommand("aiquota.signIn", async () => {
      try {
        await vscode.authentication.getSession("github", ["read:user"], { createIfNone: true });
        if (!config().providers.includes("copilot")) {
          await vscode.workspace.getConfiguration("aiquota").update("providers", [...config().providers, "copilot"], vscode.ConfigurationTarget.Global);
        } else { await refresh(); }
      } catch {
        output.warn("GitHub sign-in did not complete.");
        void vscode.window.showWarningMessage("AI Quota: GitHub sign-in did not complete. Try again from the dashboard.");
      }
    }),
    vscode.window.registerWebviewViewProvider("aiquota.sidebar", {
      resolveWebviewView(view) {
        attach(view.webview, true);
        view.onDidDispose(() => views.delete(view.webview), undefined, context.subscriptions);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration("aiquota")) { return; }
      generation++;
      schedule();
      publish();
      const previous = flight;
      void (previous ?? Promise.resolve()).then(() => refresh());
    }),
    { dispose() { disposed = true; if (timer) { clearInterval(timer); } panel?.dispose(); views.clear(); } }
  );
  context.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) { publish(); } }));
  function schedule(): void {
    if (timer) { clearInterval(timer); }
    timer = setInterval(() => { void refresh(); }, config().interval * 1000);
  }
  schedule();
  publish();
  await refresh();
  const api: ExtensionApi = { refresh, snapshots: () => structuredClone(cache) };
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    api.preview = snapshots => { preview = snapshots; publish(); };
  }
  return api;
}
