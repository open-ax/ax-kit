// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Local transport lifecycle: an ephemeral loopback port, a discovery file, and a
 * bearer checked on every request.
 *
 * Everything here is ours, not the draft's: the draft defines the page surface,
 * while this is how a client finds a running daemon without a hard-coded port.
 *
 * Three properties this file exists to hold:
 *
 * - The listener binds loopback only. A non-loopback bind is refused rather than
 *   accepted with a warning, because a reachable socket is the failure that
 *   matters.
 * - The bearer is required on every request and compared without an early
 *   return, so a wrong bearer does not leak its position through timing.
 * - The discovery file is removed on clean shutdown, so a stale file never
 *   points a client at a dead process.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Envelope } from "./bridge.js";
import { readBody } from "./bridge.js";
import type { DiscoveryFile } from "./discovery.js";
import {
	checkBearer,
	checkRelayOrigin,
	createDiscoveryFile,
	DISCOVERY_FILE_NAME,
	isLoopbackHost,
	parseDiscoveryFile,
	serializeDiscoveryFile,
} from "./discovery.js";
import { handleMcpRequest } from "./mcp-http.js";
import { createNativeHostManifest } from "./native-host.js";
import type { BridgeProvider } from "./outcome.js";
import type { DaemonInfo } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export interface Transport {
	/** Port actually bound, for a client that will read the discovery file. */
	readonly port: number;
	readonly bearer: string;
	readonly discoveryPath: string;
	close(): Promise<void>;
}

/** What the listener needs from the bridge to serve its two endpoints. */
export interface BridgeRoutes {
	/**
	 * Wait for the next request for a pulling client, up to `holdMs`.
	 *
	 * `null` is the only idle signal, and the return type says so. The listener
	 * answers it with 204; anything else is serialised as the `/pull` body.
	 *
	 * It waits rather than answering immediately because the alternative is a
	 * client looping on an instant 204 for as long as the page has no tools,
	 * which is most of the time. A held request costs nothing when idle.
	 */
	waitForEnvelope(
		holdMs: number,
		signal?: AbortSignal,
	): Promise<Envelope | null>;
	/** Accept a result and settle the matching call. */
	deliver(body: unknown): void;
	/** Whether a worker is currently attached, for refusing work in bounded time. */
	clientAttached(): boolean;
}

export interface TransportOptions {
	readonly discoveryDir: string;
	readonly host?: string;
	readonly port?: number;
	/**
	 * Present when the daemon has a page bridge. Without it the listener still
	 * enforces the bearer and origin, and answers 404 — which is what a daemon
	 * with no extension attached should do.
	 */
	readonly bridge?: BridgeRoutes;
	/**
	 * Present when the daemon can speak MCP over HTTP as well as over stdio.
	 *
	 * Optional so the relay listener can stand alone in a test, and absent in a
	 * host that only wants the bridge.
	 */
	readonly provider?: BridgeProvider;
	readonly info?: DaemonInfo;
}

/**
 * How long `/pull` is held open before answering idle.
 *
 * Below any proxy or browser timeout that would cut it, and long enough that an
 * idle worker spends nothing re-asking. When the hold expires the worker simply
 * asks again, so the value is a trade against churn rather than a correctness
 * bound.
 */
const PULL_HOLD_MS = 20_000;

/** Refuse a non-loopback bind outright. */
export function assertLoopbackBind(host: unknown): string {
	if (typeof host !== "string" || !isLoopbackHost(host)) {
		throw new TypeError("refusing to bind a non-loopback host");
	}
	return host;
}

