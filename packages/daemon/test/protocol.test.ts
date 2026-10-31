// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { BridgeProvider, ToolOutcome } from "../src/outcome.js";
import {
	createDaemonInfo,
	dispatchRequest,
	isDeprecatedMethod,
	PROTOCOL_VERSION,
	parseFrame,
	serializeFrame,
} from "../src/protocol.js";

/**
 * A provider that answers from a fixed script.
 *
 * The dispatcher takes a provider rather than an array of tools because the two
 * sides of the bridge cannot be answered synchronously. These tests are about
 * the wire shape, so the provider is the simplest thing that satisfies the
 * interface — which is also what makes a failure here a wire failure.
 */
function provider(
	tools: ReadonlyArray<Record<string, unknown>> = [],
	call: (name: string) => ToolOutcome = () => ({
		kind: "refused",
		code: -32601,
		message: "nothing behind this provider",
	}),
): BridgeProvider {
	return {
		listTools: async () => tools,
		callTool: async (name: string) => call(name),
	};
}

const INFO = createDaemonInfo();

function meta(version: string = PROTOCOL_VERSION): Record<string, unknown> {
	return {
		_meta: {
			"io.modelcontextprotocol/protocolVersion": version,
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": {
				name: "test-client",
				version: "0.0.0",
			},
		},
	};
}

