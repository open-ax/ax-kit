// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Chrome's native-messaging wire: the length-prefixed framing, and the broker
 * that runs on the far side of it.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is how a browser, which cannot open a socket, is told where a
 * local daemon is listening.
 *
 * **Why this process exists at all.** The design has always been "the extension
 * dials out" — a browser cannot listen, so the daemon owns the loopback port and
 * the extension pulls from it. What was missing is how the extension learns
 * which port, and the answer written into the design was "it reads the
 * discovery file". A service worker has no filesystem. That link did not exist,
 * and nothing replaced it.
 *
 * **Why it is a broker and not the daemon.** Chrome spawns the host, so a
 * daemon living here would live exactly as long as the extension's port — and
 * that port dies whenever the worker does: an extension reload, an update, a
 * disable, a browser restart. A daemon that dies with the browser takes every
 * in-flight `tools/call` with it, and the client is told "outcome unknown" for
 * work that a restart could have finished. A broker holds nothing, so its death
 * costs one re-pull and the daemon's queue is untouched.
 *
 * **What it can do.** Read one file, write one reply. It has no queue, no
 * authority, and no way to reach a page. Taking the broker's power would give
 * an attacker the discovery file, which is exactly what the bearer on the
 * listener is there to prevent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DISCOVERY_FILE_NAME, parseDiscoveryFile } from "./discovery.js";

/**
 * The cap on a message this process will *send*, in bytes.
 *
 * Asymmetric, and the asymmetry is the point: the browser accepts far more from
 * a host than it sends to one, and exceeding the host-to-browser limit kills the
 * port rather than truncating. A reply that is a few hundred bytes cannot reach
 * it, and the limit is written down so nobody has to rediscover it.
 */
const MAX_SEND_BYTES = 1024 * 1024;

/** What the browser passes to the host so it knows who called. */
/**
 * What the browser passes as the caller's origin.
 *
 * The Chrome extension documentation states that the first argument to the
 * native messaging host is the origin of the caller, and its examples of an
 * `allowed_origins` entry carry a trailing slash.
 *
 * Measured, by logging what the browser actually passes:
 *
 *   chrome-extension://<32 chars>/ --parent-window=0
 *
 * The trailing slash is there, and it is part of the origin as the browser
 * spells it. A pattern that omits it matches nothing, and a broker that
 * matches nothing refuses every connection with a message about not having
 * been launched by an extension - from the browser that launched it. The
 * slash is therefore optional, which accepts both spellings.
 */
const EXTENSION_ARG_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/?$/;

/** One decoded message from the browser, or null when the frame is unusable. */
export function decodeMessage(buffer: Buffer): {
	readonly message: unknown;
	readonly rest: Buffer;
} | null {
	if (buffer.length < 4) {
		return null;
	}
	// Native-endian, which is little-endian on every platform this ships to.
	// An explicit read rather than `readUInt32LE` would be wrong on a
	// big-endian host, and the docs specify the host's own byte order.
	const length = buffer.readUInt32LE(0);
	if (length === 0) {
		throw new TypeError("empty native message");
	}
	if (buffer.length < 4 + length) {
		return null;
	}
	const body = buffer.subarray(4, 4 + length);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString("utf8")) as unknown;
	} catch {
		throw new TypeError("unparsable native message");
	}
	return { message: parsed, rest: buffer.subarray(4 + length) };
}

/** Frame one message for the browser. Refuses anything it cannot carry. */
export function encodeMessage(value: unknown): Buffer {
	const text: unknown = JSON.stringify(value);
	if (typeof text !== "string") {
		throw new TypeError("unserializable native message");
	}
	const payload = Buffer.from(text, "utf8");
	if (payload.length === 0 || payload.length > MAX_SEND_BYTES) {
		throw new TypeError("native message too large");
	}
	const framed = Buffer.allocUnsafe(4 + payload.length);
	framed.writeUInt32LE(payload.length, 0);
	payload.copy(framed, 4);
	return framed;
}

