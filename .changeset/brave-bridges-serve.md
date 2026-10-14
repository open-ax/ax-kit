---
"@ax-kit/daemon": minor
"@ax-kit/extension": minor
---

Serve `tools/call` from the shipped daemon, and connect the extension to it.

The Trusted tier shipped policy without a rendezvous. Every component of the
chain existed and none was joined to any other by shipped code: a service
worker has no filesystem, so the "read the discovery file" design could not
work, and the daemon refused every call because it held an empty provider.

- The daemon now owns a `PageBridge`, opens its listener, and serves
  `tools/list` and `tools/call`. A tool that fails answers inside the result
  with `isError: true`, and a consequential tool waiting on a person answers
  `resultType: "input_required"` with an `elicitation/create` request — the
  revision's own shape for needing something from the client.
- `ax-kit-browser-host` is the process Chrome launches through native
  messaging: it reads the discovery file, hands over the port and bearer, and
  exits. Register it with `ax-kit-install-native-host <extension-id> [directory]`.
  It holds no queue, so a culled worker costs one re-pull rather than an
  in-flight call. On Windows the registration is a registry key, because that is
  where the browser looks for one; macOS and Linux use the profile directory.
- The extension gained `nativeMessaging` and `webNavigation`. The second is
  because `chrome.tabs.Tab` carries no `documentId`: approvals are now bound to
  an identity the browser mints, replacing a tab-scoped placeholder that
  survived every navigation in the tab.
- The side panel is reachable. `chrome.sidePanel.open()` requires a user
  gesture, so the toolbar badge carries the count rather than the panel
  appearing on its own.
- The loopback listener accepts the extension's origin and still refuses every
  web origin, and `/pull` is held open rather than answered instantly, so an
  idle bridge does not spin.
- The daemon answers `POST /mcp`, so the MCP conformance suite can be pointed at
  it instead of this repository checking its own reading against itself.
- `notifications/tools/list_changed` is no longer rejected. The `2026-07-28`
  schema still carries it; only its delivery moved.
- The discovery directory resolves on Windows, where neither `XDG_RUNTIME_DIR`
  nor `HOME` is normally set.
