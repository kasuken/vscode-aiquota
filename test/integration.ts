import assert from "node:assert/strict";
import { join } from "node:path";
import * as vscode from "vscode";
import { ExtensionApi } from "../src/extension";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("emanuelebartolesi.vscode-aiquota");
  assert.ok(extension, "AI Quota extension is discoverable");
  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["open", "refresh", "selectProviders", "settings", "logs", "signIn", "antigravityHelp"]) {
    assert.ok(commands.includes(`aiquota.${command}`), `Command ${command} is registered`);
  }
  assert.deepEqual(vscode.workspace.getConfiguration("aiquota").get("providers"), []);
  await api.refresh();
  assert.deepEqual(api.snapshots(), [], "Unselected providers are not read or queried");
  await vscode.commands.executeCommand("aiquota.open");
  await vscode.commands.executeCommand("workbench.view.extension.aiquota");
  await vscode.commands.executeCommand("aiquota.refresh");
  const settings = vscode.workspace.getConfiguration("aiquota");
  try {
    await settings.update("credentialPaths", {
      antigravity: join(extension.extensionPath, ".test-data", `missing-cli-token-${Date.now()}.json`)
    }, vscode.ConfigurationTarget.Global);
    await settings.update("providers", ["antigravity"], vscode.ConfigurationTarget.Global);
    for (let attempt = 0; attempt < 100 && !api.snapshots().some(row => row.id === "antigravity"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const antigravity = api.snapshots().find(row => row.id === "antigravity");
    assert.ok(antigravity, "Selecting Antigravity reaches its CLI provider");
    assert.equal(antigravity.state, "auth", "Missing configured CLI credentials are reported without reading the user's keyring");
    assert.match(antigravity.message ?? "", /configured token file/);
  } finally {
    await settings.update("providers", [], vscode.ConfigurationTarget.Global);
    await settings.update("credentialPaths", undefined, vscode.ConfigurationTarget.Global);
    await api.refresh();
  }
  assert.ok(extension.isActive);
  console.log("AI Quota integration: activation, commands, opt-in, Antigravity CLI routing, dashboard and sidebar passed.");
}
