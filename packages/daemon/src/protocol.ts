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
	"client/registerCapability",
	"client/unregisterCapability",
	"notifications/tools/list_changed",
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
	const protocolVersion = metaRecord["io.modelcontextprotocol/protocolVersion"];
	const clientCapabilities =
		metaRecord["io.modelcontextprotocol/clientCapabilities"];
	if (typeof protocolVersion !== "string") {
		throw new TypeError("missing protocolVersion");
	}
	if (typeof clientCapabilities !== "object" || clientCapabilities === null) {
		throw new TypeError("missing clientCapabilities");
	}
	return {
		protocolVersion,
		clientCapabilities,
		clientInfo: metaRecord["io.modelcontextprotocol/clientInfo"] as unknown,
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
	if (text.includes("\n") || text.includes("\r")) {
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

function fail(
	id: string | number | null,
	code: number,
	message: string,
): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
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
		return fail(null, -32600, "invalid request");
	}
	const record = request as Record<string, unknown>;
	if (typeof record.method !== "string") {
		return fail(null, -32600, "invalid request");
	}
	const id =
		typeof record.id === "string" || typeof record.id === "number"
			? record.id
			: null;
	const method = record.method;
	if (isDeprecatedMethod(method)) {
		return fail(id, -32601, `unsupported method ${method}`);
	}
	let meta: RequestMeta;
	try {
		meta = readMeta(record.params as unknown);
	} catch (error: unknown) {
		const detail = error instanceof TypeError ? `: ${error.message}` : "";
		return fail(id, -32602, `missing _meta${detail}`);
	}
	if (meta.protocolVersion !== PROTOCOL_VERSION) {
		return fail(
			id,
			-32022,
			`unsupported protocol version ${meta.protocolVersion}`,
		);
	}
	if (method === "server/discover") {
		return ok(id, discoveryResult(info));
	}
	if (method === "tools/list") {
		for (const tool of tools) {
			if (typeof tool.name !== "string") {
				return fail(id, -32602, "bad tool listing");
			}
		}
		return ok(id, completeResult({ tools }));
	}
	if (method === "tools/call") {
		const callRecord =
			typeof record.params === "object" && record.params !== null
				? (record.params as Record<string, unknown>)
				: {};
		if (typeof callRecord.name !== "string" || callRecord.name.length === 0) {
			return fail(id, -32602, "missing tool name");
		}
		// Refused rather than answered. This process holds no page bridge, so no
		// listener was opened and there is nothing to execute against. Completing
		// the frame anyway would tell a client a tool ran when it did not, and a
		// client that acts on a completion marker acts on it — this is the answer
		// a purchase-shaped call must never get.
		return fail(
			id,
			-32601,
			`tools/call is not served: no page bridge is attached to ${info.name}`,
		);
	}
	return fail(id, -32601, `unknown method ${method}`);
}
