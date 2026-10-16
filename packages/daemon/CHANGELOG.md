# @ax-kit/daemon

## 0.1.0

### Minor Changes

- 88fcd66: Serve `tools/call` from the shipped daemon, and connect the extension to it.
  
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
- 88fcd66: First public release of @ax-kit/daemon.

### Patch Changes

- 88fcd66: Fix the bridge, which could never reach a live browser.
  
  The extension could not reach the daemon through the native host, and a tool
  call could not have succeeded even if it had. Four defects, all of them
  invisible to a suite that tested hand-built replies instead of what a browser
  actually sends: the origin gate required a header the extension's privileged
  CORS-exempt fetch never sends; the broker read the caller's origin from an
  `argv` slot a `.cmd` shim shifts; the origin pattern rejected the trailing
  slash the browser adds; and a successful tool result was refused because the
  draft returns a string and the reader required a record.
  
  The worker also no longer retries a host that has never answered: a browser with
  no host registered answered 2812 connect attempts in about a second and a half.
- 43a5519: Check the MCP surface with the specification's own conformance suite, and
  record what it says.
  
  The protocol claim was previously checked by this repository's reading of the
  protocol, which means both sides of the check were the same author. The suite
  is now a development-time devDependency, run against the daemon's `POST /mcp`
  endpoint, with its output archived verbatim under `protocol-results/`.
  
  **The measured result is that the suite cannot yet measure anything.** All
  twenty `2026-07-28` scenarios the suite reaches, including every `tools/call`,
  are refused with `HTTP 403`. The cause is the `x-ax-bearer` header this daemon
  requires: the suite has no way to send credentials, and its `--help` offers no
  header, auth or bearer option.
  
  The bearer stays. It is what stops a web page on the machine from reaching the
  daemon, so removing it to produce a green number would trade this project's one
  externally-checkable security property for a cosmetic result. The endpoint under
  test is deliberately the same endpoint an agent reaches through the bridge; a
  second unguarded one would be a second unguarded way into the page.
  
  So this is a recorded finding rather than a passing number, and no conformance
  claim about MCP rests on it. What the run establishes is the coverage - 20
  scenarios reached of 40 declared for this revision - and the shape of the gap.
  Closing it needs the suite to grow a way to send credentials.
  
  Two version traps are recorded in the test because either would produce a
  confident, meaningless figure. The current `latest` tag of the suite
  (`0.1.16`) has no scenarios for `2026-07-28` at all; it must be the alpha. And
  the run is filtered by `--spec-version`, because an unfiltered run includes
  `2025-06-18` scenarios asserting an `initialize` handshake that this revision
  removed.
  
  No shipped artifact imports the suite, and `packages/core` still declares zero
  runtime dependencies.
