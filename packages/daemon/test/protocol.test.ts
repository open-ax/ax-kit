// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	createDaemonInfo,
	dispatchRequest,
	isDeprecatedMethod,
	PROTOCOL_VERSION,
	parseFrame,
	serializeFrame,
} from "../src/protocol.js";

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
	it("answers mandatory discovery with a completion marker", () => {
		const info = createDaemonInfo();
		const response = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: meta(),
			},
			[],
			info,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.supportedVersions).toContain(PROTOCOL_VERSION);
	});

	it("lists tools with a completion marker and no session header", () => {
		const response = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: meta(),
			},
			[{ name: "viewCart" }],
			createDaemonInfo(),
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(response).not.toHaveProperty("sessionId");
	});

	it("rejects version drift with the version error", () => {
		const response = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/list",
				params: meta("2025-01-01"),
			},
			[],
			createDaemonInfo(),
		);
		expect(response.error?.code).toBe(-32022);
	});

	it("returns invalid request instead of throwing on bad frames", () => {
		expect(dispatchRequest(null, [], createDaemonInfo()).error?.code).toBe(
			-32600,
		);
		expect(
			dispatchRequest({ jsonrpc: "2.0", id: 1 }, [], createDaemonInfo()).error
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

	it("treats deprecated capabilities as absent", () => {
		for (const method of ["initialize", "ping", "client/registerCapability"]) {
			expect(isDeprecatedMethod(method)).toBe(true);
			const response = dispatchRequest(
				{ jsonrpc: "2.0", id: 4, method, params: meta() },
				[],
				createDaemonInfo(),
			);
			expect(response.error?.code).toBe(-32601);
		}
	});

	it("validates tool listings and call names", () => {
		const badTools = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/list",
				params: meta(),
			},
			[{ title: "no-name" }],
			createDaemonInfo(),
		);
		expect(badTools.error?.code).toBe(-32602);
		const badCall = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { ...meta(), name: "", arguments: {} },
			},
			[],
			createDaemonInfo(),
		);
		expect(badCall.error?.code).toBe(-32602);
		const legacyWrapper = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { ...meta(), call: { name: "viewCart" } },
			},
			[],
			createDaemonInfo(),
		);
		expect(legacyWrapper.error?.code).toBe(-32602);
	});

	it("calls tools with the spec parameter shape", () => {
		const response = dispatchRequest(
			{
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { ...meta(), name: "viewCart", arguments: { sku: "a" } },
			},
			[],
			createDaemonInfo(),
		);
		const result = response.result as Record<string, unknown>;
		expect(result.resultType).toBe("complete");
		expect(result.name).toBe("viewCart");
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
