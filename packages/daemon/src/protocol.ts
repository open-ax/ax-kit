// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Stateless MCP `2026-07-28` message handling.
 *
 * Everything here is ours, not draft-derived beyond the named protocol
 * date: the WebMCP draft defines the page surface, while this module speaks
 * the client protocol on the other side of the bridge. Modern-only: no
 * handshake, no session header, per-request version plus capabilities, a
 * mandatory discovery RPC, a required completion marker on every result,
 * and no deprecated capabilities.
 */

export const PROTOCOL_VERSION = "2026-07-28" as const;

export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [PROTOCOL_VERSION];

const DEPRECATED_METHODS: ReadonlySet<string> = new Set([
	"initialize",
	"notifications/initialized",
	"ping",
	"logging/setLevel",
	"notifications/roots/list_changed",
	"roots/list",
	"sampling/createMessage",
	"experimental/tasks",
]);

export function isDeprecatedMethod(method: unknown): boolean {
	return typeof method === "string" && DEPRECATED_METHODS.has(method);
}

export interface RequestMeta {
	readonly protocolVersion: string;
	readonly clientCapabilities: unknown;
	readonly clientInfo?: unknown;
}

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: string | number;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

function readMeta(params: unknown): RequestMeta {
	if (typeof params !== "object" || params === null) {
		throw new TypeError("bad params");
	}
	const record = params as Record<string, unknown>;
	const meta = record._meta;
	if (typeof meta !== "object" || meta === null) {
		throw new TypeError("missing _meta");
	}
	const metaRecord = meta as Record<string, unknown>;
	const protocolVersion = metaRecord.protocolVersion;
	const clientCapabilities = metaRecord.clientCapabilities;
	if (typeof protocolVersion !== "string") {
		throw new TypeError("missing protocolVersion");
	}
	if (typeof clientCapabilities !== "object" || clientCapabilities === null) {
		throw new TypeError("missing clientCapabilities");
	}
	return {
		protocolVersion,
		clientCapabilities,
		clientInfo: metaRecord.clientInfo as unknown,
	};
}

/** Parse one newline-delimited frame. Embedded newlines never occur by construction. */
export function parseFrame(line: unknown): JsonRpcRequest {
	if (typeof line !== "string") {
		throw new TypeError("bad frame");
	}
	if (line.includes("\n") || line.includes("\r")) {
		throw new TypeError("embedded newline");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch {
		throw new TypeError("unparsable frame");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new TypeError("bad frame");
	}
	const record = parsed as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") {
		throw new TypeError("bad jsonrpc");
	}
	if (typeof record.id !== "string" && typeof record.id !== "number") {
		throw new TypeError("bad id");
	}
	if (typeof record.method !== "string") {
		throw new TypeError("bad method");
	}
	return {
		jsonrpc: "2.0",
		id: record.id,
		method: record.method,
		params: record.params as unknown,
	};
}

/** Serialize one response frame. Never emits an embedded newline. */
export function serializeFrame(response: JsonRpcResponse): string {
	const text: unknown = JSON.stringify(response);
	if (typeof text !== "string") {
		throw new TypeError("unserializable response");
	}
	if (text.includes("\n")) {
		throw new TypeError("embedded newline");
	}
	return text;
}

export interface DaemonInfo {
	readonly name: string;
	readonly version: string;
}

export function createDaemonInfo(): DaemonInfo {
	return { name: "@ax-kit/daemon", version: "0.0.0" };
}

/** Mandatory discovery payload with optional client use. */
export function discoveryResult(info: DaemonInfo): Record<string, unknown> {
	return {
		resultType: "complete",
		supportedVersions: [...SUPPORTED_VERSIONS],
		capabilities: { tools: {} },
		_meta: {
			serverInfo: { name: info.name, version: info.version },
		},
	};
}

export function completeResult(
	data: Record<string, unknown>,
): Record<string, unknown> {
	return { resultType: "complete", ...data };
}

function versionMismatch(
	message: string,
): JsonRpcResponse & { id: string | number | null } {
	return {
		jsonrpc: "2.0",
		id: null,
		error: { code: -32000, message },
	};
}

/**
 * Dispatch one request. Returns a response object; transport framing stays
 * with the stdio layer. Version mismatches reject with the version error;
 * deprecated capabilities are absent and reject as unknown methods.
 */
export function dispatchRequest(
	request: unknown,
	tools: ReadonlyArray<Record<string, unknown>>,
	info: DaemonInfo,
): JsonRpcResponse {
	if (typeof request !== "object" || request === null) {
		throw new TypeError("bad request");
	}
	const record = request as Record<string, unknown>;
	if (typeof record.method !== "string") {
		throw new TypeError("bad method");
	}
	const id =
		typeof record.id === "string" || typeof record.id === "number"
			? record.id
			: null;
	const method = record.method;
	if (isDeprecatedMethod(method)) {
		return {
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `unsupported method ${method}` },
		};
	}
	let meta: RequestMeta;
	try {
		meta = readMeta(record.params as unknown);
	} catch {
		return {
			jsonrpc: "2.0",
			id,
			error: { code: -32602, message: "missing _meta" },
		};
	}
	if (meta.protocolVersion !== PROTOCOL_VERSION) {
		const mismatch = versionMismatch(
			`unsupported protocol version ${meta.protocolVersion}`,
		);
		return { ...mismatch, id };
	}
	if (method === "server/discover") {
		return { jsonrpc: "2.0", id, result: discoveryResult(info) };
	}
	if (method === "tools/list") {
		return { jsonrpc: "2.0", id, result: completeResult({ tools }) };
	}
	if (method === "tools/call") {
		const params = record.params as Record<string, unknown>;
		const call = params.call;
		if (typeof call !== "object" || call === null) {
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: "missing call" },
			};
		}
		const callRecord = call as Record<string, unknown>;
		if (typeof callRecord.name !== "string") {
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: "missing tool name" },
			};
		}
		return {
			jsonrpc: "2.0",
			id,
			result: completeResult({
				deferred: true,
				name: callRecord.name,
				note: "execution resolves through the trusted tier",
			}),
		};
	}
	return {
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: `unknown method ${method}` },
	};
}
