#!/usr/bin/env node
// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// Start the whole bridge with one command, and say what it did.
//
//   node scripts/bridge.mjs --extension-id <32 characters from a-p>
//   node scripts/bridge.mjs --extension-id <id> --manifest-dir <directory>
//
// Three things have to be true before a page's tools are reachable, and each one
// fails in a way that reads as success:
//
//   1. the browser can find the native-messaging host;
//   2. the daemon has a listener;
//   3. the extension knows where that listener is.
//
// (2) and (3) are one file, the discovery file. (1) is a registry key on Windows
// and a file in the browser's own profile directory on macOS and Linux — and the
// file is not a mechanism on Windows at all. A manifest written into a
// plausible-looking directory there is a host registered with nobody and never
// launched, which is the one failure this script exists to make impossible to
// ship again.
//
// So this does not report what it did. It reports what it checked, one named
// step at a time, and each step that fails says which step failed and exits
// non-zero. On Windows the registration is read back out of the registry and
// compared against the manifest path that was written, because "the installer
// exited zero" is precisely the claim that was false once.
//
// What it does not check, and says so on the way out: that the extension id
// matches the one the browser assigned, and that a browser launched the host.
// Neither is observable from here. A person who has the wrong id has a
// manifest no browser will run for, and the only thing that catches it is a
// person reading `chrome://extensions`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DAEMON_DIR = join(ROOT, "packages", "daemon");
const UNPACKED = join(ROOT, "packages", "extension", "dist", "unpacked");
const DAEMON_BIN = join(DAEMON_DIR, "bin", "ax-kit-daemon.mjs");
const BROKER_BIN = join(DAEMON_DIR, "bin", "ax-kit-browser-host.mjs");

const USAGE = [
	"usage: node scripts/bridge.mjs --extension-id <32 characters from a-p>",
	"                              [--manifest-dir <directory>]",
	"",
	"  --extension-id   The id Chrome gave the unpacked extension. Read it from",
	"                   chrome://extensions; it is not derivable from here.",
	"  --manifest-dir   Where the manifest is written. Defaults to the directory",
	"                   this platform's browser actually looks in.",
	"",
].join("\n");

// The daemon reports readiness on stderr. Both shapes are matched rather than
// one: "listening" is what a started bridge says, and "unavailable" is a
// failure that still exits zero, so matching only the first would leave a
// daemon serving stdio alone looking like a bridge that came up.
const LISTENING = /local transport listening on (\d+)/;
const UNAVAILABLE = /local transport unavailable \(([^)]*)\)/;

/**
 * A bound on how long a wait may take, not a pause.
 *
 * Readiness is an event - a line the daemon wrote. The timer below exists so
 * that a daemon which never writes one is a named failure rather than a hang.
 * Nothing anywhere in this script waits for a duration and then assumes
 * something happened.
 */
const READY_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
	const options = { extensionId: "", manifestDir: "" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--help" || flag === "-h") {
			process.stdout.write(USAGE);
			process.exit(0);
		}
		if (flag === "--extension-id" || flag === "--manifest-dir") {
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${flag} needs a value`);
			}
			options[flag === "--extension-id" ? "extensionId" : "manifestDir"] =
				value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument ${flag}`);
	}
	if (options.extensionId === "") {
		throw new Error("--extension-id is required; see the usage below");
	}
	// Checked here so the failure names the argument rather than surfacing as a
	// TypeError from three modules down. The same rule `installNativeHost`
	// enforces, asserted early because this is the boundary a person types into.
	if (!/^[a-p]{32}$/.test(options.extensionId)) {
		throw new Error(
			`--extension-id must be 32 characters from a-p; got ${String(options.extensionId.length)} of them`,
		);
	}
	if (options.manifestDir !== "") {
		options.manifestDir = resolve(options.manifestDir);
	}
	return options;
}

/**
 * Check the running Node against the range the repository declares.
 *
 * Read from `package.json` rather than written here, so a change to the pin is
 * one edit in one place and this cannot drift from it. Only the shape this
 * repository actually uses is understood; an unfamiliar range is a loud refusal
 * rather than a range quietly treated as satisfied.
 */
