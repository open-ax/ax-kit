// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Stateless MCP over HTTP, so a third party can check what we claim.
 *
 * Everything here is ours, not draft-derived. The draft defines the page
 * surface; this is the client protocol's own HTTP transport, shaped to the
 * `2026-07-28` revision.
 *
 * This exists for one reason and it is a testing reason. Claiming compliance
 * with a protocol revision while validating it only against our own reading of
 * that revision is not evidence of anything: both sides of the test would be the
 * same author. The specification ships a conformance suite, and it speaks HTTP.
 * Exposing the endpoint that suite already knows how to drive is the cheapest
 * way to stop arguing with ourselves about whether we are right.
 *
 * The revision removed sessions wholesale, so this is the whole transport:
 *
 * - one path, `POST /mcp`;
 * - `GET` and `DELETE` answer `405`, because there is no stream to open and no
 *   session to terminate;
 * - an inbound `Mcp-Session-Id` is ignored and never echoed;
 * - notifications answer `202` with no body;
 * - `MCP-Protocol-Version` and `Mcp-Method` are required on every request, and
 *   `Mcp-Name` is required where a name exists, each validated against
 *   the body so a disagreement is a refusal rather than a silent preference.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "./bridge.js";
import type { BridgeProvider } from "./outcome.js";
import type { DaemonInfo, JsonRpcResponse } from "./protocol.js";
import { dispatchRequest, PROTOCOL_VERSION } from "./protocol.js";

/** Bounded so a hostile client cannot exhaust memory with one request. */
const MAX_BODY_BYTES = 1024 * 1024;

export const MCP_PATH = "/mcp" as const;

/** The mismatch code the revision names for a header that disagrees. */
const HEADER_MISMATCH = -32020;

/** Methods that carry a `name` or `uri`, and so require `Mcp-Name`. */
const NAMED_METHODS: ReadonlySet<string> = new Set([
	"tools/call",
	"resources/read",
	"prompts/get",
]);

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	if (Array.isArray(value)) {
		return undefined;
	}
	return value;
}

/**
 * The `Accept` header, which this revision requires to name both response
 * types. A client that cannot read SSE is still required to say so; refusing the
 * request here is what turns that into an error the client can see rather than a
 * response it silently mis-parses.
 */
function acceptsBothTypes(request: IncomingMessage): boolean {
	const accept = header(request, "accept");
	if (typeof accept !== "string") {
		return false;
	}
	const lower = accept.toLowerCase();
	return (
		lower.includes("application/json") && lower.includes("text/event-stream")
	);
}

function refuse(
	response: ServerResponse,
	status: number,
	id: string | number | null,
	code: number,
	message: string,
): void {
	const body: JsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	};
	send(response, status, body);
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const text: unknown = JSON.stringify(body);
	const payload = typeof text === "string" ? text : "null";
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload, "utf8"),
	});
	response.end(payload);
}

function readId(value: unknown): string | number | null {
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	return null;
}

