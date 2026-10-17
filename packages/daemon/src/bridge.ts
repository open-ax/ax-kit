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
	/**
	 * Workers that have pulled and have not been seen to leave.
	 *
	 * Counted per worker rather than per long-poll, because a poll is not a
	 * worker: see `clientAttached`.
	 */
	private attached = 0;

	constructor(private readonly deadlineMs: number = PENDING_DEADLINE_MS) {}

	/**
	 * Whether a worker is attached.
	 *
	 * This is how "no extension attached" gets answered in bounded time.
	 * Without it every question would be asked by enqueueing work nothing is
	 * coming to drain, and the only answer available would be the call deadline
	 * - so a `tools/list` on an idle machine would hang for a minute to report
	 * that there is nothing to report.
	 *
	 * **The count of open long-polls is not this answer, and answering it with
	 * one refused working calls.** A worker holds a pull only while it has
	 * nothing to do. The moment work is dispatched the pull is answered, the
	 * worker executes in the page, posts `/result`, and asks again — and the
	 * count is zero for that entire round trip. A call arriving inside the gap
	 * was refused as "no extension is attached" by a daemon with the extension
	 * loaded and sitting right in front of it. Measured on this chain through a
	 * real browser: the second request of every pair failed that way.
	 *
	 * It is the same shape as the failure this whole layer exists to make
	 * impossible, and it is worse, because the message names the wrong
	 * component. A person reading "no extension is attached" reloads the
	 * browser; there is nothing there to fix.
	 *
	 * So attachment is what it says: a worker has pulled and has not been seen
	 * to leave. Answering a pull is evidence the worker is there — it is about
	 * to ask again — so completion leaves the count alone. Only a pull the
	 * worker walks away from takes it down, and that is the one case the abort
	 * signal exists for.
	 */
	clientAttached(): boolean {
		return this.attached > 0;
	}

	/**
	 * The next queued request for a pulling client, or null when idle.
	 *
	 * An envelope with no live call behind it is discarded and the next one tried:
	 * the call it belonged to has already settled and been forgotten, so handing
	 * it out would execute work whose client was told it had failed - a purchase
	 * it believes was not placed. An envelope that does have a call behind it is
	 * handed out.
	 *
	 * **This removes the envelope from the queue, and that is the delivery
	 * guarantee.** Once an envelope has been taken, it is not offered again. A
	 * worker that dies between the take and the answer therefore costs the whole
	 * call, and the client is told the outcome is *unknown* rather than being
	 * invited to retry.
	 *
	 * That is chosen, not accidental. Re-offering would be at-least-once, and the
	 * first execution may already have had its effect - for a consequential tool
	 * that means charging a person twice. An unknown outcome is something a
	 * person can reconcile against a statement; a duplicated purchase is not
	 * recoverable by anyone. `waitForEnvelope` below protects the *held* pull, and
	 * that is a different guarantee: it stops a pull being abandoned before the
	 * envelope was ever taken.
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
	 *
	 * The abort is also the only path that takes a worker off the attached
	 * count, which is why the transport must hand over a signal that means
	 * "this caller left" rather than "this request finished". A signal firing on
	 * every completed pull would make the count a count of polls again, and
	 * `clientAttached` would go back to refusing working calls in the gap
	 * between one pull and the next.
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
				// Deliberately no decrement here. This caller answered, which
				// means it is there and will ask again; taking it off the count
				// on the way out is what made `clientAttached` a momentary
				// sample of a long-poll rather than a statement about a worker.
				resolve(envelope);
			};
			const onWork = (envelope: Envelope | null): void => {
				finish(envelope);
			};
			const onAbort = (): void => {
				// The one path that means the worker is gone, so the one path
				// that releases it. Guarded by `settled` for the ordinary case
				// where the pull was answered first and the socket closed
				// afterwards: a request completing is not a disappearance.
				if (!settled) {
					this.attached -= 1;
				}
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

	/**
	 * Refuse every call that has not been answered, and report how many.
	 *
	 * Called when the daemon is shutting down with work outstanding. Without it
	 * the only thing that ends such a call is its deadline — and the deadline's
	 * timer is deliberately not holding the process open, so the process exits
	 * first and the promise never settles at all. The client is left with a
	 * closed pipe and no frame, which reads exactly like a crash and tells it
	 * nothing about whether the tool ran. A page that was mid-execution when the
	 * daemon went away did the work; the caller has to be able to say so.
	 *
	 * The code is the caller of the argument rather than a constant here,
	 * because the honest code depends on why it is being called, and a
	 * shutdown is not the same event as a timeout.
	 *
	 * Queued work goes with the entry it belongs to, on the same terms the
	 * deadline uses: an envelope left behind would be handed to a worker that
	 * reconnects and asked to run work the caller has already been told did not
	 * happen. An envelope already taken cannot be recalled — the worker may
	 * still execute it — which is why the message says the outcome is unknown
	 * rather than saying it did not run.
	 */
	abandonAll(code: number, message: string): number {
		const abandoned = [...this.settled.entries()];
		this.settled.clear();
		for (const [id, call] of abandoned) {
			const queued = this.queue.findIndex((held) => held.id === id);
			if (queued !== -1) {
				this.queue.splice(queued, 1);
			}
			call.reject(new BridgeRefusal(code, message));
		}
		return abandoned.length;
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
