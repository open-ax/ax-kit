// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The relay: how the extension reaches the daemon.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is transport, and transport is not part of it.
 *
 * **Why a native host exists.** A service worker has no filesystem and no
 * socket. The daemon publishes its port and a bearer in a discovery file, and
 * without a way to read that file the worker cannot learn where to dial. Native
 * messaging is the only channel a Manifest V3 worker has to a local process, so
 * the browser launches a small broker that reads the file and hands over the
 * two numbers.
 *
 * **Why the loop, not the native port itself.** The broker answers once and
 * exits. Carrying traffic over the native port would tie every in-flight call
 * to the port's lifetime, and the port dies whenever the worker does. The loop
 * runs over loopback instead, so a worker that is culled mid-call costs one
 * abandoned request: the call's fate is never decided by the port's lifetime.
 *
 * **What a culled worker does not get is a re-offer.** The bridge removes an
 * envelope from its queue at the moment it hands that envelope to a waiter, so a
 * call already dispatched is not offered again to the next worker. A client
 * whose worker died mid-call is told the outcome is unknown, not told to retry.
 * That is the trade this design makes deliberately: re-offering would risk a
 * second execution of a tool whose first execution may already have had its
 * effect, and for a consequential tool that means spending the money twice. An
 * unknown outcome is something a person can reconcile; a duplicated purchase is
 * not recoverable by anyone.
 *
 * The guarantee is pinned on the daemon side, in
 * `packages/daemon/test/bridge.test.ts` ("does not re-offer an envelope it has
 * already handed out"). `packages/extension/test/worker-death.test.ts` measures
 * the *worker* side of a culled call at three points, but against a stand-in
 * holder rather than a real `PageBridge` — it is evidence about what the worker
 * does, not about what the daemon promises.
 *
 * **No keepalive timer.** The native port already gives the worker a strong
 * keep-alive; an extra ping would only be a way to be wrong. Reconnection is
 * driven by `onDisconnect` and by top-level start, which is the documented
 * pattern, rather than by anything this file invents.
 */

/**
 * The JSON-RPC code a failed handler reports with.
 *
 * Mirrored rather than imported: the extension is a browser package and the
 * daemon is a Node package, and a worker that had to resolve the other one to
 * answer a refusal would be a dependency between two things that are only
 * related by a wire format. The number is part of that format, so it is
 * written down here on the same footing as the path and the header name.
 */
const BRIDGE_BAD_REQUEST = -32602;

/** The host name in the native-host manifest this worker connects to. */
export const NATIVE_HOST_NAME = "com.openax.axkit" as const;

/** What the broker answered. Everything crossing back is validated. */
interface Attachment {
	readonly port: number;
	readonly token: string;
}

/** Why the relay stopped, in words a person can act on. */
export type RelayStop =
	| { readonly kind: "no-daemon"; readonly reason: string }
	| { readonly kind: "unreachable"; readonly reason: string }
	| { readonly kind: "stopped" };

/** The worker's side of the bridge: one request in, one result out. */
export type RelayHandler = (request: {
	readonly handler: string;
	readonly args: Record<string, unknown>;
}) => Promise<unknown>;

/** Read one broker reply. A host process is not a trusted source. */
export function readAttachment(value: unknown): Attachment | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (record.ok !== true) {
		return null;
	}
	const port = record.port;
	const token = record.token;
	if (
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port <= 0 ||
		port > 65535 ||
		typeof token !== "string" ||
		token.length < 16
	) {
		return null;
	}
	return { port, token };
}

/** The refusal a host sends back, for the panel and for diagnostics. */
export function readRefusal(value: unknown): string {
	if (typeof value !== "object" || value === null) {
		return "the bridge refused the connection";
	}
	const reason = (value as Record<string, unknown>).reason;
	return typeof reason === "string" && reason.length > 0
		? reason
		: "the bridge refused the connection";
}

/**
 * Drive the pull/result loop against one daemon.
 *
 * The loop is the whole job: ask, execute, answer, ask again. It ends only when
 * the daemon stops answering, and it reports why rather than spinning.
 */
export async function serveRelay(
	attachment: Attachment,
	handler: RelayHandler,
	onStop: (stop: RelayStop) => void,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<void> {
	const { port, token } = attachment;
	const base = `http://127.0.0.1:${port}`;
	const headers = { "x-ax-bearer": token };
	for (;;) {
		if (signal?.aborted === true) {
			onStop({ kind: "stopped" });
			return;
		}
		let response: Response;
		try {
			// Held open by the daemon until there is work. An immediate 204 means
			// the hold expired with an empty queue, so the next iteration is a
			// re-ask rather than a spin.
			response = await fetchImpl(`${base}/pull`, {
				headers,
				signal,
				keepalive: false,
			} as RequestInit);
		} catch (error: unknown) {
			onStop({
				kind: "unreachable",
				reason:
					error instanceof Error
						? error.message
						: "the daemon is not reachable",
			});
			return;
		}
		if (response.status === 204) {
			continue;
		}
		if (response.status === 403 || response.status === 404) {
			onStop({
				kind: "unreachable",
				reason: readRefusal({ reason: await refusedReason(response) }),
			});
			return;
		}
		if (!response.ok) {
			onStop({
				kind: "unreachable",
				reason: `the daemon answered ${String(response.status)}`,
			});
			return;
		}
		let envelope: unknown;
		try {
			envelope = (await response.json()) as unknown;
		} catch {
			onStop({
				kind: "unreachable",
				reason: "the daemon sent an unreadable body",
			});
			return;
		}
		const parsed = readEnvelope(envelope);
		if (parsed === null) {
			onStop({
				kind: "unreachable",
				reason: "the daemon sent a malformed envelope",
			});
			return;
		}
		const payload = JSON.stringify(
			await handler(parsed.request).then(
				(value: unknown) => ({ jsonrpc: "2.0", id: parsed.id, result: value }),
				(error: unknown) => ({
					jsonrpc: "2.0",
					id: parsed.id,
					error: {
						code: BRIDGE_BAD_REQUEST,
						message: error instanceof Error ? error.message : "request failed",
					},
				}),
			),
		);
		try {
			await fetchImpl(`${base}/result`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: payload,
			});
		} catch {
			// The result is lost and the call will time out on the other side.
			// Reported rather than retried: the work may have run, and a retry
			// would be a second execution of it.
			onStop({
				kind: "unreachable",
				reason: "the result could not be delivered",
			});
			return;
		}
	}
}

/** Why the daemon refused, in its own words where it gave any. */
async function refusedReason(response: Response): Promise<string> {
	try {
		const text: string = await response.text();
		return text.length > 0 ? text : `status ${String(response.status)}`;
	} catch {
		return `status ${String(response.status)}`;
	}
}

/** One queued request as it arrives over the relay. */
function readEnvelope(value: unknown): {
	readonly id: number;
	readonly request: { handler: string; args: Record<string, unknown> };
} | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const id = record.id;
	const request = record.request;
	if (
		typeof id !== "number" ||
		typeof request !== "object" ||
		request === null
	) {
		return null;
	}
	const inner = request as Record<string, unknown>;
	if (typeof inner.handler !== "string") {
		return null;
	}
	const args = inner.args;
	return {
		id,
		request: {
			handler: inner.handler,
			args:
				typeof args === "object" && args !== null && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {},
		},
	};
}