describe("stateless protocol", () => {
	it("answers mandatory discovery with a completion marker", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: meta(),
			},
			provider(),
			INFO,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.supportedVersions).toContain(PROTOCOL_VERSION);
	});

	it("carries the cache fields every list-shaped result requires", async () => {
		// `DiscoverResult` and `ListToolsResult` both extend `CacheableResult`,
		// which makes `ttlMs` and `cacheScope` required - not optional. Verified
		// against `schema/2026-07-28/schema.ts`. A result missing them is not a
		// `2026-07-28` result, and nothing local would otherwise have said so.
		const discovered = (
			await dispatchRequest(
				{ jsonrpc: "2.0", id: 20, method: "server/discover", params: meta() },
				provider(),
				INFO,
			)
		).result as Record<string, unknown>;
		const listed = (
			await dispatchRequest(
				{ jsonrpc: "2.0", id: 21, method: "tools/list", params: meta() },
				provider([{ name: "viewCart" }]),
				INFO,
			)
		).result as Record<string, unknown>;
		for (const result of [discovered, listed]) {
			expect(typeof result.ttlMs).toBe("number");
			expect(["public", "private"]).toContain(result.cacheScope);
		}
		// The scopes differ for a reason: the daemon's own identity is the same
		// for everyone, while a tool listing describes one person's page.
		expect(discovered.cacheScope).toBe("public");
		expect(listed.cacheScope).toBe("private");
		// Zero means consider-this-stale-immediately. The tools on the page the
		// person is looking at change under them; claiming otherwise would be the
		// kind of cache that serves yesterday's storefront.
		expect(listed.ttlMs).toBe(0);
	});

	it("does not put cache fields on a call, which does not extend CacheableResult", async () => {
		// `CallToolResult extends Result`, not `CacheableResult`. Asserting their
		// absence is what stops a future "add it everywhere" change from putting a
		// field the schema does not define for this result onto the wire.
		const called = (
			await dispatchRequest(
				{
					jsonrpc: "2.0",
					id: 22,
					method: "tools/call",
					params: { ...meta(), name: "viewCart", arguments: {} },
				},
				provider([], () => ({ kind: "completed", result: "{}" })),
				INFO,
			)
		).result as Record<string, unknown>;
		expect(called.ttlMs).toBeUndefined();
		expect(called.cacheScope).toBeUndefined();
	});
	it("lists tools with a completion marker and no session header", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: meta(),
			},
			provider([{ name: "viewCart" }]),
			INFO,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.tools).toEqual([{ name: "viewCart" }]);
		expect(response).not.toHaveProperty("sessionId");
	});

	it("rejects version drift with the version error", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/list",
				params: meta("2025-01-01"),
			},
			provider(),
			INFO,
		);
		expect(response.error?.code).toBe(-32022);
	});

	it("returns invalid request instead of throwing on bad frames", async () => {
		expect((await dispatchRequest(null, provider(), INFO)).error?.code).toBe(
			-32600,
		);
		expect(
			(await dispatchRequest({ jsonrpc: "2.0", id: 1 }, provider(), INFO)).error
				?.code,
		).toBe(-32600);
	});

	it("keeps deprecated roots, sampling, and logging usable", () => {
		for (const method of [
			"roots/list",
			"sampling/createMessage",
			"notifications/message",
		]) {
			expect(isDeprecatedMethod(method)).toBe(false);
		}
	});

	it("treats deprecated capabilities as absent", async () => {
		for (const method of ["initialize", "ping", "client/registerCapability"]) {
			expect(isDeprecatedMethod(method)).toBe(true);
			const response = await dispatchRequest(
				{ jsonrpc: "2.0", id: 4, method, params: meta() },
				provider(),
				INFO,
			);
			expect(response.error?.code).toBe(-32601);
		}
	});

	it("keeps tools/list_changed usable, because the revision kept it", async () => {
		// Verified against `schema/2026-07-28/schema.ts`: the notification is
		// still present and only its delivery moved. Rejecting a live method as
		// unknown is a false negative a client cannot tell from a broken server,
		// so this is the one method that must NOT be in the removed set.
		expect(isDeprecatedMethod("notifications/tools/list_changed")).toBe(false);
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 40,
				method: "notifications/tools/list_changed",
				params: meta(),
			},
			provider(),
			INFO,
		);
		expect(response.error?.code).toBe(-32601);
	});

	it("validates tool listings and call names", async () => {
		const badTools = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/list",
				params: meta(),
			},
			provider([{ title: "no-name" }]),
			INFO,
		);
		expect(badTools.error?.code).toBe(-32602);
		const badCall = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { ...meta(), name: "", arguments: {} },
			},
			provider(),
			INFO,
		);
		expect(badCall.error?.code).toBe(-32602);
		const legacyWrapper = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { ...meta(), call: { name: "viewCart" } },
			},
			provider(),
			INFO,
		);
		expect(legacyWrapper.error?.code).toBe(-32602);
	});

	it("refuses a tools/call rather than completing work it cannot do", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { ...meta(), name: "viewCart", arguments: { sku: "a" } },
			},
			provider(),
			INFO,
		);
		// The spec parameter shape is accepted and the call is understood — but
		// there is no page bridge behind this process, so it is refused inside the
		// result rather than being completed. A client that reads a completion
		// marker will report the order as placed; the only honest answer is one
		// that tells it nothing happened.
		expect(response.error).toBeUndefined();
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.isError).toBe(true);
		expect(response.result).toBeDefined();
	});

	it("completes a tool call that ran, carrying the page's own result", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 9,
				method: "tools/call",
				params: { ...meta(), name: "viewCart", arguments: {} },
			},
			provider([], () => ({ kind: "completed", result: '{"items":3}' })),
			INFO,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: '{"items":3}' }]);
	});

	it("answers a consequential call with input_required, not a failure", async () => {
		// The pending-approval case is the protocol's own multi-round-trip
		// shape, not an error dressed as one. Encoding it as a refusal would
		// teach every client that a person saying yes is an outage.
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { ...meta(), name: "payNow", arguments: {} },
			},
			provider([], () => ({
				kind: "approval-required",
				toolName: "payNow",
				description: "Charge the saved card.",
				argsJson: "{}",
				origin: "https://shop.test",
				frameOrigin: "https://shop.test",
				binding: '["tab-1","doc-1",0,"payNow","abc"]',
			})),
			INFO,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("input_required");
		expect(result.isError).toBeUndefined();
		expect(response.error).toBeUndefined();
		const requests = result.inputRequests as Record<
			string,
			Record<string, unknown>
		>;
		const elicitation = requests.axConfirmation;
		expect(elicitation?.method).toBe("elicitation/create");
		expect(result.requestState).toBe('["tab-1","doc-1",0,"payNow","abc"]');
	});

	it("reports a provider that throws as a refusal, not a crash", async () => {
		const response = await dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 11,
				method: "tools/call",
				params: { ...meta(), name: "viewCart", arguments: {} },
			},
			{
				listTools: async () => [],
				callTool: async () => {
					throw new Error("bridge call timed out after dispatch");
				},
			},
			INFO,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toMatch(/timed out/);
	});

	it("frames without embedded newlines", () => {
		const request = parseFrame(
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
		);
		expect(request.method).toBe("server/discover");
		expect(() => parseFrame("not json")).toThrow(TypeError);
		expect(() => parseFrame("a\nb")).toThrow(TypeError);
		const text = serializeFrame({ jsonrpc: "2.0", id: 1, result: {} });
		expect(text.includes("\n")).toBe(false);
	});
});
