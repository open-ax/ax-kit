// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	assertHandlerName,
	createInjectionRequest,
	HANDLER_NAMES,
	isHandlerName,
	TRANSPORT_KIND,
} from "../src/handlers.js";

describe("enumerated handlers", () => {
	it("accepts only the fixed set", () => {
		for (const name of HANDLER_NAMES) {
			expect(isHandlerName(name)).toBe(true);
			expect(assertHandlerName(name)).toBe(name);
		}
		expect(HANDLER_NAMES.length).toBe(3);
	});

	it("rejects unknown names so generic dispatch is impossible", () => {
		expect(isHandlerName("dispatch")).toBe(false);
		expect(isHandlerName("eval")).toBe(false);
		expect(isHandlerName("")).toBe(false);
		expect(isHandlerName(undefined)).toBe(false);
		expect(() => assertHandlerName("runAnything")).toThrow(TypeError);
	});

	it("requires JSON-serializable args", () => {
		const request = createInjectionRequest("listTools", { tabId: 1 });
		expect(request.handler).toBe("listTools");
		expect(() => createInjectionRequest("nope", {})).toThrow(TypeError);
		expect(() => createInjectionRequest("listTools", { fn: () => 1 })).toThrow(
			TypeError,
		);
		expect(() =>
			createInjectionRequest("listTools", { ["__proto__"]: 1 }),
		).toThrow(TypeError);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => createInjectionRequest("listTools", circular)).toThrow(
			TypeError,
		);
	});

	it("exposes exactly one transport with no page-visible channel", async () => {
		expect(TRANSPORT_KIND).toBe("injection-only");
		const entry = await import("../src/index.js");
		const keys = Object.keys(entry).sort();
		expect(keys).not.toContain("dispatch");
		expect(keys).not.toContain("postMessage");
		expect(keys).not.toContain("handshake");
		expect(keys).not.toContain("channel");
		expect(keys).not.toContain("eval");
	});
});
