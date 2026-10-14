#!/usr/bin/env node
// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Register the broker with a browser.
 *
 * Separate from the daemon rather than a subcommand of it: the daemon's stdout
 * is a protocol stream, and a command that printed a confirmation there would
 * corrupt it for any client that had it configured.
 *
 * Usage:
 *   ax-kit-install-native-host <extension-id> [directory]
 *
 * On Windows the manifest is registered through the registry and the directory
 * is only where the manifest file is written; on macOS and Linux the directory
 * is where the browser looks, and it defaults to the user's own configuration.
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	defaultManifestDir,
	installFailure,
	installNativeHost,
} from "../dist/install-host.mjs";

const args = process.argv.slice(2);
const extensionId = args[0];
if (extensionId === undefined || extensionId.length === 0) {
	process.stderr.write(
		"usage: ax-kit-install-native-host <extension-id> [directory]\n",
	);
	process.exit(2);
}

// The broker sits beside this shim; the manifest has to name it in a form the
// browser can launch, which on Windows means an absolute path.
const here = dirname(fileURLToPath(import.meta.url));
const directory =
	args[1] === undefined
		? defaultManifestDir(process.env, homedir())
		: resolve(args[1]);

try {
	const result = installNativeHost({
		directory,
		brokerScript: resolve(here, "ax-kit-browser-host.mjs"),
		extensionId,
	});
	process.stderr.write(`ax-kit: manifest written to ${result.manifestPath}\n`);
	if (result.registryKey !== null) {
		process.stderr.write(`ax-kit: registered ${result.registryKey}\n`);
	}
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n${installFailure()}\n`,
	);
	process.exit(1);
}
