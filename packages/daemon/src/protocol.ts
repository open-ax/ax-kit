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
 *
 * Verified against `schema/2026-07-28/schema.ts` on 2026-10-14. The three
 * facts this file leans on, each of which was checked rather than remembered:
 *
 * - `initialize` does not exist in this revision. The string is absent from
 *   the schema entirely; it was removed, not deprecated.
 * - `resultType` is mandatory on every result, and `InputRequiredResult` is
 *   the specified way to say "not yet - here is what I need from you".
 * - Tool errors are reported *inside* the result with `isError: true`, not as
 *   a JSON-RPC error. A refused tool is a result, and a client that can see it
 *   is a client that can recover from it.
 */

import type { BridgeProvider, ToolOutcome } from "./outcome.js";
import { refusalFrom } from "./outcome.js";

export const PROTOCOL_VERSION = "2026-07-28" as const;

export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [PROTOCOL_VERSION];

/**
 * Methods that existed before this revision and are gone from it.
 *
 * `notifications/tools/list_changed` is deliberately absent: the research
 * behind this revision found it still present and still supported, with only
 * its delivery moved. Rejecting a live method as unknown is a false negative a
 * client cannot distinguish from the server being broken.
 */
const DEPRECATED_METHODS: ReadonlySet<string> = new Set([
	"initialize",
	"notifications/initialized",
	"ping",
	"client/registerCapability",
	"client/unregisterCapability",
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

/**
 * The cache fields every list-shaped result carries.
 *
 * `DiscoverResult` and `ListToolsResult` both extend `CacheableResult`, which
 * makes `ttlMs` and `cacheScope` required rather than optional - verified
 * against `schema/2026-07-28/schema.ts`, not assumed. A result without them is
 * not a `2026-07-28` result.
 *
 * `ttlMs: 0` means consider-this-stale-immediately, which is honest for both:
 * the tool list changes with the page, and the daemon's own capabilities do
 * not change within a process, so a longer lifetime would only be a chance to
 * be wrong.
 */
function cacheable(scope: "public" | "private"): Record<string, unknown> {
	return { ttlMs: 0, cacheScope: scope };
}

/**
 * Mandatory discovery payload with optional client use.
 *
 * `cacheScope` is `"public"`: this describes the daemon itself - its name, its
 * version, the revisions it speaks - and none of that varies per user or per
 * authorisation context.
 */
export function discoveryResult(info: DaemonInfo): Record<string, unknown> {
	return {
		resultType: "complete",
		...cacheable("public"),
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

/** A text content block, the one shape this daemon ever emits. */
function textBlock(text: string): Record<string, unknown> {
	return { type: "text", text };
}

/**
 * The result for a tool that ran.
 *
 * The page's own return value is a JSON string, which is what the draft says
 * `executeTool` resolves to. A string goes to `content` for a client to read;
 * an object also goes to `structuredContent`, because a client that asked for
 * structure should not have to parse it out of prose. The page decides which.
 */
export function completedResult(result: unknown): Record<string, unknown> {
	if (typeof result === "string") {
		return completeResult({ content: [textBlock(result)] });
	}
	let structured: unknown;
	try {
		structured = JSON.parse(JSON.stringify(result) as string) as unknown;
	} catch {
		// Not representable as JSON, so it cannot be structured content. The
		// text block still carries a readable rendering rather than nothing.
		return completeResult({
			content: [textBlock(JSON.stringify(result) ?? String(result))],
		});
	}
	return completeResult({
		content: [textBlock(JSON.stringify(structured) ?? String(structured))],
		structuredContent: structured,
	});
}

/**
 * The result for a tool that ran and did not succeed.
 *
 * A refusal is a result, not a JSON-RPC error. The revision is explicit that
 * tool-level failures belong inside the result so a model can see them and
 * adjust; only "the server cannot serve this at all" is a protocol error.
 */
export function refusedResult(message: string): Record<string, unknown> {
	return completeResult({ content: [textBlock(message)], isError: true });
}

/**
 * The result for a consequential tool waiting on a person.
 *
 * `InputRequiredResult` is exactly this: the server ran, could not finish
 * without something from the client side, and says what it needs. The key is the
 * Trusted tier's approval binding; `requestState` carries it back so a client
 * that echoes it hands the extension a second value to match. A client that
 * drops it still works - the binding is always recomputed from live page state,
 * so nothing here is load-bearing on the echo.
 *
 * `requestedSchema` is deliberately a single boolean. The person is being asked
 * to approve or reject, and a form with more fields would collect data this
 * call has no use for.
 */
export function approvalRequiredResult(
	outcome: Extract<ToolOutcome, { kind: "approval-required" }>,
): Record<string, unknown> {
	return {
		resultType: "input_required",
		inputRequests: {
			axConfirmation: {
				method: "elicitation/create",
				params: {
					mode: "form",
					message: `${outcome.toolName} on ${outcome.frameOrigin} is awaiting your confirmation. Arguments: ${outcome.argsJson}`,
					requestedSchema: {
						type: "object",
						properties: {
							approved: {
								type: "boolean",
								title: `Approve ${outcome.toolName}`,
								description: outcome.description,
							},
						},
						required: ["approved"],
					},
				},
			},
		},
		requestState: outcome.binding,
	};
}

/** Map one outcome onto its protocol result. */
export function outcomeResult(outcome: ToolOutcome): Record<string, unknown> {
	if (outcome.kind === "completed") {
		return completedResult(outcome.result);
	}
	if (outcome.kind === "refused") {
		return refusedResult(outcome.message);
	}
	return approvalRequiredResult(outcome);
}

/**
 * Dispatch one request. Returns a response object; transport framing stays
 * with the stdio layer. Version mismatches reject with the version error;
 * deprecated capabilities are absent and reject as unknown methods.
 *
 * Async because the tools it answers about are on the far side of a browser.
 */
export async function dispatchRequest(
	request: unknown,
	provider: BridgeProvider,
	info: DaemonInfo,
): Promise<JsonRpcResponse> {
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
		const tools = await provider.listTools().catch(() => [] as const);
		for (const tool of tools) {
			if (typeof tool.name !== "string") {
				return fail(id, -32602, "bad tool listing");
			}
		}
		// "private", not "public": this listing describes the page the person is
		// looking at right now, on the tab they are on. Caching it across
		// authorisation contexts is exactly what `cacheScope` exists to prevent.
		return ok(id, completeResult({ ...cacheable("private"), tools }));
	}
	if (method === "tools/call") {
		const callRecord =
			typeof record.params === "object" && record.params !== null
				? (record.params as Record<string, unknown>)
				: {};
		if (typeof callRecord.name !== "string" || callRecord.name.length === 0) {
			return fail(id, -32602, "missing tool name");
		}
		const rawArgs = callRecord.arguments;
		if (
			rawArgs !== undefined &&
			(typeof rawArgs !== "object" ||
				rawArgs === null ||
				Array.isArray(rawArgs))
		) {
			return fail(id, -32602, "tool arguments must be an object");
		}
		const outcome = await provider
			.callTool(callRecord.name, (rawArgs ?? {}) as Record<string, unknown>)
			// A bridge that throws is a refusal that lost its code, not a crash:
			// the call must still be answered.
			.catch((error: unknown) => refusalFrom(error, -32603));
		return ok(id, outcomeResult(outcome));
	}
	return fail(id, -32601, `unknown method ${method}`);
}
