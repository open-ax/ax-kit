// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal frame-level MCP client: test scaffolding, not a product.
 *
 * It exists because the property under test is that the daemon speaks a
 * stateless protocol, and a client library would negotiate a session and hide
 * exactly the thing being checked. Frames go out by hand and come back off a
 * real pipe. It deliberately has no handshake helper, no capability registry,
 * and no connection pooling — if it ever grows those, the test that needed
 * raw frames has stopped being able to make its point.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

import { MAX_FRAME_BYTES } from "../src/stdio.js";

export interface WireFrame {
	readonly jsonrpc: "2.0";
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

/**
 * The pinned protocol version, written out rather than imported.
 *
 * This client stands in for an independent implementation on the other side of
 * the wire, so it is pinned to the draft independently of `src/protocol.ts`. A
 * test client that imported the server's constant could not catch the server
 * drifting away from the draft, which is the one thing this constant is here to
 * catch. If these two ever disagree, the server is what moved.
 */
const PROTOCOL_VERSION = "2026-07-28";

/**
 * Per-request metadata. Deliberately not injected automatically: a test that
 * wants to prove a missing `_meta` fails must be able to omit it.
 */
export function requestMeta(): Record<string, unknown> {
	return {
		"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

export function toolsListFrame(id: string | number): WireFrame {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/list",
		params: { _meta: requestMeta() },
	};
}

export function toolsCallFrame(
	id: string | number,
	name: string,
	args: unknown,
): WireFrame {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { _meta: requestMeta(), name, arguments: args },
	};
}

export function discoverFrame(id: string | number): WireFrame {
	return {
		jsonrpc: "2.0",
		id,
		method: "server/discover",
		params: { _meta: requestMeta() },
	};
}

/**
 * A live daemon child process with a real pipe in each direction.
 *
 * Readiness is the first frame arriving, not a timer, so a slow machine makes
 * this slower rather than flaky.
 */
export class RawClient {
	private readonly child: ChildProcessWithoutNullStreams;
	/** Undigested stdout. Frames are lines, so one buffer is the whole state. */
	private buffer = "";
	private waiters: (() => void)[] = [];
	private stderrText = "";
	private readonly exited: Promise<number | null>;

	constructor(command: string, args: string[] = []) {
		this.child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.push(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrText += chunk;
		});
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code) => resolve(code));
		});
	}

	/** Append to the buffer, then release one waiter per complete line. */
	private push(chunk: string): void {
		this.buffer += chunk;
		let newlines = this.buffer.split("\n").length - 1;
		while (newlines > 0 && this.waiters.length > 0) {
			this.waiters.shift()?.();
			newlines -= 1;
		}
	}

	/** Write one frame by hand, newline-delimited, with no library involved. */
	write(frame: WireFrame): void {
		const text: unknown = JSON.stringify(frame);
		if (typeof text !== "string") {
			throw new TypeError("unserializable frame");
		}
		if (text.includes("\n") || text.includes("\r")) {
			throw new TypeError("embedded newline");
		}
		if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
			throw new TypeError("frame too large");
		}
		this.child.stdin.write(`${text}\n`);
	}

	/** Write raw bytes, for the cases that must not be valid frames at all. */
	writeRaw(text: string): void {
		this.child.stdin.write(text);
	}

	/**
	 * The next complete response line. Resolves on the pipe, never on a sleep.
	 */
	async nextFrame(timeoutMs = 20_000): Promise<WireFrame> {
		const line = await Promise.race([
			this.takeLine(),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), timeoutMs),
			),
		]);
		if (line === null) {
			throw new Error(
				`no frame within ${timeoutMs}ms; stderr: ${this.stderrText.slice(0, 400)}`,
			);
		}
		return parseResponse(line);
	}

	/** A complete line if one is buffered, otherwise wait for one to arrive. */
	private async takeLine(): Promise<string> {
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.buffer.slice(0, newline).replace(/\r$/, "");
				this.buffer = this.buffer.slice(newline + 1);
				if (line.length > 0) {
					return line;
				}
				continue;
			}
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
			});
		}
	}

	/** Close standard input, which is the only shutdown signal there is. */
	endInput(): void {
		this.child.stdin.end();
	}

	waitForExit(timeoutMs = 20_000): Promise<number | null> {
		return Promise.race([
			this.exited,
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), timeoutMs),
			),
		]);
	}

	async stderr(): Promise<string> {
		return this.stderrText;
	}

	kill(): void {
		this.child.kill();
	}
}

export function parseResponse(line: string): WireFrame {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null) {
		throw new TypeError("response is not an object");
	}
	return parsed as WireFrame;
}