function checkNodeVersion() {
	const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
		.engines?.node;
	const match =
		typeof declared === "string"
			? /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(declared)
			: null;
	if (match === null) {
		throw new Error(
			`package.json declares engines.node as ${JSON.stringify(declared)}, which this script does not know how to check`,
		);
	}
	const running = process.versions.node.split(".").map(Number);
	const atLeast =
		running[0] > Number(match[1]) ||
		(running[0] === Number(match[1]) &&
			(running[1] > Number(match[2]) ||
				(running[1] === Number(match[2]) && running[2] >= Number(match[3]))));
	if (!atLeast || running[0] >= Number(match[4])) {
		throw new Error(
			`node ${process.versions.node} is outside the supported range "${declared}"`,
		);
	}
	return `node ${process.versions.node} satisfies "${declared}"`;
}

/** Every file the two commands below load, checked before either is run. */
const REQUIRED = [
	join(DAEMON_DIR, "dist", "install-host.mjs"),
	join(DAEMON_DIR, "dist", "discovery.mjs"),
	DAEMON_BIN,
	BROKER_BIN,
];

function checkBuilt() {
	const missing = REQUIRED.filter((file) => !existsSync(file));
	if (missing.length > 0) {
		throw new Error(
			`not built: ${missing.map((file) => file.slice(ROOT.length + 1)).join(", ")}\n` +
				"           run: pnpm --filter @ax-kit/daemon run build",
		);
	}
	if (!existsSync(join(UNPACKED, "manifest.json"))) {
		throw new Error(
			`not built: packages/extension/dist/unpacked/manifest.json\n` +
				"           run: pnpm --filter @ax-kit/extension run build",
		);
	}
	return `${REQUIRED.length + 1} build outputs present`;
}

/**
 * The default value of a `HKCU\...\key` whose default value is not empty.
 *
 * Parsed rather than substring-matched, because the value this is checking is a
 * filesystem path and a prefix match would pass on a path that merely starts
 * with the right one. Null when the key is absent or its value is empty, which
 * are both "not registered".
 */
