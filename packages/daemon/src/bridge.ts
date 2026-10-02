// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The page bridge: how the daemon reaches an extension.
 *
 * Everything here is ours, not the draft's: the draft defines the page surface,
 * while this is how a stdio client reaches a Trusted tier running in a browser.
 *
 * Direction of travel, and why it is this way round: a browser cannot open a
 * TCP socket, so the extension can only ever dial *out*. The daemon therefore
 * owns the loopback listener and the extension is the client. It reads the
 * discovery file for the port and bearer, pulls a request, executes it in the
 * Trusted tier, and posts the result back. The page never listens, and the
 * daemon never hands the browser anything to connect *to*.
 *
 * There is no session. Every request carries its own id and its own `_meta`, and
 * two invocations can be in flight at once without either settling the other.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DaemonInfo, JsonRpcResponse } from "./protocol.js";

export interface BridgeEndpoint {
	readonly host: string;
	readonly port: number;
	readonly bearer: string;
}

export interface BridgeRequest {
	readonly handler: string;
	readonly args: Record<string, unknown>;
}

/** JSON-RPC error codes this bridge adds, kept out of the protocol module. */
export const BRIDGE_ERRORS = {
	badRequest: -32602,
	notExposed: -32010,
} as const;

/** A refusal from the worker, carrying the worker's own error code. */
export class BridgeRefusal extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "BridgeRefusal";
	}
}

interface Envelope {
	readonly id: number;
	readonly request: BridgeRequest;
}

interface PendingCall {
	request: BridgeRequest;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/**
 * The worker's side of the bridge: pull a request, execute it, post the result.
 *
 * Only extension contexts hold one of these. It is the sole path from the
 * daemon to a page, and it is reachable only with the bearer.
 */
export class BridgeClient {
	constructor(
		private readonly post: (body: unknown) => Promise<unknown>,
		private readonly pull: () => Promise<unknown>,
	) {}

	/** Serve requests until the daemon reports no more. */
	async serve(
		handler: (request: BridgeRequest) => Promise<unknown>,
	): Promise<void> {
		for (;;) {
			const envelope = await this.pull();
			if (envelope === null || envelope === undefined) {
				return;
			}
			const parsed = readEnvelope(envelope);
			if (parsed === null) {
				return;
			}
			const result = await handler(parsed.request).then(
				(value: unknown) => ({ id: parsed.id, result: value }),
				(error: unknown) => ({
					id: parsed.id,
					error: {
						code: BRIDGE_ERRORS.badRequest,
						message: error instanceof Error ? error.message : "request failed",
					},
				}),
			);
			await this.post(result);
		}
	}
}

/**
 * The daemon side of the bridge: holds pending calls and speaks the two
 * endpoints the extension uses.
 */
export class PageBridge {
	private nextId = 1;
	private readonly queue: Envelope[] = [];
	private readonly settled = new Map<number, PendingCall>();

	constructor(private readonly info: DaemonInfo) {}

	/** True while a request is queued and no client has taken it yet. */
	get hasPending(): boolean {
		return this.queue.length > 0;
	}

	/**
	 * The next queued request for a pulling client, or null when idle.
	 *
	 * Every envelope handed out is one `settled` already holds, so a result for
	 * it always has an entry to land on. Minting an id here that `settled` does
	 * not know would silently drop the answer to a call nobody is awaiting.
	 */
	take(): Envelope | null {
		return this.queue.shift() ?? null;
	}

	/** Accept a result from the client and settle the matching call. */
	deliver(body: unknown): void {
		const response = readResponse(body);
		if (typeof response.id !== "number") {
			return;
		}
		const call = this.settled.get(response.id);
		if (call === undefined) {
			return;
		}
		this.settled.delete(response.id);
		if (response.error !== undefined) {
			call.reject(
				new BridgeRefusal(response.error.code, response.error.message),
			);
			return;
		}
		call.resolve(response.result);
	}

	private enqueue(request: BridgeRequest): Promise<unknown> {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise<unknown>((resolve, reject) => {
			this.settled.set(id, { request, resolve, reject });
			this.queue.push({ id, request });
		});
	}

