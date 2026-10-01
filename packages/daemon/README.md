# `@ax-kit/daemon`

Stateless MCP bridge over stdio with local transport and native host.

Pinned protocol: MCP `2026-07-28`, modern-only. The pin is repeated in
every release note so no review happens against an unnamed revision.

Everything here is ours, not the WebMCP draft's: the draft defines the
page surface, while this entry speaks the client protocol on the other
side of the bridge.

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
the binary's own path rather than an assumed one. On Windows the registry entry
is the manifest document, never the binary.

## Use

Run it as a process. It speaks the client protocol on standard input and
output, so any MCP client that can spawn a stdio server can drive it:

```sh
ax-kit-daemon
```

Frames go in one per line and come out one per line. There is no handshake:
the first frame you send is answered. Diagnostics go to standard error, and
closing standard input is how you stop it.

To consume the policy helpers directly, import them:

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
  single-file binary (never a bare interpreter invocation), the Windows
  registry points at the manifest document, per-direction size limits are
  honored, and host messaging is reachable only from extension pages and
  the service worker with renderer input validated and sanitized.
