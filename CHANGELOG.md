# Changelog

Notable changes to AI Quota are documented here. Dates use the release date.

## [0.1.4] - 2026-11-02

### Changed

- Reworked the README with a real VS Code screenshot, Marketplace installation
  links, a clearer feature overview, a command reference, and troubleshooting FAQ.
- Kept detailed Antigravity setup and privacy notes in expandable sections.
- Improved Marketplace search metadata and added documentation and issue links.

No runtime behavior changes.

## [0.1.3] - 2026-11-02

First public release of AI Quota for VS Code.

### Added

- **One view of your AI capacity** — Monitor Claude, ChatGPT / Codex,
  Antigravity, GitHub Copilot, OpenCode Go, and Freebuff in a dashboard, an
  activity bar view, and the status bar.
- **Useful quota details** — See remaining allowances, provider-specific quota
  windows, confirmed reset times, and accounts that need attention without
  treating different providers' limits as one shared balance.
- **Antigravity CLI support** — Read the CLI's existing saved session from the
  OS keyring or token file, with the legacy IDE available as a read-only
  fallback.
- **Flexible provider controls** — Choose which providers to check and
  configure refresh intervals, request timeouts, status bar visibility, and
  optional credential paths.
- **Privacy-conscious checks** — Nothing is queried until you select a
  provider. Existing credentials are read-only; tokens are not cached or
  logged, and the extension collects no analytics or telemetry.

[0.1.4]: https://github.com/kasuken/vscode-aiquota/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kasuken/vscode-aiquota/releases/tag/v0.1.3
