// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BridgeRefusal, PageBridge } from "../src/bridge.js";
import { createDaemonInfo } from "../src/protocol.js";

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
		const bridge = new PageBridge(createDaemonInfo(), 10);
		const refused = bridge.listTools(1);
		await expect(refused).rejects.toBeInstanceOf(BridgeRefusal);
		await expect(refused).rejects.toThrow(/timed out/);
	});

	it("still answers a call the queue reaches in time", async () => {
		const bridge = new PageBridge(createDaemonInfo(), 5_000);
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
		const bridge = new PageBridge(createDaemonInfo(), 10);
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
});
