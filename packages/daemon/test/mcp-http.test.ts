// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PageBridge } from "../src/bridge.js";
import type { Transport } from "../src/lifecycle.js";
import { startTransport } from "../src/lifecycle.js";
import type { BridgeProvider } from "../src/outcome.js";
import { createDaemonInfo, PROTOCOL_VERSION } from "../src/protocol.js";
import { PageBridgeProvider } from "../src/provider.js";

/**
 * MCP over HTTP, against a real listener with real headers.
 *
 * This endpoint exists so that a third party can check what we claim about the
 * `2026-07-28` revision rather than taking our word for it. That only helps if
 * the header handling is right, and the headers are the part a client cannot
 * work around: a request whose headers disagree with its body is refused, and a
 * refusal a client cannot see is the same as no answer.
 *
 * The header names and requirements are quoted from
 * `schema/2026-07-28` and the revision's transport specification.
 */

const dirs: string[] = [];
const transports: Transport[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ax-mcp-http-"));
	dirs.push(dir);
	return dir;
}

/** A provider with one tool, so `Mcp-Name` has something to name. */
function provider(): BridgeProvider {
	return {
		listTools: async () => [
			{ name: "viewCart", description: "Show the cart." },
		],
		callTool: async (name: string) => ({
			kind: "completed",
			result: JSON.stringify({ echoed: name }),
		}),
	};
}

async function serve(): Promise<Transport> {
	const transport = await startTransport({
		discoveryDir: await tempDir(),
		// A bridge nobody pulls from, so `tools/list` answers from the provider
		// alone and the HTTP surface is tested without a browser in the way.
		bridge: new PageBridge(),
		provider: provider(),
		info: createDaemonInfo(),
	});
	transports.push(transport);
	return transport;
}

function post(
	transport: Transport,
	headers: Record<string, string>,
	body: unknown,
	withBearer = true,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = typeof body === "string" ? body : JSON.stringify(body);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: transport.port,
				path: "/mcp",
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload, "utf8"),
					origin: `http://127.0.0.1:${String(transport.port)}`,
					accept: "application/json, text/event-stream",
					...(withBearer ? { "x-ax-bearer": transport.bearer } : {}),
					...headers,
				},
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: text }),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

function required(method: string, extra: Record<string, string> = {}) {
	return {
		"mcp-protocol-version": PROTOCOL_VERSION,
		"mcp-method": method,
		...extra,
	};
}

function frame(method: string, params: Record<string, unknown>): unknown {
	return {
		jsonrpc: "2.0",
		id: 1,
		method,
		params: {
			_meta: {
				"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
			},
			...params,
		},
	};
}