/** A bearer long enough not to be guessed and short enough to carry. */
export function createBearer(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Start the listener and write the discovery file.
 *
 * The file is written only after the socket is listening, so a client that
 * finds the file can connect immediately — readiness observed through the
 * filesystem rather than a delay.
 */
export function startTransport(options: TransportOptions): Promise<Transport> {
	const host = assertLoopbackBind(options.host ?? "127.0.0.1");
	const bearer = createBearer();
	const server: Server = createServer((request, response) => {
		// Answered, never awaited: a request that throws must become a response,
		// and an unhandled rejection here would take the whole daemon down with
		// it. One bad value is a refused request, not a dead process.
		handleRequest(request, response, bearer, options).catch(() => {
			if (!response.headersSent) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end("request failed");
			} else {
				response.end();
			}
		});
	});
	return new Promise<Transport>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("error", onError);
			reject(error);
		};
		server.on("error", onError);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", onError);
			// Every failure below this line has to become a rejection rather than a
			// throw. This callback runs after the executor has returned, so nothing
			// here is inside the promise's own try scope: an uncaught throw exits the
			// process, and the documented "serve stdio only" fallback in `main.ts`
			// never runs. Measured: a discovery directory that cannot be created
			// killed the daemon with code 1 instead of degrading.
			try {
				const address = server.address();
				if (address === null || typeof address === "string") {
					throw new TypeError("listener has no port");
				}
				const discoveryDir = options.discoveryDir;
				mkdirSync(discoveryDir, { recursive: true });
				const discoveryPath = join(discoveryDir, DISCOVERY_FILE_NAME);
				writeFileSync(
					discoveryPath,
					serializeDiscoveryFile(
						createDiscoveryFile({
							port: address.port,
							pid: process.pid,
							token: bearer,
							version: PROTOCOL_VERSION,
						}),
					),
					{ mode: 0o600 },
				);
				resolve({
					port: address.port,
					bearer,
					discoveryPath,
					close: () => closeTransport(server, discoveryPath),
				});
			} catch (error: unknown) {
				// The listener is already accepting at this point, so it is closed
				// before the caller is told. `onError` is detached above, and a
				// `close` on a live server can still emit, so one is attached for the
				// teardown: an unhandled `error` here would take the process down in
				// exactly the way this branch exists to prevent.
				server.on("error", () => {});
				server.close();
				reject(error);
			}
		});
	});
}

