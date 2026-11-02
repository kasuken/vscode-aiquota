// @ts-check
(() => {
  const vscode = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const send = type => vscode.postMessage({ type });
  const names = { claude: "Claude", codex: "ChatGPT / Codex", antigravity: "Antigravity", copilot: "GitHub Copilot", opencode: "OpenCode Go", freebuff: "Freebuff" };
  const marks = { claude: "Cl", codex: "Cx", antigravity: "Ag", copilot: "Co", opencode: "Go", freebuff: "Fb" };
  const statuses = { ok: "Up to date", hidden: "Not connected", auth: "Sign in needed", error: "Unavailable" };
  const capacityIssues = { waiting: "Waiting for first check", auth: statuses.auth, error: statuses.error, hidden: statuses.hidden, stale: "Refresh to confirm", unreported: "No finite quota reported" };
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) { element.className = className; }
    if (content !== undefined) { element.textContent = content; }
    return element;
  }
  function relativeReset(time) {
    if (!time) { return "Reset time not provided"; }
    const minutes = Math.ceil((time - Date.now()) / 60000);
    if (minutes <= 0) { return "Reset passed; refresh to confirm"; }
    if (minutes < 60) { return `Resets in ${minutes}m`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `Resets in ${hours}h ${minutes % 60}m`; }
    return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  const format = window => `${window.approximate ? "~" : ""}${window.remaining > 0 && window.remaining < 1 ? "<1" : Math.round(window.remaining)}%`;
  function render(state) {
    get("refresh").disabled = state.refreshing;
    get("refresh").textContent = state.refreshing ? "Checking..." : "Refresh";
    get("empty").hidden = state.selected.length > 0;
    get("count").textContent = `${state.selected.length} selected`;
    get("notice").textContent = state.preview ? "Preview data. These are sample accounts, not your actual quota." :
      state.refreshing ? "Checking selected subscriptions..." : "";
    const list = get("providers");
    list.replaceChildren();
    const rows = state.snapshots;
    const capacity = state.capacity;
    get("subtitle").textContent = !state.selected.length ? "Choose providers to see what you can use." :
      capacity.available ? `${capacity.available} ${capacity.available === 1 ? "provider has" : "providers have"} quota available` :
      capacity.entries.every(entry => entry.state === "exhausted") ? "Your tracked allowances are exhausted" : "No confirmed quota to summarize";
    const overview = get("capacity");
    overview.hidden = !state.selected.length;
    overview.replaceChildren();
    for (const entry of capacity.entries) {
      const item = node("li", `capacity-provider ${entry.state}`);
      const link = node("a", "capacity-name", names[entry.id]);
      link.href = `#provider-${entry.id}`;
      link.setAttribute("aria-label", `View ${names[entry.id]} quota details`);
      link.addEventListener("click", event => {
        event.preventDefault();
        const detail = get(`provider-${entry.id}`);
        detail.focus({ preventScroll: true });
        detail.scrollIntoView({ block: "start" });
      });
      item.append(link);
      const allowances = node("div", "capacity-allowances");
      if (entry.state === "unknown") {
        allowances.append(node("p", "capacity-issue", capacityIssues[entry.reason]));
      } else {
        for (const window of entry.windows) {
          const allowance = node("div", "capacity-allowance");
          allowance.append(node("strong", "capacity-value", window.approximate ? "Unverified" : `${format(window)} left`),
            node("span", "capacity-label", window.label));
          allowances.append(allowance);
        }
        if (entry.state === "partial") {
          allowances.append(node("p", "capacity-issue", entry.reason === "stale" ? "Some allowances unverified" : "Some allowances exhausted"));
        } else if (entry.state === "exhausted") {
          allowances.append(node("p", "capacity-issue", "Quota exhausted"));
        }
      }
      item.append(allowances);
      overview.append(item);
    }
    const next = capacity.nextReset;
    get("next-reset").textContent = next ? `Next reset: ${names[next.id]} / ${next.label}. ${relativeReset(next.resetsAt)}.` : "";
    get("capacity-attention").textContent = capacity.attention
      ? `${capacity.attention} ${capacity.attention === 1 ? "provider needs" : "providers need"} attention` : "";
    for (const id of state.selected) {
      const row = rows.find(item => item.id === id);
      const article = node("article", "provider");
      article.id = `provider-${id}`;
      article.tabIndex = -1;
      article.setAttribute("aria-label", names[id]);
      const info = node("div", "provider-info");
      const title = node("div", "provider-title");
      const mark = node("span", "monogram", marks[id]);
      mark.setAttribute("aria-hidden", "true");
      const identity = node("div");
      identity.append(node("h3", "", names[id]), node("p", "plan", row?.plan || "Subscription"));
      title.append(mark, identity);
      info.append(title, node("span", `state ${row?.state || ""}`, row ? statuses[row.state] : "Waiting for first check"));
      const detail = node("div", "provider-detail");
      if (!row) {
        detail.append(node("p", "message", "Your quota will appear after the first check."));
      } else {
        for (const window of row.windows) {
          const block = node("div", `window ${window.remaining < 20 ? "critical" : window.remaining < 50 ? "low" : ""}`);
          const line = node("div", "window-line");
          const amount = node("span", "amount", `${format(window)} `);
          amount.append(node("small", "", window.remaining < 20 ? "remaining / critical" : window.remaining < 50 ? "remaining / low" : "remaining"));
          line.append(node("span", "window-label", window.label), amount);
          const progress = document.createElement("progress");
          progress.max = 100;
          progress.value = window.remaining;
          progress.setAttribute("aria-label", `${names[id]} ${window.label} quota remaining`);
          progress.setAttribute("aria-valuetext", `${window.approximate ? "Approximately " : ""}${Math.round(window.remaining)} percent remaining`);
          const reset = node("time", "reset", relativeReset(window.resetsAt));
          if (window.resetsAt) { reset.dateTime = new Date(window.resetsAt).toISOString(); reset.title = new Date(window.resetsAt).toLocaleString(); }
          block.append(line, progress, reset);
          detail.append(block);
        }
        if (row.message) { detail.append(node("p", `message ${row.windows.length ? "warning" : ""}`, row.message)); }
        if (row.state === "ok" && !row.windows.length) {
          detail.append(node("p", "message", "No finite quota reported. Your plan may include unlimited usage."));
        }
        if (row.state === "auth" || row.state === "hidden" || id === "antigravity" && row.state === "error") {
          const help = node("button", "link", id === "copilot" ? "Sign in to GitHub" : id === "antigravity" ? "Antigravity setup guide" : "Credential settings");
          help.addEventListener("click", () => send(id === "copilot" ? "signIn" : id === "antigravity" ? "antigravityHelp" : "settings"));
          detail.append(help);
        }
      }
      article.append(info, detail);
      list.append(article);
    }
    const checked = rows.map(row => row.checkedAt).filter(Boolean);
    const oldest = checked.length ? Math.min(...checked) : undefined;
    get("updated").textContent = oldest ? `Checked ${new Date(oldest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} / auto-refresh ${state.interval}s` :
      state.selected.length ? "Waiting for first check" : "No providers selected";
  }
  for (const [id, command] of Object.entries({ refresh: "refresh", manage: "selectProviders", choose: "selectProviders", settings: "settings", logs: "logs" })) {
    get(id).addEventListener("click", () => send(command));
  }
  get("home").addEventListener("click", event => { event.preventDefault(); send("open"); });
  window.addEventListener("message", event => {
    if (event.data?.type === "state") { render(event.data.state); }
  });
  setInterval(() => send("ready"), 60000);
  send("ready");
})();
