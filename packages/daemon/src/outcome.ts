// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * What an invocation can be, once it has crossed the bridge.
 *
 * Everything here is ours, not draft-derived. The WebMCP draft defines the page
 * surface; MCP `2026-07-28` defines the client protocol. This module is the seam
 * between them, and it exists because those two protocols describe a call
 * differently.
 *
 * MCP is not a request/response protocol any more. A server may answer a call
 * three ways, and the revision names all three: an ordinary result, an
 * `InputRequiredResult` that asks the client to supply something and retry, or
 * an error. A human approving a consequential tool is the second case, not a
 * failure dressed as one - the call did not fail, it ran out of input. Encoding
 * it as an error would teach every client that approval is an outage.
 *
 * So the outcome is modelled here, at the seam, and mapped to protocol shapes in
 * `protocol.ts`. Nothing above this line has to know how MCP spells it.
 */

/** A refusal carrying its own code, so a client can tell why from what. */
export interface ToolRefusal {
	readonly kind: "refused";
	readonly code: number;
	readonly message: string;
}

/**
 * The tool ran and returned.
 *
 * `result` is the page's own JSON string, because that is what the draft types
 * `ModelContext.executeTool()` as returning. It is carried as `unknown` rather
 * than `string` so that a caller which has not proved the shape cannot index
 * into it, but the only value that reaches it is one this module checked.
 */
export interface ToolCompleted {
	readonly kind: "completed";
	readonly result: unknown;
}

/**
 * A consequential tool that a person has been asked about.
 *
 * `binding` is the Trusted tier's approval key. It is opaque here: this process
 * never interprets it, it only carries it back to the client as `requestState`
 * so a client that echoes it gives the extension a second thing to match.
 */
export interface ToolApprovalRequired {
	readonly kind: "approval-required";
	readonly toolName: string;
	readonly description: string;
	readonly argsJson: string;
	readonly origin: string;
	readonly frameOrigin: string;
	readonly binding: string;
}

export type ToolOutcome = ToolCompleted | ToolApprovalRequired | ToolRefusal;

/**
 * Where a daemon gets its tools and its executions.
 *
 * Async on both halves, and that is the whole reason this interface changed:
 * `PageBridge` crosses a network and cannot answer synchronously, and an
 * interface that pretends otherwise is what kept the shipped binary holding an
 * empty provider.
 */
export interface BridgeProvider {
	listTools(): Promise<ReadonlyArray<Record<string, unknown>>>;
	callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

/** A provider with nothing behind it, used before a bridge is attached. */
export function emptyBridgeProvider(): BridgeProvider {
	return {
		listTools: async () => [],
		callTool: async (name: string) => ({
			kind: "refused",
			code: -32601,
			message: `no page bridge is attached; ${name} was not invoked`,
		}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new TypeError(`bad ${key}`);
	}
	return value;
}

/**
 * Read one outcome out of a bridge reply.
 *
 * The reply is hostile even though our own extension produced it: the page realm
 * can subvert anything the injected code touched, and that value is forwarded
 * here unchanged. Every field is checked, and an unrecognised shape refuses
 * rather than falling through to "completed" - defaulting an unknown reply to
 * success is how a tool call reports work that never happened.
 *
 * The two shapes that arrive are not two spellings of one thing, and the
 * difference is the draft's rather than ours:
 *
 * - **a string**, when the tool ran. The WebMCP draft types
 *   `ModelContext.executeTool()` as returning `USVString`, and this repository
 *   implements that: the registered tool's return value is stringified and the
 *   injected function forwards it untouched. Reading that as "not a record"
 *   refused every successful call - the daemon could list a page's tools and
 *   then refuse to execute any of them, from a browser and a page that were
 *   both working.
 * - **a record**, and only when a person is being asked. That reply is the
 *   Trusted tier's own, built here rather than by the page, and it is
 *   distinguished by `requiresConfirmation`.
 */
export function readToolOutcome(value: unknown): ToolOutcome {
	// The Trusted tier signals "a person is being asked" with this flag, and it
	// is the only field that distinguishes that reply from a result. It is read
	// first so a confirmation is never mistaken for anything else.
	if (isRecord(value) && value["requiresConfirmation"] !== undefined) {
		if (value["requiresConfirmation"] !== true) {
			// Present but not `true` is a shape the Trusted tier does not produce.
			// Reading it as a result would execute the branch that files a
			// confirmation with a body the person was never shown.
			throw new TypeError("bad requiresConfirmation");
		}
		return {
			kind: "approval-required",
			toolName: readString(value, "toolName"),
			description: readString(value, "description"),
			argsJson: readString(value, "argsJson"),
			origin: readString(value, "origin"),
			frameOrigin: readString(value, "frameOrigin"),
			binding: readString(value, "pendingApproval"),
		};
	}
	// The draft's own return type. A refusal never arrives here - the bridge
	// rejects the call and `refusalFrom` shapes that - so a string reaching this
	// line is by construction a result, and it is forwarded without
	// interpretation. It is not parsed: the value belongs to the page, and this
	// process has no business deciding whether the page's JSON is well formed.
	if (typeof value === "string") {
		return { kind: "completed", result: value };
	}
	throw new TypeError("bad bridge reply");
}

/**
 * Turn a thrown bridge refusal into an outcome rather than letting it escape.
 *
 * A refusal is an answer, not a crash: the extension refuses for reasons it can
 * name, and a client that gets an opaque transport error learns nothing.
 */
export function refusalFrom(error: unknown, fallbackCode: number): ToolOutcome {
	if (error instanceof Error) {
		const carried: unknown = (error as { code?: unknown }).code;
		const code =
			typeof carried === "number" && Number.isInteger(carried)
				? carried
				: fallbackCode;
		return { kind: "refused", code, message: error.message };
	}
	return { kind: "refused", code: fallbackCode, message: "request failed" };
}