/** The `name` or `uri` the request identifies, or null when it has neither. */
function readTarget(record: Record<string, unknown>): string | null {
	const params = record.params;
	if (typeof params !== "object" || params === null) {
		return null;
	}
	const inner = params as Record<string, unknown>;
	for (const key of ["name", "uri"]) {
		const value = inner[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return null;
}

/** Matches the Base64 sentinel the revision defines for header values. */
const SENTINEL = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;

/**
 * Decode one `Mcp-Name` header value.
 *
 * The revision says a value that cannot be represented as a plain ASCII header
 * value travels as `=?base64?<value>?=`, and that **"servers MUST decode an
 * encoded `Mcp-Name` value before comparing it to the corresponding request body
 * value"**.
 *
 * An earlier draft of this file skipped the decode, on the reasoning that tool
 * names are constrained to `[A-Za-z0-9_.-]` and therefore never need it. That
 * was wrong twice over: the revision says tool names are only *should*-
 * constrained to header-safe characters, so a client is free to send one we
 * would have refused, and `resources/read` carries a URI, which is routinely
 * outside the safe set.
 *
 * Clients are required to Base64-encode any plain value that itself matches the
 * sentinel pattern, so a decoded value that looks like a sentinel is the
 * client's own doing and is compared as the plain string it is.
 */
function decodeHeaderName(value: string): string | null {
	const match = SENTINEL.exec(value);
	if (match === null) {
		return value;
	}
	try {
		return Buffer.from(match[1], "base64").toString("utf8");
	} catch {
		// A value that looks like the sentinel and is not valid Base64 cannot be
		// matched against anything, so it is a refusal rather than a guess.
		return null;
	}
}

/**
 * Serve one HTTP MCP request.
 *
 * Returns true when it handled the request, false when the path is not ours.
 * Transport-level refusals - a missing header, a wrong method - answer here
 * rather than in the dispatcher, because they are violations of the transport
 * contract rather than of the method being called.
 */
export async function handleMcpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	provider: BridgeProvider,
	info: DaemonInfo,
): Promise<boolean> {
	const path = (request.url ?? "/").split("?")[0];
	if (path !== MCP_PATH) {
		return false;
	}
	if (request.method === "GET" || request.method === "DELETE") {
		// No stream to open and no session to terminate: the revision removed
		// both. Saying so explicitly beats a 404, which reads as "wrong path".
		response.writeHead(405, {
			allow: "POST",
			"content-type": "text/plain",
		});
		response.end("this transport is POST-only and stateless");
		return true;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST", "content-type": "text/plain" });
		response.end("method not allowed");
		return true;
	}
	if (!acceptsBothTypes(request)) {
		refuse(
			response,
			400,
			null,
			HEADER_MISMATCH,
			"Accept must name application/json and text/event-stream",
		);
		return true;
	}
	const version = header(request, "mcp-protocol-version");
	if (version !== PROTOCOL_VERSION) {
		refuse(
			response,
			400,
			null,
			-32022,
			`unsupported protocol version ${version ?? "(absent)"}; this server speaks ${PROTOCOL_VERSION}`,
		);
		return true;
	}
	let text: string;
	try {
		text = await readBody(request, MAX_BODY_BYTES);
	} catch {
		refuse(response, 400, null, -32600, "request body too large");
		return true;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		refuse(response, 400, null, -32700, "unparsable request");
		return true;
	}
	if (typeof parsed !== "object" || parsed === null) {
		refuse(response, 400, null, -32600, "invalid request");
		return true;
	}
	const record = parsed as Record<string, unknown>;
	const id = readId(record.id);
	const method = record.method;
	if (typeof method !== "string") {
		refuse(response, 400, null, -32600, "invalid request");
		return true;
	}
	// A notification carries no id and expects no result. Answering one with a
	// body would put a frame on the wire that the client is not waiting for.
	//
	// Tested for the *absence of the member*, not for `readId` returning null,
	// because those are different things and only one of them is a notification.
	// `readId` also returns null for `"id": null`, an object, or a boolean — a
	// request with a malformed id. Answering those 202 and empty told the client
	// nothing at all, where the revision says to refuse an invalid request id.
	// Silently accepting a malformed request is how a request that was never
	// understood comes to look like one that was understood and discarded.
	if (!("id" in record)) {
		response.writeHead(202);
		response.end();
		return true;
	}
	if (id === null) {
		refuse(response, 400, null, -32600, "invalid request id");
		return true;
	}
	// Every header is checked against the body, and a disagreement is refused.
	// Either value alone would do: a header the body contradicts is a client
	// that has lost track of what it is asking for, and guessing which one it
	// meant is how a request gets executed against the wrong tool.
	const declaredMethod = header(request, "mcp-method");
	if (declaredMethod !== method) {
		refuse(
			response,
			400,
			id,
			HEADER_MISMATCH,
			`Mcp-Method ${declaredMethod ?? "(absent)"} does not match body method ${method}`,
		);
		return true;
	}
	const target = readTarget(record);
	if (NAMED_METHODS.has(method)) {
		const declaredName = header(request, "mcp-name");
		if (declaredName === undefined) {
			refuse(
				response,
				400,
				id,
				HEADER_MISMATCH,
				`Mcp-Name is required for ${method}`,
			);
			return true;
		}
		if (target === null) {
			refuse(response, 400, id, -32602, `${method} requires a name`);
			return true;
		}
		// The revision allows a Base64 sentinel when the value is not header-safe,
		// and requires the server to decode it before comparing. A sentinel that
		// does not decode is a refusal rather than a guess: deciding what the caller
		// probably meant is how a request ends up executed against the wrong target.
		const decoded = decodeHeaderName(declaredName);
		if (decoded === null || decoded !== target) {
			refuse(
				response,
				400,
				id,
				HEADER_MISMATCH,
				`Mcp-Name ${declaredName} does not match body name ${String(target)}`,
			);
			return true;
		}
	}
	const result: JsonRpcResponse = await dispatchRequest(record, provider, info);
	send(response, 200, result);
	return true;
}