function readRegistryValue(key) {
	const result = spawnSync("reg.exe", ["query", key, "/ve"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		return null;
	}
	for (const line of (result.stdout ?? "").split(/\r?\n/)) {
		const match = /\sREG_SZ\s+(.*)$/.exec(line);
		if (match !== null) {
			const value = match[1].trim();
			return value === "" ? null : value;
		}
	}
	return null;
}

const state = { child: undefined };

/**
 * Shut the daemon down the way it agrees to be shut down.
 *
 * Standard-input close is the only signal this process has, so this ends stdin
 * and waits for the exit rather than signalling. Signalling would leave the
 * discovery file on disk pointing at a dead port, which is the stale-file
 * failure the file's own lifecycle exists to prevent.
 */
async function stopDaemon() {
	const child = state.child;
	if (child === undefined || child.exitCode !== null) {
		return;
	}
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.stdin.end();
	await exited;
}

const STEPS = [];

function step(name, body) {
	STEPS.push({ name, body });
}

step("check prerequisites", () => {
	const node = checkNodeVersion();
	const built = checkBuilt();
	return `${node}; ${built}`;
});

step("resolve where this platform looks for things", async () => {
	const install = await import(
		pathToFileURL(join(DAEMON_DIR, "dist", "install-host.mjs")).href
	);
	const discovery = await import(
		pathToFileURL(join(DAEMON_DIR, "dist", "discovery.mjs")).href
	);
	state.install = install;
	state.discovery = discovery;
	state.discoveryDir = discovery.resolveDiscoveryDir(process.env, (message) => {
		process.stderr.write(`bridge: discovery directory: ${message}\n`);
	});
	if (state.options.manifestDir !== "") {
		state.manifestDir = state.options.manifestDir;
	} else {
		state.manifestDir = install.defaultManifestDir(process.env, homedir());
	}
	state.discoveryPath = join(state.discoveryDir, discovery.DISCOVERY_FILE_NAME);
	const where =
		process.platform === "win32"
			? "the manifest may live anywhere; the registry is what points at it"
			: `the manifest directory is the registration: ${state.manifestDir}`;
	return `${where}\ndiscovery file will be ${state.discoveryPath}`;
});

step("write the manifest and register the host", () => {
	// The broker is the sibling shim, named the way a browser can launch it. On
	// Windows that means a generated `.cmd` beside it, and that generated file is
	// an artifact of registering, not a source file.
	state.installed = state.install.installNativeHost({
		directory: state.manifestDir,
		brokerScript: BROKER_BIN,
		extensionId: state.options.extensionId,
	});
	return (
		`manifest written to ${state.installed.manifestPath}\n` +
		`launcher: ${state.installed.launcher.path}` +
		(state.installed.launcher.written === null
			? " (the broker script itself; executable bit set)"
			: " (generated by the installer)")
	);
});

step("check the browser would find it", () => {
	const { manifestPath, launcher, registryKey } = state.installed;
	if (!existsSync(manifestPath)) {
		throw new Error(`no manifest at ${manifestPath}`);
	}
	if (!existsSync(launcher.path)) {
		throw new Error(`no launcher at ${launcher.path}`);
	}
	// The path the browser will actually resolve has to be the path that was
	// written, not a path recomputed from the same inputs.
	const expected = state.install.hostManifestPath(state.manifestDir);
	if (manifestPath !== expected) {
		throw new Error(
			`manifest is at ${manifestPath}, but this platform looks in ${expected}`,
		);
	}
	if (registryKey === null) {
		// Constructed, not demonstrated. The file is where the browser looks on
		// macOS and Linux, and no browser was asked to look.
		return `manifest is where a browser looks (${state.manifestDir}); no browser was launched to prove it`;
	}
	const value = readRegistryValue(registryKey);
	if (value === null) {
		throw new Error(
			`${registryKey} does not exist, so no browser on this user account will find the host`,
		);
	}
	if (value.toLowerCase() !== manifestPath.toLowerCase()) {
		throw new Error(
			`${registryKey} points at ${value}, not at ${manifestPath}`,
		);
	}
	return `registry key read back and it names the manifest: ${registryKey}`;
});

step("start the daemon", async () => {
	const child = spawn(process.execPath, [DAEMON_BIN], {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});
	state.child = child;
	// Nothing writes frames here, but a pipe with no reader is a pipe that can
	// fill. Draining it costs one line and removes the possibility.
	child.stdout.resume();

	const result = await new Promise((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => {
			reject(
				new Error(
					`no readiness line within ${String(READY_TIMEOUT_MS)}ms; stderr was:\n${stderr.trim()}`,
				),
			);
		}, READY_TIMEOUT_MS);
		const settle = (outcome) => {
			clearTimeout(timer);
			resolve(outcome);
		};
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			for (const line of chunk.split(/\r?\n/)) {
				if (line.trim() === "") {
					continue;
				}
				process.stderr.write(`bridge: daemon: ${line}\n`);
				const unavailable = UNAVAILABLE.exec(line);
				if (unavailable !== null) {
					settle({ kind: "unavailable", reason: unavailable[1] });
					return;
				}
				const listening = LISTENING.exec(line);
				if (listening !== null) {
					settle({ kind: "listening", port: Number(listening[1]) });
					return;
				}
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			settle({ kind: "exited", code, signal });
		});
	});

	if (result.kind === "exited") {
		throw new Error(
			`the daemon exited before it was ready (code ${String(result.code)}, signal ${String(result.signal)})`,
		);
	}
	if (result.kind === "unavailable") {
		throw new Error(
			`the daemon could not open its listener: ${result.reason}. It is serving stdio only, so the extension has nothing to reach.`,
		);
	}
	state.port = result.port;
	return `daemon pid ${String(child.pid)}, listening on 127.0.0.1:${String(result.port)}`;
});

step("read the discovery file the way the extension will", () => {
	const file = state.discovery.parseDiscoveryFile(
		readFileSync(state.discoveryPath, "utf8"),
	);
	// The file is what the extension is handed, so a port in it that is not the
	// port that was reported would be a bridge that points somewhere else.
	if (file.port !== state.port) {
		throw new Error(
			`${state.discoveryPath} says port ${String(file.port)}, but the daemon reported ${String(state.port)}`,
		);
	}
	if (file.pid !== state.child.pid) {
		throw new Error(
			`${state.discoveryPath} says pid ${String(file.pid)}, but the daemon is ${String(state.child.pid)}`,
		);
	}
	state.bearer = file.token;
	return `${state.discoveryPath} parsed; version ${file.version}`;
});

