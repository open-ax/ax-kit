# `@ax-kit/daemon`

Stateless MCP bridge over stdio with local transport and native host.

Pinned protocol: MCP `2026-07-28`, modern-only. The pin is repeated in
every release note so no review happens against an unnamed revision.

Everything here is ours, not the WebMCP draft's: the draft defines the
page surface, while this entry speaks the client protocol on the other
side of the bridge.

## The page bridge

The daemon reaches an extension over the loopback listener. A browser cannot
open a TCP socket, so the extension dials *out*: it pulls a request, executes it
in the Trusted tier, and posts the result back.

A service worker also has no filesystem, so it cannot read the discovery file to
learn the port. `ax-kit-browser-host` is the process Chrome launches through
native messaging on the extension's behalf; it reads that file, hands over the
port and bearer, and exits. It holds no queue, so a worker that is culled
mid-call costs one re-pull rather than the call itself.

Register it once per browser:

```sh
ax-kit-install-native-host "<extension-id>" ["<manifest-directory>"]
```

The directory is an argument rather than a guess, and it defaults to the place
the running browser looks. On macOS and Linux that default is scoped to one
browser profile, so it is genuinely per profile. On Windows the manifest may
live anywhere and is found through a registry key under `HKEY_CURRENT_USER`, so
the registration is per **user** and every Chrome that user runs will see it.

```ts
import { PageBridge, PageBridgeProvider, startTransport } from "@ax-kit/daemon";

const bridge = new PageBridge();
const transport = await startTransport({
  discoveryDir,
  bridge,
  provider: new PageBridgeProvider(bridge),
  info,
});

const tools = await bridge.listTools(tabId);
const result = await bridge.callTool("viewCart", { detailed: true }, tabId, origin);
```

A refusal arrives as a `BridgeRefusal` carrying the worker's own error code, so
a client can tell "not permitted" from "malformed" rather than reading prose.
The tab is always named by the caller; the bridge never guesses one. A call
nobody answers is refused at its deadline rather than left waiting: an envelope
still queued leaves the queue at the same moment, so queued work never starts
after its caller was told it failed. An envelope a client already pulled may
still execute after the deadline — that refusal carries `outcomeUnknown`, not
`badRequest`, because the outcome is unknown rather than refused before
execution.

The shipped daemon owns this bridge. It opens the listener, writes the
discovery file, and serves `tools/list` and `tools/call` itself. The example
above is what that looks like from a host that wants the same wiring explicitly.

With no extension attached it answers `tools/list` with an empty set and
refuses `tools/call` — **inside the result, with `isError: true`**, because that
is where the revision puts a tool that did not succeed. A client that can see
the refusal can tell "nothing ran" from "the server is broken"; what it must
never see is a completion marker with no work behind it.

A consequential tool answers `resultType: "input_required"` with an
`elicitation/create` request, which is the protocol's own multi-round-trip
shape for "I need something from you before I can finish". The client shows it
to the user; when they approve, it re-invokes and the call goes through.

## MCP over HTTP

The daemon also answers `POST /mcp`, so the protocol conformance suite can be
pointed at it. Claiming a revision is not evidence of conforming to it, and
checking our own reading against itself is not a check. The endpoint is the
documented stateless shape: `POST` only, `GET` and `DELETE` answer `405`, no
session is ever minted, and `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
are required and validated against the body.

It sits behind the same bearer as everything else — the transport checks before
it routes, so an unauthenticated caller does not learn the endpoint exists.

## Local transport

The daemon can also serve a loopback listener, so a client finds it through a
discovery file rather than a hard-coded port:

```ts
import { startTransport } from "@ax-kit/daemon";

const transport = await startTransport({ discoveryDir: "/run/user/1000/ax" });
// transport.discoveryPath now holds { port, pid, token, version }
await transport.close(); // removes the file, then stops listening
```

The listener binds loopback only — a non-loopback bind is refused, not warned
about. Every request must carry the bearer from the file in `x-ax-bearer`, and
its `Origin` must be a loopback http(s) origin. A request without either is
refused with 403.

Read the file back the way a client does:

```ts
import { readDiscoveryFile } from "@ax-kit/daemon";

const file = readDiscoveryFile("/run/user/1000/ax");
```

`writeNativeHostManifest` writes the manifest a browser launches, pointing at
the binary's own path rather than an assumed one, after checking that the path
is absolute and is not a bare interpreter invocation.

This package writes that manifest and stops there. Nothing here opens a native
messaging port, so the per-message size cap, the Windows registry-document
rule, the worker-reachability gate, and the renderer-payload sanitizer are not
implemented: they guard a host process this package does not contain. They
belong with that host.

## Use

Run it as a process. It speaks the client protocol on standard input and
output, so any MCP client that can spawn a stdio server can discover this
server and list the tools it holds:

```sh
ax-kit-daemon
```

Frames go in one per line and come out one per line. There is no handshake:
the first frame you send is answered. Diagnostics go to standard error, and
closing standard input is how you stop it.

`tools/call` is answered from whatever the attached page exposes. Work that was
never performed is refused rather than marked complete: a completion marker on a
frame whose work never happened is the worst answer this daemon could give, and
a client that reads one reports the tool as run.

To consume the policy helpers directly, import them:

```ts
import {
  createDaemonInfo,
  dispatchRequest,
  emptyBridgeProvider,
  parseFrame,
  serializeFrame,
} from "@ax-kit/daemon";

const info = createDaemonInfo();
const request = parseFrame(process.argv[2] as string);
// `dispatchRequest` is async because reaching a page is: it crosses a network.
const response = await dispatchRequest(request, emptyBridgeProvider(), info);
process.stdout.write(`${serializeFrame(response)}\n`);
```

Run from source, with a built package:

```sh
pnpm --filter @ax-kit/daemon build
node packages/daemon/bin/ax-kit-daemon.mjs
```

Rules enforced by this package and its tests:

- No handshake and no session header. Every request carries its own
  version and capabilities in `_meta`; mismatches return the version
  error. Discovery (`server/discover`) is mandatory to implement and
  every result carries the completion marker.
- Removed methods (`initialize`, `ping`, dynamic registration) reject as
  unknown methods. Deprecated roots, sampling, and logging stay usable
  during the deprecation window.
- Stdio stays byte-clean: only protocol messages reach stdout, all logs
  go to stderr, frames are newline-delimited with no embedded newlines,
  stdin close is the shutdown signal, and the daemon never initiates a
  request toward the client.
- Local transport uses an ephemeral loopback port with a discovery file
  (`port`, `pid`, `token`, `version`) plus a bearer on upgrade and origin
  validation. The extension dials out over native messaging while the
  daemon dials in; the page never listens.
- The native host manifest carries an absolute path plus a shim or
  single-file binary, never a bare interpreter invocation, and admits only
  `chrome-extension://` origins with no wildcard. The manifest is the whole
  of what this package does with native messaging; it hosts nothing.