/** Remove the discovery file first, then stop listening. */
function closeTransport(server: Server, discoveryPath: string): Promise<void> {
	// The file goes first: a client that reads it after the listener is gone
	// finds a dead port, which is exactly the stale-file failure being prevented.
	try {
		unlinkSync(discoveryPath);
	} catch {
		// Already gone: a repeat close is not an error worth surfacing.
	}
	return new Promise<void>((resolve, reject) => {
		// Idle keep-alive sockets would otherwise hold `close` open forever and
		// keep the process alive, so they are dropped rather than waited on.
		server.closeAllConnections();
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

/** Bound so a hostile client cannot exhaust memory with one request. */
const MAX_BRIDGE_BODY = 1024 * 1024;

/**
 * CORS, answered from the gate's own verdict.
 *
 * Earlier this header block was a copy of what the relay needed, and that was
 * wrong. The extension's relay fetch is *privileged* — the extension holds host
 * permissions, so the browser exempts it from CORS — which means it sends no
 * `Origin`, triggers no preflight, and never reads these headers. What does
 * read them is a browser-based MCP client, which is ordinary CORS and needs
 * them.
 *
 * So the only question is what to echo, and the answer is not "whatever arrived".
 * Echoing an arbitrary origin would hand a web page read access to the very
 * endpoints whose security rests on the bearer: the page could not read the
 * bearer, but being able to read responses is the other half of the attack, and
 * the gate is one refactor away from not stopping it.
 *
 * Hence `originAllowed`: the header set is derived from the same decision that
 * gates the request, so a refused origin is refused at the preflight too and can
 * never reach a route.
 */
function corsHeaders(origin: unknown): Record<string, string> {
	try {
		checkRelayOrigin(origin);
	} catch {
		// Refused: answered without an allow-origin, so the browser blocks the
		// response body even if the refusal itself is returned.
		return {
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-max-age": "0",
		};
	}
	return {
		// Only ever a loopback or extension origin, by the check above. Echoing
		// it back is what makes a credentialed fetch readable by its own caller.
		...(typeof origin === "string" && origin.length > 0
			? { "access-control-allow-origin": origin }
			: {}),
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type, x-ax-bearer",
		"access-control-max-age": "600",
	};
}

/** Reply with JSON and CORS together, so one shape reaches the caller. */
function sendJsonWith(
	response: ServerResponse,
	status: number,
	body: unknown,
	cors: Record<string, string>,
): void {
	const text: unknown = JSON.stringify(body);
	const payload = typeof text === "string" ? text : "null";
	response.writeHead(status, {
		...cors,
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload, "utf8"),
	});
	response.end(payload);
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	bearer: string,
	options: TransportOptions,
): Promise<void> {
	const cors = corsHeaders(request.headers.origin);
	// Answered before the bearer check, because a preflight carries no
	// credentials and must not be refused for carrying none.
	if (request.method === "OPTIONS") {
		response.writeHead(204, cors);
		response.end();
		return;
	}
	try {
		checkRelayOrigin(request.headers.origin);
		checkBearer(request.headers["x-ax-bearer"], bearer);
	} catch (error: unknown) {
		response.writeHead(403, { ...cors, "content-type": "text/plain" });
		response.end(
			error instanceof TypeError ? error.message : "request refused",
		);
		return;
	}
	const path = (request.url ?? "/").split("?")[0];
	if (options.provider !== undefined && options.info !== undefined) {
		const handled = await handleMcpRequest(
			request,
			response,
			options.provider,
			options.info,
		);
		if (handled) {
			return;
		}
	}
	const bridge = options.bridge;
	if (bridge === undefined) {
		response.writeHead(404, { ...cors, "content-type": "text/plain" });
		response.end("no bridge");
		return;
	}
	// GET only, as `/result` is POST only. A `DELETE` reaching this branch
	// would take work off the queue without executing any of it, so a caller
	// that cannot execute could still discard what is waiting.
	if (path === "/pull" && request.method === "GET") {
		// Held open until there is something to hand over. An instant answer
		// would make the worker spin; a long hold makes an idle bridge free.
		//
		// The hold ends when the socket does, not only when the hold expires.
		// Chrome culls service workers, and a culled worker drops this socket
		// mid-pull; without the abort its waiter would stay eligible for
		// dispatch, so the next envelope would be written to a socket nobody
		// will read and the work would be lost rather than re-pulled.
		//
		// Gated on the response being unfinished, because `close` alone does not
		// mean the caller left. Measured on the Node this runs on: a pull that
		// was answered emits `end` and then `close`, and a pull the caller hung
		// up on emits `close` with the response unfinished. The abort is also
		// the only thing that releases a worker from the bridge's attached
		// count, so reading every ordinary completion as a disappearance would
		// make the count a count of long-polls again — and a call arriving
		// between one pull and the next would be refused as unattached while
		// the worker is sitting right there.
		const gone = new AbortController();
		request.on("close", () => {
			if (!response.writableEnded) {
				gone.abort();
			}
		});
		const next = await bridge.waitForEnvelope(PULL_HOLD_MS, gone.signal);
		if (next === null) {
			// Idle, not an error: the client should come back.
			response.writeHead(204, cors);
			response.end();
			return;
		}
		sendJsonWith(response, 200, next, cors);
		return;
	}
	if (path === "/result" && request.method === "POST") {
		try {
			const body = await readBody(request, MAX_BRIDGE_BODY);
			bridge.deliver(body);
			sendJsonWith(response, 200, { ok: true }, cors);
		} catch (error: unknown) {
			response.writeHead(400, { ...cors, "content-type": "text/plain" });
			response.end(error instanceof TypeError ? error.message : "bad result");
		}
		return;
	}
	response.writeHead(404, { ...cors, "content-type": "text/plain" });
	response.end("no route");
}

/**
 * Write the native-host manifest a browser can actually use.
 *
 * The path is the binary's own directory rather than an assumed one, because a
 * manifest pointing at a relative path is one the browser cannot launch.
 */
export function writeNativeHostManifest(
	directory: string,
	binaryPath: string,
	allowedOrigins: ReadonlyArray<string>,
): string {
	const manifest = createNativeHostManifest({
		name: "com.openax.axkit",
		description: "ax-kit bridge",
		path: binaryPath,
		type: "stdio",
		allowed_origins: allowedOrigins,
	});
	mkdirSync(directory, { recursive: true });
	const manifestPath = join(directory, `${manifest.name}.json`);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
	});
	return manifestPath;
}

/** Read a discovery file from disk, as a client would. */
export function readDiscoveryFile(directory: string): DiscoveryFile {
	return parseDiscoveryFile(
		readFileSync(join(directory, DISCOVERY_FILE_NAME), "utf8"),
	);
}
