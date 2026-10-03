// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES } from "../src/stdio.js";
import {
	discoverFrame,
	RawClient,
	toolsCallFrame,
	toolsListFrame,
} from "./client.js";

/**
 * Highest available seam for this package: a spawned child process exchanging
 * real bytes with this test. Every assertion below is on what came off the
 * pipe, so a fake transport cannot satisfy them.
 */

// The `bin` shim, not `dist/main.mjs`. The shim is what a user spawns, so it
// is the artifact under test; the bundle behind it is an implementation detail.
// Spawned through `process.execPath` because a `.mjs` file is not directly
// executable on Windows.
const DAEMON_BIN = fileURLToPath(
	new URL("../bin/ax-kit-daemon.mjs", import.meta.url),
);

const open: RawClient[] = [];

function spawnDaemon(): RawClient {
	const client = new RawClient(process.execPath, [DAEMON_BIN]);
	open.push(client);
	return client;
}

afterEach(() => {
	for (const client of open.splice(0)) {
		client.kill();
	}
});

describe("daemon process", () => {
	it("answers a tools request sent first, with no handshake", async () => {
		const client = spawnDaemon();
		// No `initialize`, no session, no `notifications/initialized`. The first
		// frame on the wire is the request we care about.
		client.write(toolsListFrame(1));

		const response = await client.nextFrame();
		expect(response.id).toBe(1);
		expect(response.error).toBeUndefined();
		expect(response.result).toMatchObject({ resultType: "complete" });
	});

	it("answers discovery and refuses a deprecated method on the same pipe", async () => {
		const client = spawnDaemon();
		client.write(discoverFrame(7));
		const discovered = await client.nextFrame();
		expect(discovered.error).toBeUndefined();
		expect(discovered.result).toMatchObject({ resultType: "complete" });

		// The stateless revision has no initialize. Asking is the error.
		client.write({
			jsonrpc: "2.0",
			id: 8,
			method: "initialize",
			params: { _meta: {} },
		});
		const refused = await client.nextFrame();
		expect(refused.id).toBe(8);
		expect(refused.error?.code).toBe(-32601);
	});

	it("answers every request in one pipe with no session between them", async () => {
		const client = spawnDaemon();
		client.write(toolsListFrame(1));
		client.write(discoverFrame(2));
		client.write(toolsCallFrame(3, "viewCart", { sku: "A1" }));

		const ids: Array<string | number | null | undefined> = [];
		for (let index = 0; index < 3; index += 1) {
			ids.push((await client.nextFrame()).id);
		}
		expect(ids).toEqual([1, 2, 3]);
	});

	it("keeps stdout to protocol frames and diagnostics on stderr", async () => {
		const client = spawnDaemon();
		client.write(toolsListFrame(1));
		await client.nextFrame();
		client.endInput();
		await client.waitForExit();

		const stderr = await client.stderr();
		expect(stderr).toContain("ax-kit daemon");
		// Reaching stdout at all would have thrown in `parseResponse`.
	});

	it("shuts down on standard-input close and on nothing else", async () => {
		const client = spawnDaemon();
		client.write(toolsListFrame(1));
		await client.nextFrame();
		client.endInput();
		expect(await client.waitForExit()).toBe(0);
	});

	it("refuses a frame over the maximum size without stopping the loop", async () => {
		const client = spawnDaemon();
		client.writeRaw(`${"x".repeat(MAX_FRAME_BYTES + 10)}\n`);
		const refused = await client.nextFrame();
		expect(refused.error?.code).toBe(-32600);

		// The point of dropping the buffer: the next request still lands.
		client.write(toolsListFrame(2));
		const next = await client.nextFrame();
		expect(next.id).toBe(2);
	});

	it("refuses unparsable bytes as a typed error", async () => {
		const client = spawnDaemon();
		client.writeRaw("this is not json\n");
		const refused = await client.nextFrame();
		expect(refused.error?.code).toBe(-32700);

		client.write(toolsListFrame(2));
		expect((await client.nextFrame()).id).toBe(2);
	});

	it("splits on newlines rather than accepting a frame that embeds one", async () => {
		const client = spawnDaemon();
		// A raw newline inside a frame is two frames, so the second half is
		// unparsable and refused on its own. It is never silently joined.
		client.writeRaw(
			'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\ngarbage\n',
		);
		const first = await client.nextFrame();
		expect(first.id).toBe(1);
		const second = await client.nextFrame();
		expect(second.error?.code).toBe(-32700);
	});
});
