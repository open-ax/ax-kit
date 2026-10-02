// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	assertManifestPosture,
	defaultManifestPosture,
	firefoxManifestPosture,
} from "../src/manifest.js";
import {
	AUDIT_TRAIL_DISCLAIMER,
	applyArgAllowList,
	isExposedToCaller,
	validateFrameTool,
	WorkerAuditTrail,
} from "../src/trusted-tier.js";

describe("manifest posture", () => {
	it("defaults to deny-external and closed private browsing", () => {
		const posture = defaultManifestPosture();
		expect(posture.incognito).toBe("not_allowed");
		expect(posture.externallyConnectable.ids).toEqual([]);
		expect(posture.externallyConnectable.matches).toEqual([]);
		expect(posture.hostScopeJustification.length).toBeGreaterThan(0);
		expect(() => assertManifestPosture(posture)).not.toThrow();
	});

	it("rejects open posture", () => {
		expect(() =>
			assertManifestPosture({
				...defaultManifestPosture(),
				incognito: "spanning",
			}),
		).toThrow(TypeError);
	});

	it("keeps Firefox as a separate target", () => {
		expect(firefoxManifestPosture().backgroundKind).toBe("event-page");
		expect(defaultManifestPosture().backgroundKind).toBe("service-worker");
	});
});

describe("trusted tier", () => {
	it("validates Main-world values at the boundary", () => {
		expect(() =>
			validateFrameTool({
				name: "viewCart",
				origin: "https://shop.example",
				frameOrigin: "https://shop.example",
				description: "Show the cart.",
				consequentialHint: false,
				readOnlyHint: true,
				definitionVersion: "v1",
				declaredKeys: ["detailed"],
			}),
		).not.toThrow();
		expect(() => validateFrameTool({ name: "bad name!" })).toThrow(TypeError);
		expect(() =>
			validateFrameTool({
				name: "viewCart",
				origin: "null",
				frameOrigin: "https://shop.example",
				description: "x",
				consequentialHint: false,
				readOnlyHint: true,
				definitionVersion: "v1",
				declaredKeys: [],
			}),
		).toThrow(TypeError);
		// Arguments are minimised against `declaredKeys`, so a malformed list is
		// rejected rather than read as "accepts nothing" or "accepts anything".
		const withoutDeclaredKeys = {
			name: "viewCart",
			origin: "https://shop.example",
			frameOrigin: "https://shop.example",
			description: "Show the cart.",
			consequentialHint: false,
			readOnlyHint: true,
			definitionVersion: "v1",
		};
		expect(() => validateFrameTool(withoutDeclaredKeys)).toThrow(TypeError);
		expect(() =>
			validateFrameTool({ ...withoutDeclaredKeys, declaredKeys: "detailed" }),
		).toThrow(TypeError);
		expect(() =>
			validateFrameTool({ ...withoutDeclaredKeys, declaredKeys: [7] }),
		).toThrow(TypeError);
		expect(() =>
			validateFrameTool({ ...withoutDeclaredKeys, declaredKeys: [""] }),
		).toThrow(TypeError);
		// A page that declares no arguments is valid: it accepts none.
		expect(
			validateFrameTool({ ...withoutDeclaredKeys, declaredKeys: [] })
				.declaredKeys,
		).toEqual([]);
	});

	it("mirrors exposure and minimizes args", () => {
		expect(
			isExposedToCaller("https://shop.example", [], "https://shop.example"),
		).toBe(true);
		expect(
			isExposedToCaller("https://a.example", [], "https://b.example"),
		).toBe(false);
		expect(
			isExposedToCaller(
				"https://a.example",
				["https://b.example"],
				"https://b.example",
			),
		).toBe(true);
		expect(applyArgAllowList({ a: 1, b: 2 }, ["a"])).toEqual({ a: 1 });
		expect(() => applyArgAllowList({ a: 1 }, ["__proto__"])).toThrow(TypeError);
		expect(() => applyArgAllowList({ a: 1 }, ["constructor"])).toThrow(
			TypeError,
		);
		const minimized = applyArgAllowList({ a: 1 }, ["a"]);
		expect(Object.getPrototypeOf(minimized)).toBe(null);
		expect(Object.hasOwn(minimized, "a")).toBe(true);
	});

	it("holds the audit trail off-page with a local-only disclaimer", () => {
		const trail = new WorkerAuditTrail();
		trail.append({
			key: "k",
			toolName: "viewCart",
			origin: "https://shop.example",
			decision: "executed",
		});
		expect(trail.list()).toHaveLength(1);
		expect(AUDIT_TRAIL_DISCLAIMER).toContain("Local log only");
		expect(() => trail.append({ key: "k" })).toThrow(TypeError);
	});
});