/**
 * Run the steps in order, naming each as it goes.
 *
 * The naming is the point: a failure has to say which step failed, because
 * "something went wrong" is the same message whether the build was missing, the
 * registry was unwritable, or the daemon never opened a port, and those three
 * have nothing in common as fixes.
 */
async function run() {
	process.stdout.write(
		`bridge: platform ${process.platform}, node ${process.versions.node}, pnpm repository at ${ROOT}\n`,
	);
	for (const [index, entry] of STEPS.entries()) {
		const label = `step ${index + 1}/${STEPS.length} ${entry.name}`;
		process.stdout.write(`bridge: ${label}\n`);
		try {
			const detail = await entry.body();
			if (detail !== undefined && detail !== "") {
				process.stdout.write(`bridge:   ${detail}\n`);
			}
		} catch (error) {
			process.stdout.write(`bridge: ${label} FAILED\n`);
			process.stderr.write(
				`bridge: ${label} failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			await stopDaemon();
			process.exitCode = 1;
			return;
		}
	}

	process.stdout.write(
		[
			"",
			"bridge: up.",
			`  manifest     ${state.installed.manifestPath}`,
			`  registry     ${
				state.installed.registryKey === null
					? `(none; ${state.manifestDir} is the registration)`
					: state.installed.registryKey
			}`,
			`  discovery    ${state.discoveryPath}`,
			`  listener     http://127.0.0.1:${String(state.port)}`,
			`  extension    ${state.options.extensionId}`,
			`  bearer       ${String(state.bearer).slice(0, 8)}… (full value in the discovery file)`,
			"",
			"bridge: load this directory in chrome://extensions → Load unpacked:",
			`  ${UNPACKED}`,
			"",
			"bridge: not checked here, and only a person can check them:",
			"  - that the extension id above is the one Chrome assigned;",
			"  - that a browser launched the host at all.",
			"",
			"bridge: running. Ctrl-C, or closing standard input, stops the daemon",
			"bridge: and removes the discovery file.",
			"",
		].join("\n"),
	);

	// One shutdown path, reachable three ways, because no one of them is
	// sufficient alone.
	//
	// `SIGINT` and `SIGTERM` are what a terminal sends. They are also the two
	// least reliable: Node terminates a Windows process unconditionally on
	// either, so a `SIGTERM` from a supervisor never reaches the handler below.
	// Measured on Windows 2026-10-17 — the starter exited on signal and the
	// daemon it was holding was still running twenty seconds later, with the
	// discovery file still on disk.
	//
	// Standard-input close is therefore the contract this process honours, and
	// it is the same one the daemon honours. Measured, and it is the one that
	// works: closing stdin here ends the daemon's stdin, the daemon shuts down,
	// and it removes its own file. A supervisor, a pipeline or a test harness
	// closes stdin and does not send a signal, so without this the starter is
	// unstoppable in exactly those contexts.
	// What the daemon exited with, once it has. Read by `shutdown` so a daemon
	// that failed while being stopped is not reported as a clean stop: forcing
	// exit 0 here would discard the code the child's own exit handler recorded.
	let daemonExitCode = null;
	const shutdown = (why) => {
		process.stdout.write(`\nbridge: stopping the daemon (${why})\n`);
		void stopDaemon().then(() => {
			process.exit(daemonExitCode ?? 0);
		});
	};
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => shutdown(signal));
	}
	// Resumed because a listener alone does not start the flow, and an `end`
	// event on a stream that never flowed is an event that never arrives. The
	// starter reads nothing a person types; it only needs to notice the pipe
	// closing.
	process.stdin.resume();
	process.stdin.on("end", () => shutdown("standard input closed"));
	// The daemon's exit is reported rather than swallowed: a bridge that stops on
	// its own is a fact the person running it needs.
	state.child.once("exit", (code, signal) => {
		process.stdout.write(
			`bridge: the daemon exited (code ${String(code)}, signal ${String(signal)})\n`,
		);
		daemonExitCode = code === null ? 1 : code;
		process.exitCode = daemonExitCode;
	});
}

try {
	state.options = parseArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(
		`bridge: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
	);
	process.exit(2);
}

await run();
