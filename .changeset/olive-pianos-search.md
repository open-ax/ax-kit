---
"@ax-kit/daemon": patch
---

Check the MCP surface with the specification's own conformance suite, and
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