import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

export function webviewHtml(webview: vscode.Webview, root: vscode.Uri, compact = false): string {
  const nonce = randomBytes(24).toString("base64");
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, "media", "dashboard.css"));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, "media", "dashboard.js"));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>AI Quota</title></head>
<body${compact ? ' class="compact"' : ""}>
<main>
  <header class="toolbar"><a class="wordmark" href="#" id="home" aria-label="AI Quota dashboard"><span class="brand-mark" aria-hidden="true">|||</span> AI Quota</a>
    <div class="actions"><button id="manage">Providers</button><button id="refresh" class="primary">Refresh</button></div>
  </header>
  <section id="overview" aria-labelledby="heading">
    <div class="intro"><h1 id="heading">Your AI capacity</h1><p id="subtitle">Choose providers to see what you can use.</p></div>
    <ul id="capacity" class="capacity-grid" aria-label="Quota available by provider" hidden></ul>
    <div class="capacity-notes"><p id="next-reset"></p><p id="capacity-attention"></p></div>
  </section>
  <div class="section-heading"><h2>Subscriptions</h2><span id="count"></span></div>
  <div id="notice" role="status" aria-live="polite"></div>
  <div id="providers"></div>
  <section id="empty" hidden><div class="empty-gauge" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <h2>Start with the AI you use.</h2><p>Choose your providers to see remaining quota and reset times. AI Quota reads existing CLI logins or Antigravity's local service without changing your accounts.</p>
    <button id="choose" class="primary">Choose providers</button><p class="privacy">No API keys. No token refreshes. No telemetry.</p>
  </section>
  <footer><span id="updated">No providers selected</span><div><button id="logs" class="link">Logs</button><button id="settings" class="link">Settings</button></div></footer>
</main><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
