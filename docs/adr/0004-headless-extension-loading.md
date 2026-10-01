# 4. Headless Chromium can load an unpacked extension

Date: 2026-10-01
Status: Accepted

## Context

The extension package shipped policy functions and nothing loadable: no
`chrome.*` reference anywhere in its source, and no emitted manifest. Proving
the trusted-tier bridge needed a browser that would load an unpacked extension,
start its service worker, and let a test observe that worker.

That question had to be answered before the bridge was designed around it,
because the answer determines the shape of everything downstream. If headless
Chromium cannot load extensions, the fallback is a harness against a
platform-API double, and that earns a weaker claim.

## Verified on 2026-10-01

Playwright 1.63.0, Chromium **153.0.8010.12**, Windows, a Manifest V3
extension with a module service worker, loaded unpacked via
`--disable-extensions-except` plus `--load-extension`.

| Launch mode | Service worker observed | `worker.evaluate` returned |
|---|---|---|
| bundled Chromium, `headless: true` | no — timed out | — |
| `channel: "chromium"`, `headless: true` | yes | `worker-alive` |
| bundled Chromium, `headless: false` | yes | `worker-alive` |

The worker was reachable at a `chrome-extension://` origin and a value set on
its global by the worker script was read back from the test process. Extension
ID is derived from the unpacked path, so it differs per run and must not be
asserted literally.

## Decision

**Use `channel: "chromium"` for headless extension tests.** The default
bundled Chromium in headless mode is the headless shell, which does not load
extensions. The `chromium` channel is the full browser binary with the new
headless mode, and it loads them.

No fallback harness is needed. The reduced claim D2 reserves for a failed spike
does not apply.

## Why the default headless mode fails

Playwright resolves the bundled `chromium` channel in headless mode to a
separate `chromium_headless_shell` binary — the install directory contains
both. The shell omits extension support. This is a property of which binary
gets launched, not of the `--load-extension` flag, and no flag combination
recovers it. The fix is the channel, not the arguments.

## Consequences

- Extension tests launch with `channel: "chromium"` and `headless: true`. Any
  test that loads an unpacked extension must do this or it will silently
  observe no worker.
- The `chromium` browser must be installed in CI. The headless shell alone is
  not sufficient.
- The extension ID varies per unpacked path, so tests address the worker
  through `context.serviceWorkers()` rather than a hard-coded ID.
- Service-worker observation needs no sleep. Attach the listener first, then
  open a page; a worker started before the listener attached is already visible
  in `context.serviceWorkers()`. Checking the collection before awaiting the
  event avoids the missed-start race.

## Revisit when

- Playwright changes which binary bundled headless mode resolves to.
- Chromium drops extension support in the new headless mode.