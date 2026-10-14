#!/usr/bin/env node

// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// Executable shim for the browser-facing broker. The shebang lives here rather
// than in the bundle so the built artifact stays a plain ES module that a test
// can spawn directly.
//
// This is the process Chrome launches through `connectNative`. It answers one
// question - where is the daemon - and exits. It is deliberately not the daemon
// itself: a process Chrome owns dies with the extension's port, and a daemon
// that dies with the browser takes every in-flight tool call with it.

import { runBroker } from "../dist/browser-host.mjs";
import { resolveDiscoveryDir } from "../dist/discovery.mjs";

const discoveryDir = resolveDiscoveryDir(process.env, (message) => {
	process.stderr.write(`${message}\n`);
});

try {
	await runBroker(process.stdin, process.stdout, discoveryDir, process.argv);
} catch {
	// Chrome reads the exit code and nothing else. A broker that cannot start
	// has no channel to explain itself on, so the exit status is the message.
	process.exit(1);
}

// Exited explicitly, and the reason is that nothing else will.
//
// `process.stdin` on a pipe is a ref'd handle: removing the `data` listener
// after the single reply does not unref it, and Chrome does not close the write
// end. Measured, by holding the pipe open the way Chrome does: the process was
// still alive and holding the port eight seconds later. So the natural end of
// `runBroker` is not the end of this process, and every `connectNative` would
// leak one Node process for the life of the browser session.
//
// This is safe because the native port is a rendezvous, not a channel. The
// reply carries the daemon's address and bearer, and the extension then talks
// to the daemon directly over loopback. Nothing is left to read on this pipe,
// which is why the extension does not reconnect when this port closes.
process.exit(0);
