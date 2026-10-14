// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker's connection lifecycle, against a double for the one platform
 * object it owns.
 *
 * This is unit coverage for a loop, not for a protocol: the property under test
 * is how often the worker asks the browser for a connection, and the shape of
 * the answer when it gets one. A browser that cannot launch the host at all is
 * a state a person reaches by simply not registering it, and the loop that runs
 * in that state is the one worth pinning.
 */

interface Port {
	readonly listeners: {
		message: ((value: unknown) => void)[];
		disconnect: (() => void)[];
	};
	/** Everything the worker has written towards the host. */
	readonly sent: unknown[];
	postMessage(message: unknown): void;
	disconnect(): void;
	onMessage: { addListener(cb: (value: unknown) => void): void };
	onDisconnect: { addListener(cb: () => void): void };
}

function makePort(): Port {
	const listeners: Port["listeners"] = { message: [], disconnect: [] };
	const sent: unknown[] = [];
	return {
		listeners,
		sent,
		postMessage: (message: unknown) => {
			sent.push(message);
		},
		disconnect: () => {},
		onMessage: { addListener: (cb) => listeners.message.push(cb) },
		onDisconnect: { addListener: (cb) => listeners.disconnect.push(cb) },
	};
}

let ports: Port[] = [];
let connectCalls = 0;
let savedChrome: unknown;
let savedFetch: unknown;

function installChrome(): void {
	ports = [];
	connectCalls = 0;
	const scope = globalThis as unknown as Record<string, unknown>;
	// Saved and restored rather than merely overwritten: this file and the
	// browser suites can land in the same worker, and a `chrome` double left
	// behind would be inherited by tests that are exercising the real platform.
	savedChrome = scope["chrome"];
	savedFetch = scope["fetch"];
	scope["chrome"] = {
		runtime: {
			connectNative: (): Port => {
				connectCalls += 1;
				const port = makePort();
				ports.push(port);
				return port;
			},
		},
	};
	// A pull that never answers, so an attached relay stays attached for the
	// length of the test instead of racing a real connection to a dead port.
	scope["fetch"] = (): Promise<never> => new Promise<never>(() => {});
}

function restoreChrome(): void {
	const scope = globalThis as unknown as Record<string, unknown>;
	scope["chrome"] = savedChrome;
	scope["fetch"] = savedFetch;
}

const ATTACHMENT = { ok: true, port: 43219, token: "0123456789abcdef0123" };

/** Re-import per test so the module's top-level connect runs afresh. */
async function start() {
	vi.resetModules();
	const module_ = await import("../src/relay-host.js");
	const dispatch = vi.fn(async () => ({}));
	const handle = module_.startRelay(dispatch);
	return { handle, dispatch };
}

describe("relay connection lifecycle", () => {
	beforeEach(() => {
		installChrome();
	});

	afterEach(() => {
		restoreChrome();
	});

	it("greets the host on connect, because the host only answers", async () => {
		// Neither side of a `connectNative` port is obliged to speak first, and
		// this pair was built with the host waiting for a frame that never came.
		// The worker listened; the host waited; the connection looked healthy
		// and carried nothing.
		const { handle } = await start();
		expect(ports[0].sent.length).toBeGreaterThan(0);
		// Wires the listeners before greeting, so a host that answers
		// immediately cannot deliver into a port nobody is listening on yet.
		expect(handle.state.status).toBe("starting");
	});

	it("does not retry a host that has never answered", async () => {
		// The measured failure: a browser with no host registered answered 2812
		// connect attempts in about a second and a half. None of them could
		// succeed, because the fix is a person registering the host, and the
		// retry storm only buries the one log line that says so.
		const { handle } = await start();
		expect(ports).toHaveLength(1);
		ports[0].listeners.disconnect.forEach((cb) => {
			cb();
		});
		expect(connectCalls).toBe(1);
		expect(handle.state.status).toBe("detached");
	});

	it("reconnects after a host that did answer goes away", async () => {
		// This is the case the documentation describes recovering from: an
		// extension reload, an update, a browser restart. The worker held a
		// working connection, so losing it is worth retrying, and a fresh
		// `connectNative` gets the current daemon's port and bearer.
		const { handle } = await start();
		ports[0].listeners.message.forEach((cb) => {
			cb(ATTACHMENT);
		});
		expect(handle.state.status).toBe("attached");

		ports[0].listeners.disconnect.forEach((cb) => {
			cb();
		});
		expect(connectCalls).toBe(2);
	});

	it("reports the broker's own words when it refuses", async () => {
		const { handle } = await start();
		ports[0].listeners.message.forEach((cb) => {
			cb({ ok: false, reason: "no daemon is running: start it first" });
		});
		expect(handle.state).toEqual({
			status: "no-daemon",
			reason: "no daemon is running: start it first",
		});
		// A refusal is an answer, not a disconnect. Reconnecting on it would be
		// asking the same question again in a tight loop.
		expect(connectCalls).toBe(1);
	});
});
