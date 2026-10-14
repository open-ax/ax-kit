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
