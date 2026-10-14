// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
	decodeMessage,
	encodeMessage,
	readCallerOrigin,
	runBroker,
	serveDiscovery,
} from "../src/browser-host.js";
import { DISCOVERY_FILE_NAME } from "../src/discovery.js";

/**
 * The broker is a process the browser launches, so its framing is a wire
 * format rather than an internal detail. These tests speak it from the outside:
 * bytes in, bytes out, exactly as Chrome would.
 */

const EXTENSION = "chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik";

const dirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ax-broker-"));
	dirs.push(dir);
	return dir;
}

function withDiscovery(value: Record<string, unknown>): string {
	const dir = scratch();
	writeFileSync(join(dir, DISCOVERY_FILE_NAME), JSON.stringify(value), {
		mode: 0o600,
	});
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("native framing", () => {
	it("round-trips a message through Chrome's length-prefixed frame", () => {
		const framed = encodeMessage({ ok: true, port: 43219 });
		// Four bytes of little-endian length, then the UTF-8 payload.
		expect(framed.readUInt32LE(0)).toBe(framed.length - 4);
		const decoded = decodeMessage(framed);
		expect(decoded?.message).toEqual({ ok: true, port: 43219 });
		expect(decoded?.rest.length).toBe(0);
	});

	it("waits for the rest of a frame rather than decoding half of one", () => {
		// Chrome writes a frame as one write but nothing guarantees a pipe hands
		// it over in one piece. Decoding a partial frame would be a parse error
		// on a message that was merely slow.
		const framed = encodeMessage({ ok: true, port: 1 });
		expect(decodeMessage(framed.subarray(0, 3))).toBeNull();
		expect(decodeMessage(framed.subarray(0, framed.length - 1))).toBeNull();
		expect(decodeMessage(framed)).not.toBeNull();
	});

	it("decodes only the first frame when two arrive together", () => {
		const first = encodeMessage({ ok: true, port: 1 });
		const second = encodeMessage({ ok: true, port: 2 });
		const decoded = decodeMessage(Buffer.concat([first, second]));
		expect(decoded).not.toBeNull();
		expect(decoded?.message).toEqual({ ok: true, port: 1 });
		const remainder = decodeMessage(decoded?.rest ?? Buffer.alloc(0));
		expect(remainder?.message).toEqual({ ok: true, port: 2 });
	});

	it("refuses a frame it cannot carry rather than sending a broken one", () => {
		expect(() =>
			decodeMessage(encodeMessage({ x: 1 }).subarray(0, 0)),
		).not.toThrow();
		// A zero-length frame is what a `readUInt32LE` of an uninitialised buffer
		// looks like, and JSON.parse of nothing throws.
		const empty = Buffer.alloc(4);
		expect(() => decodeMessage(empty)).toThrow(TypeError);
		const unparsable = Buffer.from([3, 0, 0, 0, 0x7b, 0x7b, 0x7b]);
		expect(() => decodeMessage(unparsable)).toThrow(TypeError);
	});
});

describe("caller identity", () => {
	it("reads the extension origin Chrome passes as argv[1]", () => {
		expect(readCallerOrigin(["host", EXTENSION, "--parent-window=0"])).toBe(
			EXTENSION,
		);
	});

	it("refuses a launch that no extension made", () => {
		// The manifest's `allowed_origins` is the gate that actually decides
		// whether Chrome runs this at all. This is the second gate on the same
		// fact, and a host that answers an unauthenticated caller would be a
		// process that hands out a bearer to whoever asked.
		for (const argv of [
			["host"],
			["host", "not-an-origin"],
			["host", "chrome-extension://short"],
			["host", "https://example.com/"],
			"not-an-array",
		]) {
			expect(() => readCallerOrigin(argv), JSON.stringify(argv)).toThrow(
				TypeError,
			);
		}
	});
});

describe("discovery", () => {
	it("hands over the port and bearer a running daemon published", () => {
		const dir = withDiscovery({
			port: 43219,
			pid: 4242,
			token: "0123456789abcdef0123456789abcdef",
			version: "2026-07-28",
		});
		expect(serveDiscovery(dir)).toEqual({
			ok: true,
			port: 43219,
			token: "0123456789abcdef0123456789abcdef",
		});
	});

	it("says no rather than guessing when there is no daemon", () => {
		const answer = serveDiscovery(scratch()) as Record<string, unknown>;
		expect(answer["ok"]).toBe(false);
		expect(String(answer["reason"])).toMatch(/no daemon is running/);
	});

	it("distinguishes a broken file from an absent one", () => {
		// "Start the daemon" and "the daemon wrote something wrong" are different
		// problems, and only a person reading this can tell them apart.
		const dir = withDiscovery({ port: -1 });
		const answer = serveDiscovery(dir) as Record<string, unknown>;
		expect(answer["ok"]).toBe(false);
		expect(String(answer["reason"])).toMatch(/unreadable/);
	});
});

describe("broker process", () => {
	it("answers one frame with the discovery file and then exits", async () => {
		const dir = withDiscovery({
			port: 55555,
			pid: 1,
			token: "0123456789abcdef0123456789abcdef",
			version: "2026-07-28",
		});
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));

		const done = runBroker(input, output, dir, ["host", EXTENSION]);
		// The browser's opening frame. Its contents do not matter: the broker
		// answers on arrival, and a host that waits for a shape it recognises
		// would leave the extension waiting with no way to learn why.
		input.write(encodeMessage({ type: "connect" }));
		input.end();
		await done;

		const decoded = decodeMessage(Buffer.concat(chunks));
		expect(decoded?.message).toMatchObject({
			ok: true,
			port: 55555,
			token: "0123456789abcdef0123456789abcdef",
		});
	});

	it("answers a refusal rather than leaving the caller in silence", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));

		const done = runBroker(input, output, scratch(), ["host", EXTENSION]);
		input.write(encodeMessage({}));
		input.end();
		await done;

		const decoded = decodeMessage(Buffer.concat(chunks));
		const message = decoded?.message as Record<string, unknown> | undefined;
		expect(message?.["ok"]).toBe(false);
	});

	it("closes without answering when the browser says nothing", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));
		const done = runBroker(input, output, scratch(), ["host", EXTENSION]);
		input.end();
		await done;
		expect(chunks).toHaveLength(0);
	});
});