afterEach(async () => {
	for (const transport of transports.splice(0)) {
		await transport.close().catch(() => {});
	}
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

describe("MCP over HTTP", () => {
	it("answers a request whose headers agree with its body", async () => {
		const transport = await serve();
		const response = await post(
			transport,
			required("tools/list"),
			frame("tools/list", {}),
		);
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as Record<string, unknown>;
		expect((body.result as Record<string, unknown>).resultType).toBe(
			"complete",
		);
	});

	it("serves tools/call, which the stdio path refused for want of a bridge", async () => {
		const transport = await serve();
		const response = await post(
			transport,
			required("tools/call", { "mcp-name": "viewCart" }),
			frame("tools/call", { name: "viewCart", arguments: {} }),
		);
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as Record<string, unknown>;
		const result = body.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.isError).toBeUndefined();
		expect(JSON.stringify(result.content)).toMatch(/viewCart/);
	});

	it("refuses a header that disagrees with the body", async () => {
		const transport = await serve();
		// Each of these is a client that has lost track of what it is asking for.
		// Guessing which of the two values it meant is how a call gets executed
		// against the wrong tool, so the disagreement is the answer.
		const wrongMethod = await post(
			transport,
			required("tools/list"),
			frame("tools/call", { name: "viewCart" }),
		);
		expect(wrongMethod.status).toBe(400);
		expect(
			(JSON.parse(wrongMethod.body) as { error?: { code?: number } }).error
				?.code,
		).toBe(-32020);

		const wrongName = await post(
			transport,
			required("tools/call", { "mcp-name": "someOtherTool" }),
			frame("tools/call", { name: "viewCart" }),
		);
		expect(wrongName.status).toBe(400);

		const noName = await post(
			transport,
			required("tools/call"),
			frame("tools/call", { name: "viewCart" }),
		);
		expect(noName.status).toBe(400);
		expect(noName.body).toMatch(/Mcp-Name is required/);
	});

	it("refuses a protocol version it does not speak, by header", async () => {
		const transport = await serve();
		const response = await post(
			transport,
			{ "mcp-protocol-version": "2025-06-18", "mcp-method": "tools/list" },
			frame("tools/list", {}),
		);
		expect(response.status).toBe(400);
		expect(
			(JSON.parse(response.body) as { error?: { code?: number } }).error?.code,
		).toBe(-32022);
	});

	it("requires Accept to name both response types", async () => {
		const transport = await serve();
		const response = await new Promise<number>((resolve, reject) => {
			const payload = JSON.stringify(frame("tools/list", {}));
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: transport.port,
					path: "/mcp",
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(payload, "utf8"),
						origin: `http://127.0.0.1:${String(transport.port)}`,
						"x-ax-bearer": transport.bearer,
						// The revision requires both, so a client that cannot read
						// SSE says so rather than mis-parsing what it gets.
						accept: "application/json",
						...required("tools/list"),
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode ?? 0));
				},
			);
			req.on("error", reject);
			req.end(payload);
		});
		expect(response).toBe(400);
	});

	it("answers GET and DELETE with 405, because there is no stream and no session", async () => {
		const transport = await serve();
		for (const method of ["GET", "DELETE"]) {
			const response = await new Promise<number>((resolve, reject) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port: transport.port,
						path: "/mcp",
						method,
						headers: {
							origin: `http://127.0.0.1:${String(transport.port)}`,
							"x-ax-bearer": transport.bearer,
						},
					},
					(res) => {
						res.resume();
						res.on("end", () => resolve(res.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end();
			});
			expect(response, method).toBe(405);
		}
	});

	it("answers a notification with 202 and no body", async () => {
		const transport = await serve();
		const response = await post(transport, required("tools/list"), {
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		});
		expect(response.status).toBe(202);
		expect(response.body).toBe("");
	});

	it("decodes the Base64 sentinel in Mcp-Name before comparing it", async () => {
		// The revision: a value that cannot be a plain ASCII header travels as
		// `=?base64?<value>?=`, and servers **MUST** decode it before comparing it
		// to the body. An earlier implementation skipped the decode on the grounds
		// that tool names are header-safe anyway. That is wrong - the revision only
		// *should*-constrains them, and `resources/read` carries a URI - so a
		// legitimate client was being refused.
		const transport = await serve();
		const name = "checkout ünïcode";
		const response = await post(
			transport,
			required("tools/call", {
				"mcp-name": `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`,
			}),
			frame("tools/call", { name, arguments: {} }),
		);
		// Decoded, so it matched, so the call was answered rather than refused.
		expect(response.status).toBe(200);
	});

	it("refuses a sentinel that decodes to something else", async () => {
		const transport = await serve();
		const response = await post(
			transport,
			required("tools/call", {
				"mcp-name": `=?base64?${Buffer.from("someOtherTool", "utf8").toString("base64")}?=`,
			}),
			frame("tools/call", { name: "viewCart" }),
		);
		expect(response.status).toBe(400);
		expect(
			(JSON.parse(response.body) as { error?: { code?: number } }).error?.code,
		).toBe(-32020);
	});

	it("still enforces the bearer on the MCP endpoint", async () => {
		// The bearer is checked before anything is routed, so an unauthenticated
		// caller cannot even learn that this endpoint exists.
		const transport = await serve();
		const response = await post(
			transport,
			required("tools/list"),
			frame("tools/list", {}),
			false,
		);
		expect(response.status).toBe(403);
	});
});

describe("bridge provider", () => {
	it("answers nothing when no worker is attached, without waiting for a deadline", async () => {
		// A `tools/list` on a daemon nobody is pulling from has to come back
		// promptly. Enqueueing the question would leave it waiting for the call
		// deadline, which is a minute spent saying there is nothing to say.
		const bridge = new PageBridge();
		const tools = await new PageBridgeProvider(bridge).listTools();
		expect(tools).toEqual([]);
		const outcome = await new PageBridgeProvider(bridge).callTool("payNow", {});
		expect(outcome.kind).toBe("refused");
		expect(outcome.kind === "refused" && outcome.code).toBe(-32013);
	});
});
