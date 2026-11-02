const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

const root = path.resolve(__dirname, "..");
const executable = process.env.VSCODE_EXECUTABLE_PATH ||
  (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe") : undefined);
runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "dist", "test", "integration.js"),
  launchArgs: [
    "--user-data-dir", path.join(root, ".test-data", "integration-profile"),
    "--extensions-dir", path.join(root, ".test-data", "extensions"),
    "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-updates"
  ]
}).catch(error => { console.error(error); process.exitCode = 1; });
