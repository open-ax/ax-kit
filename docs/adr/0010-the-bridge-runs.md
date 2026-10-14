# 0010 — the bridge runs

Status: accepted
Date: 2026-10-14

## Context

The trusted tier shipped policy without a rendezvous. Every component of the
chain existed and was unit-tested, and no two components were joined by any
shipped code:

```
MCP client ──stdio──▶ daemon ──loopback /pull, /result──▶ extension worker ──▶ page
```

The middle link did not exist in any shipped artifact. `bridge.ts` described the
design as *"It reads the discovery file for the port and bearer"* — and a
Manifest V3 service worker has no filesystem. `native-host.ts` said in its own
header that the host process did not exist. The manifest requested `sidePanel`
and declared `side_panel.default_path`, and no code called any `chrome.sidePanel`
method.

An end-to-end test did exist, and it passed. It read the discovery file in Node
and passed the port and bearer into the worker as test arguments. It proved the
wire formats agree. It proved nothing could find anything else.

The underlying defect was one signature. `BridgeProvider.listTools()` was
synchronous; `PageBridge.listTools(tabId)` crosses a network and cannot be. The
daemon's README named it as the blocker, and every other gap followed from it.

## Decisions

### D1 — The native host is a broker, not the daemon

Chrome spawns a native-messaging host, so a daemon living there would live
exactly as long as the extension's port — and that port dies whenever the worker
does: an extension reload, an update, a disable, a browser restart.

This was verified rather than assumed, and the evidence cuts both ways. An open
native-messaging port *does* hold the service worker alive longer than the
usual idle window - the Chromium implementation sets
`should_have_strong_keepalive(true)` when it opens the channel to a native app.
But **how much longer is not documented**: the keep-alive is described as helping
with the five-minute limit without promising the limit is removed, and the
documented list of APIs exempt from that limit does not name `connectNative`.
The honest statement is "longer, by an amount nobody promised", not "forever".

What *is* documented is the part that decides the architecture: **Chrome starts
a native messaging host process and keeps it running until the port is
destroyed.** The port dies with the worker - an extension reload, an update, a
disable, a browser restart - and the documented recovery is to call
`connectNative` again from the port's `onDisconnect` handler, which is what this
implementation does.

So the host process is a **broker**: it reads the discovery file, hands over
`{port, bearer}`, and exits. It holds no queue and no authority. A worker that is
culled mid-call costs one abandoned request - the daemon still holds the work,
and the next worker re-pulls it. That property does not depend on how long the
worker survives, which is exactly why it is worth having.

### D2 — Approval is `input_required`, not an error

A consequential tool waiting on a person is the protocol's own multi-round-trip
shape. `InputRequiredResult` is exactly "the server ran, could not finish
without something from the client, here is what I need" — with an
`ElicitRequest` whose form is a single boolean.

The earlier shape under consideration was `isError: true` plus a re-invoke.
Rejected: that teaches every client that a person saying yes is an outage. The
approval binding rides along as `requestState`, which the client is told to
treat as opaque, and which nothing depends on — the binding is always
recomputed from live page values.

### D3 — The document identity comes from the browser

The old code sent `documentId: \`tab-${tabId}\``, commented as "a tab-scoped
placeholder, not a document identity". That is worse than a placeholder: a
string that survives every navigation in a tab is not a weak document identity,
it is no document identity, and it outlives the thing it stands in for.

`chrome.tabs.Tab` has **no** `documentId` field — checked against the API
reference, twice, because the assumption was load-bearing. The only
browser-asserted identities available are those `webNavigation` reports at
commit time, and `webNavigation.getFrame` re-checks a set of ids against the live
document.

So the worker records identities from `onCommitted`, and the binding is built
from that. A caller can still put a `documentId` in the request; it is ignored.
`onCommitted` also replaces the old `tabs.onUpdated {status:"loading"}` heuristic
as the invalidation trigger, because it is both earlier and document-scoped.

Two limits on that gate, found by a verification pass and worth writing down:

