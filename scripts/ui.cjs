const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, ".test-data");
  const live = process.env.AIQUOTA_UI_LIVE_CLI === "1";
  const edges = process.env.AIQUOTA_UI_CAPACITY_EDGES === "1";
  const profile = path.join(output, `ui-profile-${process.env.AIQUOTA_UI_EMPTY === "1" ? "empty" : live ? "live-cli" : edges ? "capacity-edges" : "filled"}`);
  await fs.mkdir(path.join(profile, "User"), { recursive: true });
  await fs.writeFile(path.join(profile, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "window.titleBarStyle": "custom",
    "workbench.colorTheme": process.env.AIQUOTA_UI_THEME || "Default Dark Modern",
    "telemetry.telemetryLevel": "off", "security.workspace.trust.enabled": false,
    "update.mode": "none", "extensions.autoUpdate": false, "chat.disableAIFeatures": true
  }));
  const executablePath = process.env.VSCODE_EXECUTABLE_PATH ||
    path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath, env, timeout: 60000,
    args: [
      "--user-data-dir", profile, "--extensions-dir", path.join(output, "extensions"),
      `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, "dist", "test", "uiHarness.js")}`,
      "--skip-welcome", "--skip-release-notes", "--disable-updates", "--disable-workspace-trust",
      "--new-window"
    ]
  });
  try {
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    let dashboard;
    for (let attempt = 0; attempt < 120; attempt++) {
      for (const frame of page.frames()) {
        if (await frame.locator("#heading").count()) { dashboard = frame; break; }
      }
      if (dashboard) { break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!dashboard) {
      await page.screenshot({ path: path.join(output, "ui-failure.png") });
      console.error("Visible VS Code frames:", page.frames().map(frame => frame.url()));
    }
    assert.ok(dashboard, "Dashboard webview is present");
    await dashboard.locator("#heading").waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await dashboard.locator("#heading").innerText(), "Your AI capacity");
    const empty = process.env.AIQUOTA_UI_EMPTY === "1";
    if (empty) {
      await dashboard.getByRole("button", { name: "Choose providers" }).waitFor();
      assert.equal(await dashboard.locator(".provider").count(), 0);
      assert.equal(await dashboard.locator("#capacity").isVisible(), false);
      assert.equal(await dashboard.locator("#next-reset").innerText(), "");
    } else if (live) {
      await dashboard.locator(".provider").first().waitFor();
      assert.equal(await dashboard.locator(".provider").count(), 1);
      assert.equal(await dashboard.locator(".state.ok").count(), 1);
      assert.ok(await dashboard.locator("progress").count() > 0);
      assert.equal(await dashboard.locator("#notice").innerText(), "");
      assert.equal(await dashboard.locator("#subtitle").innerText(), "1 provider has quota available");
      assert.match(await dashboard.locator("#capacity").innerText(), /Antigravity/);
    } else if (edges) {
      await dashboard.locator(".provider").first().waitFor();
      assert.equal(await dashboard.locator("#subtitle").innerText(), "2 providers have quota available");
      assert.equal(await dashboard.locator(".capacity-provider").count(), 5);
      assert.equal(await dashboard.locator(".capacity-provider.partial .capacity-allowance").count(), 2);
      assert.match(await dashboard.locator(".capacity-provider.partial").innerText(), /0% left[\s\S]*55% left/);
      assert.match(await dashboard.locator(".capacity-provider.exhausted").innerText(), /Quota exhausted/);
      assert.match(await dashboard.locator("#capacity").innerText(), /No finite quota reported/);
      assert.match(await dashboard.locator("#capacity").innerText(), /Refresh to confirm/);
      assert.match(await dashboard.locator("#capacity").innerText(), /<1% left/);
      assert.equal(await dashboard.locator("#capacity-attention").innerText(), "1 provider needs attention");
      assert.match(await dashboard.locator("#next-reset").innerText(), /Next reset: Claude \/ 5h/);
    } else {
      await dashboard.locator(".provider").first().waitFor();
      assert.equal(await dashboard.locator(".provider").count(), 6);
      assert.equal(await dashboard.locator("#subtitle").innerText(), "4 providers have quota available");
      assert.equal(await dashboard.locator(".capacity-provider").count(), 6);
      assert.equal(await dashboard.locator(".capacity-provider.available").count(), 4);
      assert.equal(await dashboard.locator(".capacity-provider").first().locator(".capacity-value").innerText(), "24% left");
      assert.equal(await dashboard.locator("#capacity-attention").innerText(), "2 providers need attention");
      assert.match(await dashboard.locator("#next-reset").innerText(), /Next reset: ChatGPT \/ Codex \/ 5h/);
      assert.ok(!(await dashboard.locator("#capacity").innerText()).includes("~12%"));
      assert.equal(await dashboard.locator("progress").count(), 8);
      assert.match(await dashboard.locator("#notice").innerText(), /sample accounts/);
      await dashboard.getByRole("article", { name: "Antigravity", exact: true })
        .getByRole("button", { name: "Antigravity setup guide" }).waitFor();
      await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();
      assert.equal(await dashboard.locator(".provider").count(), 6);
    }
    const status = page.locator(".statusbar-item").filter({ hasText: "AI Quota" }).first();
    await status.waitFor();
    const expectedStatus = empty ? /Choose providers/ : live ? /1\/1 available/ : edges ? /2\/5 available/ : /4\/6 available/;
    assert.match(await status.innerText(), expectedStatus);
    await status.hover();
    const tooltip = page.locator(".monaco-hover").filter({ hasText: "Your AI capacity" }).first();
    await tooltip.waitFor();
    const tooltipText = await tooltip.innerText();
    if (empty) {
      assert.match(tooltipText, /No providers selected/);
    } else {
      assert.match(tooltipText, /confirmed quota available/);
      if (!live) {
        assert.match(tooltipText, /Next reset:/);
        assert.match(tooltipText, edges ? /1 provider needs attention/ : /2 providers need attention/);
        assert.match(tooltipText, edges ? /Some allowances exhausted/ : /Sign in needed/);
      }
    }
    await page.mouse.move(20, 20);
    await page.keyboard.press("Escape");
    await status.click();
    await dashboard.locator("#heading").waitFor();
    await dashboard.locator("#manage").focus();
    assert.equal(await dashboard.locator("#manage").evaluate(element => element === document.activeElement), true);
    if (!empty) {
      await dashboard.locator(".capacity-name").first().click();
      assert.equal(await dashboard.locator(".provider").first().evaluate(element => element === document.activeElement), true, "Capacity links focus the detailed provider");
      await dashboard.evaluate(() => window.scrollTo(0, 0));
    }
    const suffix = `${empty ? "empty" : live ? "live-cli" : edges ? "capacity-edges" : "dashboard"}-${(process.env.AIQUOTA_UI_THEME || "dark").includes("Light") ? "light" : "dark"}`;
    await page.screenshot({ path: path.join(output, `${suffix}.png`) });
    await page.setViewportSize({ width: 580, height: 900 });
    await dashboard.locator("#heading").waitFor();
    assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "No horizontal overflow in narrow dashboard");
    await page.screenshot({ path: path.join(output, `${suffix}-narrow.png`) });
    await dashboard.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByPlaceholder("Only selected providers' credentials will be read.").waitFor({ timeout: 10000 });
    await page.locator(".quick-input-list").getByText("Antigravity", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator(".activitybar").getByRole("tab", { name: "AI Quota", exact: true }).click();
    let sidebar;
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const frame of page.frames()) {
        if (await frame.locator("#heading").count() && await frame.evaluate(() => window.innerWidth < 450)) {
          sidebar = frame;
          break;
        }
      }
      if (sidebar) { break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(sidebar, "Activity bar opens the AI Quota sidebar");
    await sidebar.locator("#count").filter({ hasText: empty ? "0 selected" : live ? "1 selected" : edges ? "5 selected" : "6 selected" }).waitFor();
    assert.equal(await sidebar.locator("#heading").isVisible(), true);
    assert.equal(await sidebar.locator("#subtitle").innerText(), await dashboard.locator("#subtitle").innerText());
    if (!empty) {
      assert.equal(await sidebar.locator(".capacity-provider").count(), await dashboard.locator(".capacity-provider").count());
    }
    assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "No horizontal overflow in sidebar");
    await page.screenshot({ path: path.join(output, `${suffix}-sidebar.png`) });
    console.log(`AI Quota UI passed (${suffix}); actual VS Code screenshots saved in .test-data.`);
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
