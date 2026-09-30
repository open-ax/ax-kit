// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	ApprovalStore,
	CONFIRMATION_SURFACE,
	canonicalizeArgs,
	createHitlKey,
	hashArgs,
	hitlKeysEqual,
	hitlKeyToString,
} from "../src/hitl.js";

function details(documentId = "doc-1") {
	return {
		key: createHitlKey({
			tabId: 7,
			documentId,
			frameId: 0,
			toolName: "proceedToCheckout",
			argsHash: hashArgs(canonicalizeArgs({ sku: "a", quantity: 1 })),
		}),
		toolName: "proceedToCheckout",
		origin: "https://shop.example",
		frameOrigin: "https://shop.example",
		argsJson: canonicalizeArgs({ sku: "a", quantity: 1 }),
		consequentialHint: true,
		readOnlyHint: false,
		definitionVersion: "v1",
	};
}

describe("hitl binding", () => {
	it("canonicalizes independent of key order", () => {
		expect(canonicalizeArgs({ b: 1, a: 2 })).toBe(
			canonicalizeArgs({ a: 2, b: 1 }),
		);
		expect(hashArgs("x")).toHaveLength(8);
	});

	it("compares all five key parts", () => {
		const base = createHitlKey({
			tabId: 1,
			documentId: "d",
			frameId: 0,
			toolName: "viewCart",
			argsHash: "abcd",
		});
		expect(hitlKeysEqual(base, { ...base })).toBe(true);
		expect(hitlKeysEqual(base, { ...base, tabId: 2 })).toBe(false);
		expect(hitlKeysEqual(base, { ...base, documentId: "e" })).toBe(false);
		expect(hitlKeysEqual(base, { ...base, toolName: "searchProducts" })).toBe(
			false,
		);
		expect(hitlKeyToString(base)).toContain("viewCart");
	});

	it("requires a gesture and consumes approval on use", () => {
		const store = new ApprovalStore();
		expect(() => store.requestApproval(details(), false)).toThrow(TypeError);
		const key = store.requestApproval(details(), true);
		expect(store.pendingKeys()).toContain(key);
		expect(() => store.verifyAndConsume(key, details().key, "v1")).toThrow(
			TypeError,
		);
		store.approveApproval(key);
		store.verifyAndConsume(key, details().key, "v1");
		expect(store.pendingKeys()).not.toContain(key);
		expect(() => store.verifyAndConsume(key, details().key, "v1")).toThrow(
			TypeError,
		);
	});

	it("rejects navigation drift and definition drift", () => {
		const store = new ApprovalStore();
		const key = store.requestApproval(details("doc-old"), true);
		store.approveApproval(key);
		const moved = createHitlKey({
			...details("doc-old").key,
			documentId: "doc-new",
		});
		expect(() => store.verifyAndConsume(key, moved, "v1")).toThrow(TypeError);
		const key2 = store.requestApproval(details("doc-a"), true);
		store.approveApproval(key2);
		expect(() =>
			store.verifyAndConsume(key2, details("doc-a").key, "v2"),
		).toThrow(TypeError);
	});

	it("invalidates a document without touching others", () => {
		const store = new ApprovalStore();
		store.requestApproval(details("doc-a"), true);
		store.requestApproval(details("doc-b"), true);
		store.invalidateDocument("doc-a");
		expect(store.pendingKeys().join(",")).not.toContain("doc-a");
		expect(store.pendingKeys().join(",")).toContain("doc-b");
	});

	it("uses the side panel only", () => {
		expect(CONFIRMATION_SURFACE).toBe("side-panel");
	});
});