- The documentation does not promise `getFrame` returns `null` on a documentId
  mismatch. Chromium returns an empty result, which is what makes it usable, and
  a malformed id rejects the promise instead. The implementation treats a
  rejection and an empty result the same way - refused - so it fails closed on
  both rather than depending on which one it happens to get.
- `chrome.scripting.executeScript` *does* return a `documentId` on its
  `InjectionResult` (Chrome 106+), so the identity was available one layer
  further down without the extra permission. `webNavigation` was kept because it
  also supplies the invalidation signal, which the injection result alone does
  not. That is a weaker reason than the first draft of this ADR gave.

### D3a - Registration on Windows is a registry key, not a directory

`ax-kit-install-native-host` originally wrote the manifest to
`<dir>/NativeMessagingHosts/<name>.json` on every platform. On macOS and Linux
that is how a browser finds one. On Windows the manifest may live anywhere, and
the browser finds it by reading the default value of
`HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`.

The file was therefore written and then read by nothing: a bridge that reported
a successful install and did nothing. Corrected to write the key, through
`reg.exe` so the package keeps zero runtime dependencies. The mistake survived a
research pass and was caught only by verifying that research against the
documentation afterwards, which is the argument for doing that pass at all.

### D3b - Registration on Windows is not scoped to a user-data directory

`HKEY_CURRENT_USER` is per-user, not per-profile. A host registered there is
visible to every Chrome the user runs, including their real browser, so a test
cannot be hermetic on Windows without going through real registration.

Measured, not assumed: a manifest written into `<user-data-dir>/NativeMessagingHosts/`
is *not found* by the browser on Windows even when the file is present and
survives the launch — that is a POSIX mechanism and not one on Windows. The
`chrome_debug.log` line `Can't find manifest for native messaging host …` is how
it was identified. The registry key is the working mechanism.

So the integration test writes that key and removes it afterwards. The removal is
unconditional, but a machine killed mid-run keeps a key pointing at a temporary
manifest, which presents as a bridge that silently is not installed. macOS and
Linux have no equivalent problem and their paths are not yet exercised.

The broader lesson is the one D3a's last sentence makes concrete: four of the six
defects found by running the chain were things a research pass had already
"verified". They were all assertions about what a browser sends, and every one of
them was wrong.

### D4 — The side panel is opened by a person, not by a tool call

`chrome.sidePanel.open()` refuses to run outside a user gesture. Confirmed from
the Chromium implementation, not only the docs: the error is
``sidePanel.open() may only be called in response to a user gesture``, and
`openPanelOnActionClick` defaults to false.

A tool call is not a gesture, so the panel cannot simply appear. Instead
`setPanelBehavior({openPanelOnActionClick: true})` makes it reachable, and the
toolbar badge carries the count. An approval a person has to go and find is
still an approval; an approval panel that silently failed to open is not.

### D5 — Tab switches do not retire approvals

This was implemented and then removed, and the reason is the part worth keeping.
The obvious rule is "retire approvals for tabs the person is no longer looking
at". It is wrong: the confirmation surface can itself be a tab, so reading the
approval retires the approval, and a person checking a reference in another
window loses the question they were asked.

Staleness is decidable elsewhere and is handled there. Navigation discards
approvals bound to the document that is gone, and `verifyAndConsume` re-derives
every part of the binding from live values at the moment of the click.

### D6 — `notifications/tools/list_changed` is not deprecated

The daemon rejected it. Verified against `schema/2026-07-28/schema.ts`: the
notification is still present and only its delivery moved. Rejecting a live
method as unknown is a false negative a client cannot distinguish from a broken
server. Removed from the deprecated set; the remaining six rejections are
correct.

### D7 — `tools/call` refusals go inside the result

The revision is explicit that a tool-level failure belongs in the result with
`isError: true`, so a model can see it and adjust; only "the server cannot serve
this at all" is a JSON-RPC error. The previous implementation refused
`tools/call` with `-32601` at the protocol level, which is the category the
spec reserves for the latter.

### D8 — Work is concurrent, answers are ordered

Frames are dispatched without awaiting each other, so a frame whose tools live
on the far side of a browser does not stop the next frame from starting. Answers
are written in arrival order. Both were needed: concurrent dispatch alone
produced responses out of order, which a client reading the pipe one line at a
time would mis-attribute.

