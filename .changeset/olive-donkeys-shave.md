---
"@ax-kit/daemon": patch
"@ax-kit/extension": patch
---

Fix the bridge, which could never reach a live browser.

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