# `@ax-kit/daemon`

Stateless MCP bridge over stdio with local transport and native host.

Pinned protocol: MCP `2026-07-28`, modern-only. The pin is repeated in
every release note so no review happens against an unnamed revision.

Everything here is ours, not the WebMCP draft's: the draft defines the
page surface, while this entry speaks the client protocol on the other
side of the bridge.

## Use

```ts
import {
	createDaemonInfo,
	dispatchRequest,
	parseFrame,
	serializeFrame,
} from "@ax-kit/daemon";

const info = createDaemonInfo();
const request = parseFrame(process.argv[2] as string);
const response = dispatchRequest(request, [], info);
process.stdout.write(`${serializeFrame(response)}\n`);
```

Rules enforced by this package and its tests:

- No handshake and no session header. Every request carries its own
  version and capabilities in `_meta`; mismatches return the version
  error. Discovery (`server/discover`) is mandatory to implement and
  every result carries the completion marker.
- No deprecated capabilities: directory roots, sampling, logging, and
  dynamic registration are absent and reject as unknown methods.
- Stdio stays byte-clean: only protocol messages reach stdout, all logs
  go to stderr, frames are newline-delimited with no embedded newlines,
  stdin close is the shutdown signal, and the daemon never initiates a
  request toward the client.
- Local transport uses an ephemeral loopback port with a discovery file
  (`port`, `pid`, `token`, `version`) plus a bearer on upgrade and origin
  validation. The extension dials out over native messaging while the
  daemon dials in; the page never listens.
- The native host manifest carries an absolute path plus a shim or
  single-file binary (never a bare interpreter invocation), the Windows
  registry points at the manifest document, per-direction size limits are
  honored, and host messaging is reachable only from extension pages and
  the service worker with renderer input validated and sanitized.
