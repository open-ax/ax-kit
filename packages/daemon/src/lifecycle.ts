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
import { readBody, sendJson } from "./bridge.js";
import type { DiscoveryFile } from "./discovery.js";
import {
	checkBearer,
	checkUpgradeOrigin,
	createDiscoveryFile,
	DISCOVERY_FILE_NAME,
	isLoopbackHost,
	parseDiscoveryFile,
	resolveDiscoveryDir,
	serializeDiscoveryFile,
} from "./discovery.js";
import { createNativeHostManifest } from "./native-host.js";

export interface Transport {
	/** Port actually bound, for a client that will read the discovery file. */
	readonly port: number;
	readonly bearer: string;
	readonly discoveryPath: string;
	close(): Promise<void>;
}

/** What the listener needs from the bridge to serve its two endpoints. */
export interface BridgeRoutes {
	/** Next queued request for a pulling client, or null when idle. */
	take(): unknown;
	/** Accept a result and settle the matching call. */
	deliver(body: unknown): void;
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
}

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
		handleRequest(request, response, bearer, options.bridge);
	});
	return new Promise<Transport>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("error", onError);
			reject(error);
		};
		server.on("error", onError);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("listener has no port"));
				return;
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
						version: "2026-07-28",
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

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	bearer: string,
	bridge: BridgeRoutes | undefined,
): Promise<void> {
	try {
		checkUpgradeOrigin(request.headers.origin);
		checkBearer(request.headers["x-ax-bearer"], bearer);
	} catch (error: unknown) {
		response.writeHead(403, { "content-type": "text/plain" });
		response.end(
			error instanceof TypeError ? error.message : "request refused",
		);
		return;
	}
	if (bridge === undefined) {
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("no bridge");
		return;
	}
	const path = (request.url ?? "/").split("?")[0];
	// GET only, as `/result` is POST only. A `DELETE` reaching this branch
	// would take work off the queue without executing any of it, so a caller
	// that cannot execute could still discard what is waiting.
	if (path === "/pull" && request.method === "GET") {
		const next = bridge.take();
		if (next === null) {
			// Idle, not an error: the client should come back.
			response.writeHead(204);
			response.end();
			return;
		}
		sendJson(response, 200, next);
		return;
	}
	if (path === "/result" && request.method === "POST") {
		try {
			const body = await readBody(request, MAX_BRIDGE_BODY);
			bridge.deliver(body);
			sendJson(response, 200, { ok: true });
		} catch (error: unknown) {
			response.writeHead(400, { "content-type": "text/plain" });
			response.end(error instanceof TypeError ? error.message : "bad result");
		}
		return;
	}
	response.writeHead(404, { "content-type": "text/plain" });
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

/** Resolve the discovery directory, warning on the fallback rather than failing. */
export function discoveryDirectory(
	env: unknown,
	warn: (message: string) => void,
): string {
	return resolveDiscoveryDir(env, warn);
}