/**
 * What the browser passes as `argv[1]`.
 *
 * The Chrome extension documentation states this directly: "The first argument
 * to the native messaging host is the origin of the caller", usually
 * `chrome-extension://<id>`. On Windows a second argument, `--parent-window`,
 * follows - and the docs note it is `0` when the calling context is a service
 * worker, which is always the case here.
 *
 * It is checked rather than trusted. The manifest's `allowed_origins` is what
 * actually decides whether Chrome runs this at all, so this is the second gate
 */
export function readCallerOrigin(argv: unknown): string {
	if (!Array.isArray(argv)) {
		throw new TypeError("bad argv");
	}
	// Scanned rather than read at a fixed index.
	//
	// The documentation says the first argument to the native messaging host is
	// the caller's origin, and that is true of the process the browser launches.
	// On Windows that process may be a `.cmd` shim, which runs the real host as
	// a *child*: the interpreter and the script path then occupy the slots the
	// origin would otherwise have had, and the origin arrives later.
	//
	// Measured: with a shim, `argv[1]` is the broker's own path, and a broker
	// that trusted the documented index refused every connection with "host was
	// not launched by an extension" - from a browser that had launched exactly
	// that. The one argument whose value is unforgeable is the token itself, so
	// the token is what gets looked for.
	for (const value of argv) {
		if (typeof value === "string" && EXTENSION_ARG_PATTERN.test(value)) {
			return value;
		}
	}
	throw new TypeError("host was not launched by an extension");
}

/**
 * The reply: where the daemon is, and the bearer that opens it.
 *
 * The bearer crosses this channel once per connection, on a pipe the browser
 * opened to a process it chose to launch for this specific extension. Handing it
 * over does not widen anything — the extension already holds host permissions
 * for every origin and the ability to inject into any page, so a listener it
 * cannot reach is not a boundary it was being kept outside of. What the bearer
 * protects is every *other* local process and every web page, and neither can
 * reach a native-messaging host.
 */
export function serveDiscovery(discoveryDir: string): Record<string, unknown> {
	const path = join(discoveryDir, DISCOVERY_FILE_NAME);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {
			ok: false,
			reason: "no daemon is running: start it before using the extension",
		};
	}
	try {
		const file = parseDiscoveryFile(text);
		return { ok: true, port: file.port, token: file.token };
	} catch {
		// A malformed file is not treated as absent. "No daemon" and "a daemon
		// wrote something wrong" are different problems, and a person reading
		// this reply is the only one who can tell them apart.
		return { ok: false, reason: "the daemon's discovery file is unreadable" };
	}
}

/**
 * Run the broker against the browser's pipes.
 *
 * One reply per connection, then exit: Chrome spawns one host process per
 * `connectNative`, and Chrome never respawns one. The extension reconnects, so
 * staying alive would only hold a process that has nothing left to do.
 */
export function runBroker(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	discoveryDir: string,
	argv: unknown,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		let answered = false;
		const finish = (error?: Error): void => {
			if (answered) {
				return;
			}
			answered = true;
			input.off("data", onData);
			input.off("end", onEnd);
			input.off("error", onError);
			if (error !== undefined) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			try {
				const decoded = decodeMessage(buffer);
				if (decoded === null) {
					return;
				}
				// The first frame is the browser announcing itself. Answer it
				// whether or not it parsed as anything we expected: a host that
				// stays silent leaves the extension waiting with no way to learn
				// why, and the browser's frame is not worth validating twice.
				const origin = readCallerOrigin(argv);
				output.write(
					encodeMessage({ ...serveDiscovery(discoveryDir), caller: origin }),
				);
				finish();
			} catch (error: unknown) {
				try {
					output.write(
						encodeMessage({
							ok: false,
							reason: error instanceof Error ? error.message : "broker refused",
						}),
					);
				} catch {
					// The reply could not be framed. There is nothing left to say.
				}
				finish();
			}
		};
		const onEnd = (): void => {
			finish();
		};
		const onError = (error: Error): void => {
			finish(error);
		};
		input.on("data", onData);
		input.on("end", onEnd);
		input.on("error", onError);
	});
}
