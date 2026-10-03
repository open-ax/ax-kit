// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	BRIDGE_ERRORS,
	BridgeClient,
	BridgeRefusal,
	PageBridge,
} from "../src/bridge.js";
import type { Transport } from "../src/lifecycle.js";
import { startTransport } from "../src/lifecycle.js";

/**
 * What the daemon side of the bridge does with a request nobody answers.
 *
 * The deadline is the only termination a queued call has besides its own
 * result, so it is asserted directly rather than left to the shape of the code:
 * a peer that never attaches must produce a typed refusal and release the call
 * rather than hold it for the life of the process.
 */

describe("page bridge pending calls", () => {
	it("refuses a queued call no client answers", async () => {
		const bridge = new PageBridge(10);
		const refused = bridge.listTools(1);
		await expect(refused).rejects.toBeInstanceOf(BridgeRefusal);
		await expect(refused).rejects.toThrow(/timed out/);
	});

	it("still answers a call the queue reaches in time", async () => {
		const bridge = new PageBridge(5_000);
		const call = bridge.listTools(1);
		// The work is handed to a client exactly as the transport would.
		const envelope = bridge.take();
		expect(envelope?.request.handler).toBe("listTools");
		bridge.deliver(
			JSON.stringify({ id: envelope?.id, result: { tools: [{ name: "a" }] } }),
		);
		await expect(call).resolves.toEqual([{ name: "a" }]);
	});

	it("refuses a call nothing settles and then releases it", async () => {
		const bridge = new PageBridge(10);
		const refused = bridge.listTools(1);
		const envelope = bridge.take();
		expect(envelope).not.toBeNull();
		await expect(refused).rejects.toBeInstanceOf(BridgeRefusal);
		// A late answer for the refused id is a no-op rather than a throw: the
		// entry it would have landed on is already gone.
		expect(() =>
			bridge.deliver(JSON.stringify({ id: envelope?.id, result: {} })),
		).not.toThrow();
	});

	it("does not hand a client work whose caller was already refused", async () => {
		const bridge = new PageBridge(10);
		// No client is draining the queue, so this call is refused at the door.
		const abandoned = bridge.listTools(1);
		// A second caller arrives and is served, which is what makes the first
		// envelope still sitting in the queue dangerous.
		const served = bridge.listTools(2);
		await expect(abandoned).rejects.toThrow(/timed out/);

		// The abandoned call is gone, not waiting to be executed against the page.
		const envelope = bridge.take();
		expect(envelope?.request.args["tabId"]).toBe(2);
		expect(bridge.take()).toBeNull();

		bridge.deliver(JSON.stringify({ id: envelope?.id, result: { tools: [] } }));
		await expect(served).resolves.toEqual([]);
	});

	it("marks a still-queued timeout as refused before execution", async () => {
		const bridge = new PageBridge(10);
		const refused = bridge.listTools(1).catch((error: unknown) => error);
		const outcome = (await refused) as BridgeRefusal;
		expect(outcome).toBeInstanceOf(BridgeRefusal);
		expect(outcome.code).toBe(BRIDGE_ERRORS.badRequest);
		expect(outcome.message).toMatch(/timed out/);
	});

	it("marks an in-flight timeout as outcome-unknown", async () => {
		const bridge = new PageBridge(10);
		const refused = bridge.listTools(1).catch((error: unknown) => error);
		// Taken before the deadline, so the worker may still execute after the
		// caller is told it failed — unknown, not refused before execution.
		const envelope = bridge.take();
		expect(envelope).not.toBeNull();
		const outcome = (await refused) as BridgeRefusal;
		expect(outcome).toBeInstanceOf(BridgeRefusal);
		expect(outcome.code).toBe(BRIDGE_ERRORS.outcomeUnknown);
		expect(outcome.message).toMatch(/timed out/);
		expect(outcome.message).toMatch(/outcome unknown/);
	});

	it("refuses a queue nothing is draining", async () => {
		const bridge = new PageBridge(60_000);
		const accepted: Array<Promise<unknown>> = [];
		for (let index = 0; index < 256; index += 1) {
			accepted.push(bridge.listTools(index));
		}
		// Nothing is draining the queue, so the next caller is told so rather
		// than joining a backlog that would only look like a slow daemon.
		const refused = await bridge
			.listTools(999)
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(BridgeRefusal);
		expect((refused as BridgeRefusal).message).toMatch(/no client is draining/);
		// The refused call left nothing behind for a later client to pick up.
		expect(bridge.take()).not.toBeNull();
		let drained = 1;
		while (bridge.take() !== null) {
			drained += 1;
		}
		expect(drained).toBe(256);
		for (const call of accepted) {
			void call.catch(() => undefined);
		}
	});
});

/**
 * The worker's side of the bridge, against a real listener.
 *
 * The idle poll and the posted body are the whole contract, and both are easy to
 * get wrong in a way that only shows up between requests. The daemon here is
 * the real one over a real socket, so the 204 and the JSON body are the
 * platform's, not a stand-in's.
 */

let discoveryDir: string;
let transport: Transport;
let bridge: PageBridge;

beforeAll(async () => {
	discoveryDir = await mkdtemp(join(tmpdir(), "ax-bridge-disc-"));
	bridge = new PageBridge(30_000);
	transport = await startTransport({ discoveryDir, bridge });
});

afterAll(async () => {
	await transport?.close();
	await rm(discoveryDir, { recursive: true, force: true }).catch(() => {});
});

describe("bridge client over the real transport", () => {
	it("keeps serving past an idle poll and posts a body the daemon can read", async () => {
		const base = `http://127.0.0.1:${transport.port}`;
		const headers = {
			"x-ax-bearer": transport.bearer,
			origin: base,
			"content-type": "application/json",
		};
		let reachable = true;
		let sawIdle: (() => void) | undefined;
		const idle = new Promise<void>((done) => {
			sawIdle = done;
		});
		const client = new BridgeClient(
			async (body: unknown) => {
				await fetch(`${base}/result`, {
					method: "POST",
					headers,
					body: body as string,
				});
				return true;
			},
			async () => {
				if (!reachable) {
					return null;
				}
				try {
					const response = await fetch(`${base}/pull`, { headers });
					if (response.status === 204) {
						// The daemon had nothing queued. A client that read this as
						// the end of the stream would never reach the call below.
						sawIdle?.();
						sawIdle = undefined;
						return "";
					}
					return await response.text();
				} catch {
					return null;
				}
			},
		);

		const serving = client.serve(async (request) => ({
			tools: [{ name: request.handler, tabId: request.args["tabId"] }],
		}));
		await idle;
		await expect(bridge.listTools(7)).resolves.toEqual([
			{ name: "listTools", tabId: 7 },
		]);

		// The listener is still up; what ends the loop is the client learning the
		// transport is gone, which is the only shutdown signal it has.
		reachable = false;
		await expect(serving).resolves.toBeUndefined();
	});
});
