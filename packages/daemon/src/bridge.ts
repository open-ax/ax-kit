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

import type { IncomingMessage } from "node:http";
import type { JsonRpcResponse } from "./protocol.js";

export interface BridgeRequest {
	readonly handler: string;
	readonly args: Record<string, unknown>;
}

/** JSON-RPC error codes this bridge adds, kept out of the protocol module. */
export const BRIDGE_ERRORS = {
	badRequest: -32602,
	notExposed: -32010,
	tooManyPending: -32011,
	outcomeUnknown: -32012,
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

/**
 * One queued request as it crosses the transport: the id the daemon assigned
 * and the request the worker will execute.
 *
 * This is the `/pull` body verbatim, which is why it is named at the seam
 * rather than hidden behind the bridge. An adapter that returns anything else
 * — including `undefined` for idle — is a bug the transport would otherwise
 * forward: `undefined` reaches the client as a `null` body under a 200, and a
 * client reads a `null` body as its transport having gone.
 */
export interface Envelope {
	readonly id: number;
	readonly request: BridgeRequest;
}

interface PendingCall {
	request: BridgeRequest;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/**
 * How long a queued call waits for an answer before it is refused.
 *
 * A call nothing answers — no extension attached, or one that pulls a request
 * and never posts a result — would otherwise hold its promise and its `settled`
 * entry for the life of the process. Long enough that an ordinary round trip
 * through a browser is never cut short, short enough that a missing peer is
 * reported rather than waited on indefinitely.
 */
const PENDING_DEADLINE_MS = 60_000;

/**
 * The worker's side of the bridge: pull a request, execute it, post the result.
 *
 * Only extension contexts hold one of these. It is the sole path from the
 * daemon to a page, and it is reachable only with the bearer.
 *
 * Both callbacks speak the wire format, not the object format: `pull` yields
 * the raw `/pull` body — an empty string when the daemon is idle — and `post`
 * takes the raw `/result` body as a string. Anything else is a transport bug
 * that would otherwise be discovered by a result nobody receives.
 */
export class BridgeClient {
	constructor(
		private readonly post: (body: unknown) => Promise<unknown>,
		private readonly pull: () => Promise<unknown>,
	) {}

	/** Serve requests until the daemon's transport is gone. */
	async serve(
		handler: (request: BridgeRequest) => Promise<unknown>,
	): Promise<void> {
		for (;;) {
			const body: unknown = await this.pull();
			// Idle is not shutdown. `/pull` answers 204 with an empty body, and an
			// empty queue is the normal state between requests; a client that read
			// that as "no more work" would stop at the first gap. Only a vanished
			// transport ends the loop.
			if (body === null || body === undefined) {
				return;
			}
			if (body === "") {
				continue;
			}
			const parsed = readEnvelope(parseBody(body));
			if (parsed === null) {
				// A daemon answering the literal text `null` is not reporting that
				// it has nothing more; it is answering with something that is not a
				// request, and treating that as the end of the stream would stop
				// serving on a malformed frame.
				throw new TypeError("bad envelope");
			}
			const result = await handler(parsed.request).then(
				(value: unknown) => ({ jsonrpc: "2.0", id: parsed.id, result: value }),
				(error: unknown) => ({
					jsonrpc: "2.0",
					id: parsed.id,
					error: {
						code: BRIDGE_ERRORS.badRequest,
						message: error instanceof Error ? error.message : "request failed",
					},
				}),
			);
			await this.post(JSON.stringify(result));
		}
	}
}

/** Parse a pulled body, refusing anything that is not an object frame. */
function parseBody(body: unknown): unknown {
	if (typeof body !== "string") {
		return body;
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new TypeError("unparsable envelope");
	}
}

/**
 * How many requests may wait for a client at once.
 *
 * With no extension attached, nothing drains the queue, so a client looping
 * `tools/call` would otherwise grow it for the life of the process. Refusing at
 * the door says the bridge is not being served; a queue that fills silently
 * looks like a daemon that is merely slow.
 */
const MAX_PENDING = 256;

/**
 * How long an idle `/pull` is held open before answering empty.
 *
 * Long enough that a worker restarting after the browser culled it does not
 * spin, short enough that a vanished worker's connection is reclaimed rather
 * than held for the life of the process. This is a bound on a wait, not a sleep:
 * a request that arrives resolves the promise immediately.
 */
const PULL_HOLD_MS = 25_000;

/**
 * The daemon side of the bridge: holds pending calls and speaks the two
 * endpoints the extension uses.
 */
export class PageBridge {
	private nextId = 1;
	private readonly queue: Envelope[] = [];
	private readonly settled = new Map<number, PendingCall>();
	/** Resolvers waiting on a queue that is currently empty. */
	private waiting: Array<(envelope: Envelope | null) => void> = [];
	/** Outstanding long-polls. Non-zero means a worker is currently attached. */
	private attached = 0;

	constructor(private readonly deadlineMs: number = PENDING_DEADLINE_MS) {}

	/**
	 * Whether a worker is currently holding a pull open.
	 *
	 * This is how "no extension attached" gets answered in bounded time.
	 * Without it every question would be asked by enqueueing work nothing is
	 * coming to drain, and the only answer available would be the call deadline
	 * - so a `tools/list` on an idle machine would hang for a minute to report
	 * that there is nothing to report.
	 */
	clientAttached(): boolean {
		return this.attached > 0;
	}

	/**
	 * The next queued request for a pulling client, or null when idle.
	 *
	 * An envelope whose call has already been refused is discarded rather than
	 * handed out: the caller has been told it failed, and executing it later
	 * would run work the client believes did not happen — a purchase it was told
	 * was not placed.
	 */
	take(): Envelope | null {
		for (;;) {
			const next = this.queue.shift();
			if (next === undefined) {
				return null;
			}
			if (this.settled.has(next.id)) {
				return next;
			}
		}
	}

	/**
	 * Wait for work, up to `holdMs`, or until `signal` aborts.
	 *
	 * Resolves with an envelope the moment one is queued, `null` when the hold
	 * expires, and `null` when the caller goes away. A client looping on an
	 * endpoint that answers instantly when idle spends a core doing nothing;
	 * holding the request open costs nothing while there is nothing to do.
	 *
	 * The abort is not optional and is the reason this cannot just be a hold.
	 * A waiter's removal happens on dispatch and on timeout — so a waiter whose
	 * *socket* has closed stays live for the whole hold, still counting as an
	 * attached client, and is still eligible for dispatch. Chrome can cull the
	 * worker mid-pull. The envelope then goes to a socket nobody will read, the
	 * work is lost rather than re-pulled, and the caller fails at its deadline
	 * with an outcome it never had. That is the opposite of the property this
	 * layer exists to provide.
	 */
	waitForEnvelope(
		holdMs: number = PULL_HOLD_MS,
		signal?: AbortSignal,
	): Promise<Envelope | null> {
		const ready = this.take();
		if (ready !== null) {
			return Promise.resolve(ready);
		}
		if (signal?.aborted === true) {
			return Promise.resolve(null);
		}
		return new Promise<Envelope | null>((resolve) => {
			let settled = false;
			const finish = (envelope: Envelope | null): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const at = this.waiting.indexOf(onWork);
				if (at !== -1) {
					this.waiting.splice(at, 1);
				}
				this.attached -= 1;
				resolve(envelope);
			};
			const onWork = (envelope: Envelope | null): void => {
				finish(envelope);
			};
			const onAbort = (): void => {
				finish(null);
			};
			const timer = setTimeout(() => {
				finish(null);
			}, holdMs);
			// A held pull is not a reason to keep the process alive. The listener
			// and its sockets decide that.
			timer.unref?.();
			this.attached += 1;
			this.waiting.push(onWork);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Hand the next envelope to whoever is waiting, if anyone is. */
	private dispatch(): void {
		const next = this.take();
		const waiter = this.waiting.shift();
		if (waiter === undefined) {
			// Nobody waiting: put it back at the head so ordering survives.
			if (next !== null) {
				this.queue.unshift(next);
			}
			return;
		}
		// Resolving releases the waiter's own cleanup through `finish`.
		waiter(next);
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
			// The deadline is the only thing that ends a call nobody answers. It
			// releases the entry on the same terms a result would, so a late
			// answer for a refused id lands on nothing instead of hanging. A
			// queued envelope goes with it: leaving it there would hand a client
			// work it has already been told did not happen. An envelope already
			// taken cannot be recalled — the worker may still execute it after
			// this refusal — so that case reports outcome-unknown rather than a
			// refusal before execution.
			const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
				this.settled.delete(id);
				const queued = this.queue.findIndex((held) => held.id === id);
				if (queued !== -1) {
					this.queue.splice(queued, 1);
					reject(
						new BridgeRefusal(
							BRIDGE_ERRORS.badRequest,
							"bridge call timed out",
						),
					);
					return;
				}
				reject(
					new BridgeRefusal(
						BRIDGE_ERRORS.outcomeUnknown,
						"bridge call timed out after dispatch; outcome unknown",
					),
				);
			}, this.deadlineMs);
			// A queued call must not be what keeps the daemon alive. The listener
			// and its sockets decide when the process exits.
			timer.unref?.();
			const settle = (value: unknown): void => {
				clearTimeout(timer);
				resolve(value);
			};
			const fail = (error: Error): void => {
				clearTimeout(timer);
				reject(error);
			};
			this.settled.set(id, { request, resolve: settle, reject: fail });
			if (this.queue.length >= MAX_PENDING) {
				this.settled.delete(id);
				clearTimeout(timer);
				reject(
					new BridgeRefusal(
						BRIDGE_ERRORS.tooManyPending,
						`too many pending bridge calls (${MAX_PENDING}); no client is draining the queue`,
					),
				);
				return;
			}
			this.queue.push({ id, request });
			// A waiting puller takes it immediately; otherwise it waits for the
			// next long-poll. Either way the work is live before `enqueue`
			// returns, so the caller never has to poll for its own call.
			this.dispatch();
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

	/**
	 * The tab the person is looking at, and the origin of the document in it.
	 *
	 * Asked rather than assumed, so it is correct at the moment of the call:
	 * guessing would enumerate whatever happened to be first, which is the
	 * failure this whole layer exists to make impossible.
	 *
	 * The origin travels with it because the caller needs one and cannot
	 * honestly invent one. This process is a local socket with no origin; the
	 * page it acts on is exposed to itself, which is what the draft's default
	 * means, so the page's own origin is the honest attribution. It is read from
	 * the browser, not composed here.
	 */
	async activeTab(): Promise<{ tabId: number; origin: string }> {
		const result = await this.enqueue({ handler: "activeTab", args: {} });
		if (typeof result !== "object" || result === null) {
			throw new BridgeRefusal(BRIDGE_ERRORS.badRequest, "bad active tab");
		}
		const record = result as Record<string, unknown>;
		const tabId = record["tabId"];
		const origin = record["origin"];
		if (
			typeof tabId !== "number" ||
			!Number.isInteger(tabId) ||
			tabId < 0 ||
			typeof origin !== "string" ||
			origin.length === 0
		) {
			throw new BridgeRefusal(BRIDGE_ERRORS.badRequest, "bad active tab");
		}
		return { tabId, origin };
	}

	/**
	 * Invoke one tool. A refusal arrives as a `BridgeRefusal`, not a throw of
	 * text.
	 *
	 * The caller origin travels with the request because the worker needs
	 * something to compare the page's exposure against. The allow-list does not
	 * travel: the worker reads the page's own declaration, and an allow-list
	 * sent from here would be this process deciding what it is allowed to reach.
	 *
	 * No document identity travels with it. The worker reads the document's
	 * identity from `webNavigation.onCommitted` — a record the browser keeps and
	 * this process cannot influence — and re-checks it with `getFrame` before
	 * executing. An approval is therefore bound to a document the browser named
	 * rather than one this process composed, and the placeholder that used to
	 * stand here (`tab-${tabId}`, a string that survived every navigation in
	 * that tab) is gone rather than renamed.
	 */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		tabId: number,
		callerOrigin: string,
	): Promise<unknown> {
		return await this.enqueue({
			handler: "executeTool",
			args: {
				tabId,
				frameId: 0,
				name,
				args,
				callerOrigin,
			},
		});
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
