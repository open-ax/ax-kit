// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHitlKey } from "../src/hitl.js";
import {
	assertLiveContext,
	assertManifestPosture,
	defaultManifestPosture,
	firefoxManifestPosture,
} from "../src/manifest.js";
import {
	AUDIT_TRAIL_DISCLAIMER,
	applyArgAllowList,
	authorizeExecution,
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

	it("never approves from a stale context", () => {
		expect(() => assertLiveContext(true)).not.toThrow();
		expect(() => assertLiveContext(false)).toThrow(TypeError);
		expect(() => assertLiveContext(undefined)).toThrow(TypeError);
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
			}),
		).toThrow(TypeError);
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
		const decision = applyArgAllowList({ a: 1, b: 2 }, ["a"]);
		expect(decision.minimizedArgs).toEqual({ a: 1 });
	});

	it("authorizes only bound approvals from live contexts", () => {
		const key = createHitlKey({
			tabId: 1,
			documentId: "d",
			frameId: 0,
			toolName: "viewCart",
			argsHash: "abcd",
		});
		expect(() =>
			authorizeExecution({
				handler: "executeTool",
				contextLive: true,
				key,
				approvedKey: "1|d|0|viewCart|abcd",
				callerOrigin: "https://shop.example",
				allowedOrigins: [],
			}),
		).not.toThrow();
		expect(() =>
			authorizeExecution({
				handler: "runAnything",
				contextLive: true,
				key,
				approvedKey: "1|d|0|viewCart|abcd",
				callerOrigin: "https://shop.example",
				allowedOrigins: [],
			}),
		).toThrow(TypeError);
		expect(() =>
			authorizeExecution({
				handler: "executeTool",
				contextLive: false,
				key,
				approvedKey: "1|d|0|viewCart|abcd",
				callerOrigin: "https://shop.example",
				allowedOrigins: [],
			}),
		).toThrow(TypeError);
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