### D9 — The MCP HTTP endpoint exists so a third party can check us

Claiming conformance with `2026-07-28` while validating it only against our own
reading of `2026-07-28` is not evidence — both sides of the test would be the
same author. The specification ships a conformance suite
(`@modelcontextprotocol/conformance`) and it speaks HTTP, so the endpoint that
suite already knows how to drive is the cheapest way to stop arguing with
ourselves.

It implements the documented stateless shape: `POST /mcp` only, `GET`/`DELETE`
answer `405`, `MCP-Protocol-Version` and `Mcp-Method` required on every request
and `Mcp-Name` where a name exists — each validated against the body, so a
disagreement is a refusal rather than a silent preference. No session is ever
minted and an inbound `Mcp-Session-Id` is ignored.

The bearer still gates it, because the transport checks before it routes.

### D10 — What a browser actually sends, measured rather than documented

Four facts the documentation either does not state or states in a form that does
not match the value on the wire. Each one was wrong in this implementation before
it was measured, and each was invisible to the test suite because every one of
them had been tested against a hand-built reply.

1. **A `.cmd` shim shifts the caller's origin in `argv`.** The documentation says
   the first argument to the native messaging host is the caller's origin, which
   is true of the process the browser launches. With a `.cmd` that runs the real
   host as a child, COMSPEC inserts the interpreter and the script path ahead of
   it. The origin is now located by scanning for the value rather than by
   indexing, because the token is unforgeable and the slot is not.
2. **That origin carries a trailing slash**: `chrome-extension://<id>/`, alongside
   `--parent-window=0`. A pattern anchored without it matches nothing.
3. **An extension's `fetch` sends no `Origin` at all.** Holding host permissions
   makes a *privileged* fetch, which the browser exempts from CORS — no
   preflight, no `Origin`. The origin gate therefore admits an absent origin and
   lets the bearer authenticate that caller. A page cannot reach the admitted
   state: it holds no host permissions, so its fetch is ordinary CORS and must
   send an `Origin`, which is then refused unless it is loopback.
4. **CORS headers on the relay endpoints are for browser-based MCP clients, not
   for the extension.** The extension never reads them. They are derived from the
   gate's own verdict rather than echoed from the request, so a refused origin is
   refused at the preflight too and a page is never handed read access to
   endpoints whose security rests on the bearer.

## Consequences

- The shipped daemon serves `tools/list` and `tools/call`. It no longer needs a
  host application to be useful.
- A terminated worker costs one re-pull, not an in-flight call.
- An approval is bound to a document identity the browser minted. A caller
  cannot name its own target.
- The daemon owns two new binaries and the extension two new permissions, each
  justified in the manifest's own comment.
- Compliance is no longer self-attested in the sense that mattered: it can be
  run against the specification's own suite.
- `Mcp-Name` supports a Base64 sentinel for values that are not header-safe, and
  the revision says servers **MUST** decode it before comparing it to the body. The
  first version of this work deliberately did not decode it, reasoning that
  WebMCP tool names are constrained to `[A-Za-z0-9_.-]` and could never need one.
  That reasoning was wrong twice over: the revision only *should*-constrains
  tool names to header-safe characters, and `resources/read` carries a URI, which
  routinely is not header-safe. Now decoded, with a test that sends a
  non-ASCII name.
- Before this bridge was run end to end, the product could list a page's tools
  and execute none of them. `readToolOutcome` required a record where the draft's
  `executeTool()` returns `USVString`, and four other defects of the same kind sat
  behind it: no CORS headers, a required `Origin` the extension never sends, the
  caller's origin read from the wrong `argv` slot, and a pattern that rejected
  the browser's trailing slash. Each had a passing test suite. The chain test in
  `packages/daemon/test/chain-native-host.test.ts` is what they all needed.
- That test writes real registration on Windows and is not hermetic. It removes
  the key unconditionally, and a machine killed mid-run keeps one. This is the
  accepted cost of proving the chain on a platform whose registration is
  per-user, and it is a known gap rather than a hidden one.
