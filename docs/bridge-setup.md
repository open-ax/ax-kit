# Setting up the bridge

How to get a running `ax-kit` bridge on this machine: the prerequisites, the
commands in order, what each platform does differently, and a walk of the whole
procedure that was actually executed.

Read this before the first run. It is written for someone who did not write the
code.
- [Prerequisites](#prerequisites)
- [Windows](#windows)
- [macOS](#macos)
- [Linux](#linux)
- [Platform differences](#platform-differences)
- [Stopping the bridge](#stopping-the-bridge)
- [What the walk recorded](#what-the-walk-recorded)
- [What the walk found](#what-the-walk-found)

## Prerequisites

Check these before the commands below. The one-command start checks the first
two itself and refuses with the command to fix them; the third and fourth it
cannot check for you.

| #   | Prerequisite                             | How to check                              | If it is missing                                     |
| --- | ---------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| 1   | Node `>=24.19.0 <25`                     | `node --version`                          | Install Node 24. `.nvmrc` pins `24.21.0`.            |
| 2   | Dependencies installed                   | `node -e "require.resolve('typescript')"` | `pnpm install`                                       |
| 3   | A Chromium browser, version 116 or later | launch it                                 | The manifest declares `minimum_chrome_version: 116`. |
| 4   | The extension's id                       | see below                                 | The bridge cannot be registered without it.          |

**The extension id is the one thing you have to find by hand.** Chromium assigns
it to an unpacked extension and derives it from the load path, so it is not
computable from a repository checkout. After loading the extension (step 3 in
each platform below), open `chrome://extensions` and copy the 32-character id
under **ax-kit**. It is 32 characters from `a` to `p`.

The starter validates it before doing anything and will not accept a wrong shape,
but it cannot check it against your browser. If the bridge does not come up, an
id that does not match the browser's is the first thing to compare.

## Windows

Demonstrated. This is the platform the recorded walk ran on.

```sh
pnpm --filter @ax-kit/daemon run build
pnpm --filter @ax-kit/extension run build
```

```sh
node scripts/bridge.mjs --extension-id <32 characters from a-p>
```

```sh
# 3. Load the extension. Open chrome://extensions, turn on Developer mode,
#    choose "Load unpacked", and pick:
packages\extension\dist\unpacked
```

```sh
# 4. Copy the id from chrome://extensions, then confirm the panel says the
#    bridge is attached. Reload the extension if it was already loaded.
```

Then point an MCP client at the daemon. It speaks the protocol over stdio and
needs no configuration:

```json
{
	"mcpServers": {
		"ax-kit": {
			"command": "node",
			"args": ["packages/daemon/bin/ax-kit-daemon.mjs"]
		}
	}
}
```

Start the client **after** `scripts/bridge.mjs`. Both write
`%LOCALAPPDATA%\ax-kit\relay.json`, and the last one to write it owns the port
the extension is told to reach.

## macOS

Supported. The commands are identical; only where the manifest lands differs.
**Not demonstrated on this machine** — see the table below.

```sh
pnpm --filter @ax-kit/daemon run build
pnpm --filter @ax-kit/extension run build
```

```sh
node scripts/bridge.mjs --extension-id <32 characters from a-p>
```

```sh
# 3. Open chrome://extensions, turn on Developer mode, choose "Load unpacked",
#    and pick the directory the starter printed:
packages/extension/dist/unpacked
```

The manifest goes to
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openax.axkit.json`.
That is the profile's own directory, so **the registration is per browser
profile**: a second Chrome profile on the same machine does not see this host
until it is registered again with `--manifest-dir` pointing at that profile.

## Linux

Supported. Same commands. **Not demonstrated on this machine.**

```sh
pnpm --filter @ax-kit/daemon run build
pnpm --filter @ax-kit/extension run build
```

```sh
node scripts/bridge.mjs --extension-id <32 characters from a-p>
```

```sh
# 3. Open chrome://extensions, turn on Developer mode, choose "Load unpacked",
#    and pick:
packages/extension/dist/unpacked
```

The manifest goes to `~/.config/google-chrome/NativeMessagingHosts/`, which is
per profile in the same way macOS is. On a distribution packaging Chromium under
a different name, pass `--manifest-dir` explicitly.

## Platform differences

|                                    | Windows                                                                                          | macOS                                                                | Linux                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Supported                          | yes                                                                                              | yes                                                                  | yes                                                                  |
| **Demonstrated end to end**        | **yes, 2026-10-17**                                                                              | no                                                                   | no                                                                   |
| Registration mechanism             | a registry key                                                                                   | a file in the profile                                                | a file in the profile                                                |
| What the registration is scoped to | **per user account**                                                                             | per browser profile                                                  | per browser profile                                                  |
| Visible to other browsers          | **yes — every Chrome the user runs**                                                             | no                                                                   | no                                                                   |
| Manifest directory                 | `%LOCALAPPDATA%\ax-kit` (a default; the key may point anywhere)                                  | `~/Library/Application Support/Google/Chrome`                        | `~/.config/google-chrome`                                            |
| Discovery file                     | `%LOCALAPPDATA%\ax-kit\relay.json`                                                               | `$XDG_RUNTIME_DIR/ax/relay.json`, else `~/.ax/relay.json`            | same as macOS                                                        |
| Launcher the browser runs          | a generated `.cmd` beside the broker                                                             | the broker script, with its executable bit set                       | same as macOS                                                        |
| What the starter verified          | manifest written, **registry key read back and compared**, listener bound, discovery file parsed | manifest written and on disk at the path the browser reads           | manifest written and on disk at the path the browser reads           |
| What was **not** verified          | nothing outstanding                                                                              | no browser was launched; the manifest was constructed, not exercised | no browser was launched; the manifest was constructed, not exercised |

Two rows deserve their own paragraph.

**Windows registration is per user, not per profile.** The key is
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openax.axkit`, and
`HKEY_CURRENT_USER` is per user. Every Chrome that user runs will find this host,
including a browser they use for something else, and including their real
profile. That is the platform's mechanism, not a choice this repository made: a
manifest in a directory is not a mechanism on Windows at all. This is also why
the starter **reads the key back** and compares it to the manifest path rather
than trusting the exit status of the thing that wrote it.

**macOS and Linux are constructed, not demonstrated.** The starter checks that
the manifest exists on disk at the path the browser reads, which is a real check
of a real thing — and it is not the same as a browser having launched anything.
The full chain, with a real browser launching the host, has only ever been run
on Windows. `packages/daemon/test/chain-native-host.test.ts` says so in its own
header and skips itself elsewhere rather than passing on a platform it was never
run on.

## Stopping the bridge

Ctrl-C, or close standard input. Both stop the daemon and remove the discovery
file.

```sh
# Either is enough.
#   Ctrl-C in the terminal running it
#   ... or, when it is being scripted, closing its stdin:
true | node scripts/bridge.mjs --extension-id <id>
```

**A stopped daemon whose discovery file was left behind is a stale file, and a
stale file hands out a dead port.** The starter removes it on a clean stop. If
you kill the process instead, delete it:

```sh
del "%LOCALAPPDATA%\ax-kit\relay.json"
```

## What the walk recorded

Paths in the transcripts below are replaced with `<repo>`, `<home>`,
`<appdata>` and `<node>`. The commands and their output are otherwise verbatim;
the redaction is only so that one person's checkout is not published with the
repository.

Executed 2026-10-17 by someone who had not written any of this code, following
this document rather than the source.

|              |                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date         | 2026-10-17                                                                                                                                         |
| Platform     | `win32`, x64, Windows 11 Home Single Language, `10.0.26200`                                                                                        |
| Node         | `v24.21.0`                                                                                                                                         |
| pnpm         | `10.15.0`                                                                                                                                          |
| Browser      | **no Chrome or Edge installed on this machine**; the browser half was driven by the Chromium that Playwright ships (`ms-playwright\chromium-1243`) |
| Extension id | `oafbjfeifmcilaffmieadfenmneeilcj`                                                                                                                 |

### Commands, and what each printed

**1. Prerequisites.**

```sh
node --version
```
```
v24.21.0
```

**2. Build.**

```sh
pnpm --filter @ax-kit/daemon run build
```
```
ℹ [ESM] dist\main.mjs          46.30 kB │ gzip: 14.84 kB
ℹ [ESM] dist\install-host.mjs   8.28 kB │ gzip:  3.22 kB
ℹ [ESM] dist\discovery.mjs      7.44 kB │ gzip:  2.85 kB
ℹ [ESM] dist\browser-host.mjs   7.37 kB │ gzip:  3.00 kB
✔ Build complete in 82ms
```

```sh
pnpm --filter @ax-kit/extension run build
```
```
✔ Build complete in 521ms
```

**3. The one command.** Full output, unedited:

```
bridge: platform win32, node 24.21.0, pnpm repository at <repo>\
bridge: step 1/6 check prerequisites
bridge:   node 24.21.0 satisfies ">=24.19.0 <25"; 5 build outputs present
bridge: step 2/6 resolve where this platform looks for things
bridge:   the manifest may live anywhere; the registry is what points at it
discovery file will be <appdata>/ax-kit\relay.json
bridge: step 3/6 write the manifest and register the host
bridge:   manifest written to <appdata>/ax-kit\NativeMessagingHosts\com.openax.axkit.json
launcher: <repo>\packages\daemon\bin\ax-kit-browser-host.mjs.cmd (generated by the installer)
bridge: step 4/6 check the browser would find it
bridge:   registry key read back and it names the manifest: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openax.axkit
bridge: step 5/6 start the daemon
bridge: daemon: ax-kit daemon: local transport listening on 64172
bridge:   daemon pid 16176, listening on 127.0.0.1:64172
bridge: step 6/6 read the discovery file the way the extension will
bridge:   <appdata>/ax-kit\relay.json parsed; version 2026-07-28

bridge: up.
  manifest     <appdata>/ax-kit\NativeMessagingHosts\com.openax.axkit.json
  registry     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openax.axkit
  discovery    <appdata>/ax-kit\relay.json
  listener     http://127.0.0.1:64172
  extension    oafbjfeifmcilaffmieadfenmneeilcj
  bearer       bb743af2… (full value in the discovery file)

bridge: load this directory in chrome://extensions → Load unpacked:
  <repo>\packages\extension\dist\unpacked

bridge: not checked here, and only a person can check them:
  - that the extension id above is the one Chrome assigned;
  - that a browser launched the host at all.

bridge: running. Ctrl-C, or closing standard input, stops the daemon
bridge: and removes the discovery file.
```

**4. The browser half.** A Chromium was launched with the unpacked extension and
the worker's own relay state read out of it:

```
extension id this browser assigned: oafbjfeifmcilaffmieadfenmneeilcj
worker relay state: {"status":"attached","reason":""}
```

`attached` is only reachable if the browser launched the host, the host read the
discovery file the running daemon had just written, and the worker dialled the
loopback listener with the bearer from it. The id the browser assigned is the
same id the starter was given.

**5. Stopping.** Standard input closed:

```
bridge: stopping the daemon (standard input closed)
bridge: the daemon exited (code 0, signal null)
```

`relay.json` was gone afterwards. The registry key remained, pointing at the
manifest, which is what registration means.

### What was written where

```
%LOCALAPPDATA%\ax-kit\NativeMessagingHosts\com.openax.axkit.json
```

```json
{
	"name": "com.openax.axkit",
	"description": "ax-kit bridge",
	"path": "<repo>\\packages\\daemon\\bin\\ax-kit-browser-host.mjs.cmd",
	"type": "stdio",
	"allowed_origins": ["chrome-extension://oafbjfeifmcilaffmieadfenmneeilcj/"]
}
```

The launcher it names, `packages/daemon/bin/ax-kit-browser-host.mjs.cmd`:

```
@echo off
"<comspec>" /d /s /c ""<node>" "<repo>\packages\daemon\bin\ax-kit-browser-host.mjs" %*"
```

**This file is generated by registering, and it is the one artifact of this
procedure that lands inside the repository.** It is ignored by
`.gitignore`, because it holds an absolute path and this machine's `COMSPEC`.
Removing it is safe; registering writes it again.

### A failure, to show what one looks like

The starter was pointed at a discovery directory it could not create, with a
manifest directory it could, so registration succeeded and the listener did not:

```
bridge: step 3/6 write the manifest and register the host
bridge:   manifest written to ...\good-manifests\NativeMessagingHosts\com.openax.axkit.json
bridge:   registry key read back and it names the manifest: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.openax.axkit
bridge: step 5/6 start the daemon
bridge: daemon: Error: ENOTDIR: not a directory, mkdir '...\not-a-dir\sub\ax-kit'
bridge: step 5/6 start the daemon FAILED
bridge: step 5/6 start the daemon failed: the daemon exited before it was ready (code 1, signal null)
```

Exit status `1`, the step named, the daemon's own error relayed rather than
swallowed. A bad argument is refused earlier and separately, with exit status
`2`:

```sh
node scripts/bridge.mjs --extension-id too-short
```
```
bridge: --extension-id must be 32 characters from a-p; got 9 of them
```

## What the walk found

Four things. The first three are recorded rather than worked around, because the
ticket this answers exists because of a defect that was papered over and printed
as success.

### 1. A `mkdir` failure killed the daemon, and the code said it should not

**Found by this walk on 2026-10-17 and fixed the same day. Kept here because the
fix is the evidence that the walk was worth doing.**

`startTransport` documents itself: _"A failure to open it is a warning rather
than a refusal to start: stdio still works on its own."_ `src/main.ts` wraps the
call in `try`/`catch` on that promise and degrades to stdio-only when it
rejects.

The `mkdirSync(discoveryDir, { recursive: true })` that creates the discovery
directory sits inside the `server.listen(..., () => { … })` callback. That
callback runs long after the promise executor has returned, so a throw from it
does not become a rejection — it escapes as an uncaught exception and the
process exits. Measured, with the discovery directory pointing at a path that is
not a directory:

```
bridge: daemon: Error: ENOTDIR: not a directory, mkdir '...\not-a-dir\sub\ax-kit'
bridge: daemon:     at Server.<anonymous> (…/packages/daemon/dist/main.mjs:997:4)
bridge: daemon: Node.js v24.21.0
```

The process died with `code 1` and the stdio-only fallback never ran.

**Fixed.** The body of the listen callback is now wrapped so every failure in it
arrives as a rejection, and the listener is closed before the caller is told.
Covered by `packages/daemon/test/transport-startup.test.ts`, which points the
discovery directory at a path under a regular file so `mkdir` fails with
`ENOTDIR` after the socket is already listening - the exact placement that used
to escape. The stdio-only fallback in `main.ts` now actually runs.

The claim that a unit test could not find this was right about the cause and wrong
about the consequence: the missing test was not the walk, it was a fixture whose
discovery directory could not be created. Every existing test used a temporary
directory that worked.

### 2. Terminating the starter on Windows orphans the daemon and the discovery file

Measured: start the starter, `SIGTERM` it, then poll.

```
starter gone after 6ms
discovery file removed after: NEVER
daemon is still running
```

The daemon holds the write end of a pipe whose read end belongs to the starter.
When the starter dies on Windows the daemon does not see standard-input close,
so it never takes its shutdown path and never removes its own file. The bridge
is left running with a discovery file naming a port that may be about to be
reused.

Closing standard input instead of signalling does work, and removes the file.
That is why the document above says Ctrl-C **or** closing standard input, and
why the `del` is in [Stopping the bridge](#stopping-the-bridge). Whether POSIX
behaves the same was not measured; this machine is Windows and the other two
platforms are not demonstrated.

### 3. The starter hung when its own standard input closed

Found by the walk, fixed in `scripts/bridge.mjs`. The first version handled only
`SIGINT` and `SIGTERM`, so under any supervisor, pipeline or test harness that
closes stdin rather than signalling, the bridge came up and could not be stopped
at all — measured as a hang, with the daemon still holding the discovery file.
It now honours the same contract the daemon does, and the shutdown is verified:
standard input closed, daemon exited `code 0`, file removed.

### 4. Two things the command cannot check, so it says so

It prints them rather than staying quiet:
- **that the extension id is the one your browser assigned.** A manifest
  admitting the wrong origin is a host no browser will run for. Nothing in this
  repository can detect it; a person comparing the id against
  `chrome://extensions` can.
- **that a browser launched the host.** On macOS and Linux that is exactly the
  gap the platform table records.

## What this walk does not establish

- **macOS and Linux.** Not run. Their registration paths are constructed and
  checked for existence, nothing more.
- **A page's tools executing end to end.** The walk proved the browser launched
  the host and the worker attached to the daemon, which is the part this ticket
  is about. Driving a tool from a real page is covered by
  `packages/daemon/test/chain-native-host.test.ts`.
- **Chrome itself.** No Chrome or Edge is installed on this machine. The
  Chromium Playwright ships reads the same `HKCU\Software\Google\Chrome\`
  registry key, which is what made the walk possible here; whether a
  distribution-packaged Chrome reads it identically was not measured.
- **A clean `pnpm install` from an empty checkout.** The walk ran against an
  existing working tree.