	/**
	 * Tools the page currently exposes. Re-read per request: the page changes.
	 *
	 * The tab is named by the caller rather than assumed. A bridge that guessed
	 * a tab id would enumerate whatever happened to be first, which is the
	 * failure this whole layer exists to make impossible.
	 */
	async listTools(
		tabId: number,
	): Promise<ReadonlyArray<Record<string, unknown>>> {
		const result = await this.enqueue({
			handler: "listTools",
			args: { tabId, frameId: 0 },
		});
		if (typeof result !== "object" || result === null) {
			throw new BridgeRefusal(BRIDGE_ERRORS.badRequest, "bad tool listing");
		}
		const tools = (result as Record<string, unknown>)["tools"];
		if (!Array.isArray(tools)) {
			throw new BridgeRefusal(BRIDGE_ERRORS.badRequest, "bad tool listing");
		}
		const views: Array<Record<string, unknown>> = [];
		for (const entry of tools) {
			if (typeof entry !== "object" || entry === null) {
				throw new BridgeRefusal(BRIDGE_ERRORS.badRequest, "bad tool listing");
			}
			views.push(entry as Record<string, unknown>);
		}
		return views;
	}

	/** Invoke one tool. A refusal arrives as a `BridgeRefusal`, not a throw of text. */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		tabId: number,
		callerOrigin: string,
		allowedOrigins: ReadonlyArray<string>,
	): Promise<unknown> {
		return await this.enqueue({
			handler: "executeTool",
			args: {
				tabId,
				frameId: 0,
				name,
				args,
				callerOrigin,
				allowedOrigins: [...allowedOrigins],
				documentId: `tab-${tabId}`,
			},
		});
	}

	/** The per-request metadata the client should send with a frame. */
	meta(): Record<string, unknown> {
		return {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": {
				name: this.info.name,
				version: this.info.version,
			},
		};
	}
}

/** Read a request envelope, or null when the daemon has nothing queued. */
export function readEnvelope(value: unknown): Envelope | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "object") {
		throw new TypeError("bad envelope");
	}
	const record = value as Record<string, unknown>;
	if (typeof record["id"] !== "number") {
		throw new TypeError("bad envelope id");
	}
	const request = record["request"];
	if (typeof request !== "object" || request === null) {
		throw new TypeError("bad envelope request");
	}
	const inner = request as Record<string, unknown>;
	if (typeof inner["handler"] !== "string") {
		throw new TypeError("bad envelope handler");
	}
	const args = inner["args"];
	return {
		id: record["id"],
		request: {
			handler: inner["handler"],
			args:
				typeof args === "object" && args !== null
					? (args as Record<string, unknown>)
					: {},
		},
	};
}

/** Parse one result frame, rejecting anything that is not one. */
export function readResponse(value: unknown): JsonRpcResponse {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError("empty response");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("unparsable response");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new TypeError("bad response");
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record["id"] !== "number") {
		throw new TypeError("bad response id");
	}
	const error = record["error"];
	if (error === undefined) {
		return { jsonrpc: "2.0", id: record["id"], result: record["result"] };
	}
	if (typeof error !== "object" || error === null) {
		throw new TypeError("bad error");
	}
	const err = error as Record<string, unknown>;
	if (typeof err["code"] !== "number" || typeof err["message"] !== "string") {
		throw new TypeError("bad error");
	}
	return {
		jsonrpc: "2.0",
		id: record["id"],
		error: { code: err["code"], message: err["message"] },
	};
}

/** The bearer and origin gate every bridge request passes through. */
export function assertBridgeCaller(
	presented: unknown,
	expected: string,
	origin: unknown,
	host: string,
	port: number,
): void {
	const expectedOrigin = `http://${host}:${port}`;
	if (origin !== expectedOrigin) {
		throw new TypeError("non-loopback origin");
	}
	if (typeof presented !== "string" || presented.length !== expected.length) {
		throw new TypeError("bad bearer");
	}
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) {
		diff |= (presented.charCodeAt(index) ^ expected.charCodeAt(index)) & 0xffff;
	}
	if (diff !== 0) {
		throw new TypeError("bad bearer");
	}
}

/** Read a request body, bounded so a hostile client cannot exhaust memory. */
export async function readBody(
	request: IncomingMessage,
	limit: number,
): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > limit) {
			throw new TypeError("body too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Reply with JSON, so the client's parser always sees one shape. */
export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	const text: unknown = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(
			typeof text === "string" ? text : "null",
			"utf8",
		),
	});
	response.end(typeof text === "string" ? text : "null");
}

export type { Server };
