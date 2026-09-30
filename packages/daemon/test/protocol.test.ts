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
			protocolVersion: version,
			clientCapabilities: {},
			clientInfo: { name: "test-client", version: "0.0.0" },
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
		expect(response.error?.code).toBe(-32000);
	});

	it("treats deprecated capabilities as absent", () => {
		for (const method of [
			"initialize",
			"ping",
			"roots/list",
			"sampling/createMessage",
		]) {
			expect(isDeprecatedMethod(method)).toBe(true);
			const response = dispatchRequest(
				{ jsonrpc: "2.0", id: 4, method, params: meta() },
				[],
				createDaemonInfo(),
			);
			expect(response.error?.code).toBe(-32601);
		}
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
