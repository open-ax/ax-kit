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
		expect(hashArgs("x")).toHaveLength(64);
	});

	it("compares all five key parts", () => {
		const argsHash = hashArgs(canonicalizeArgs({ a: 1 }));
		const base = createHitlKey({
			tabId: 1,
			documentId: "d",
			frameId: 0,
			toolName: "viewCart",
			argsHash,
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

	it("invalidates a whole tab on navigation, approved or not", () => {
		const store = new ApprovalStore();
		const elsewhere = createHitlKey({
			...details("doc-c").key,
			tabId: 8,
		});
		const pending = store.requestApproval(details("doc-a"), true);
		const approved = store.requestApproval(details("doc-b"), true);
		store.approveApproval(approved);
		store.requestApproval({ ...details("doc-c"), key: elsewhere }, true);
		expect(store.pendingKeys()).toHaveLength(3);

		store.invalidateTab(7);

		// Both the merely-pending and the already-approved binding are dropped:
		// an approval that survives its own document is exactly the case that
		// would authorise an invocation against whatever loaded next.
		expect(store.pendingKeys()).toHaveLength(1);
		expect(store.pendingKeys().join(",")).toContain("doc-c");
		// A consumed-and-dropped approval must not verify afterwards.
		expect(() =>
			store.verifyAndConsume(approved, details("doc-b").key, "v1"),
		).toThrow(TypeError);
		expect(pending).not.toBe(approved);
		expect(() => store.invalidateTab("7")).toThrow(TypeError);
	});

	it("refuses a definition that changed after the person approved it", () => {
		const store = new ApprovalStore();
		const key = store.requestApproval(details("doc-a"), true);
		store.approveApproval(key);
		// Same target, same arguments, different definition: the person agreed
		// to one definition and a different one arrived.
		expect(() =>
			store.verifyAndConsume(key, details("doc-a").key, "v2"),
		).toThrow(/definition changed/);
		// The drift also consumed the approval rather than leaving it usable.
		expect(() =>
			store.verifyAndConsume(key, details("doc-a").key, "v1"),
		).toThrow(TypeError);
	});

	it("uses the side panel only", () => {
		expect(CONFIRMATION_SURFACE).toBe("side-panel");
	});

	it("binds args hash and rejects malformed key parts", () => {
		const good = details();
		expect(() =>
			new ApprovalStore().requestApproval(
				{ ...good, argsJson: canonicalizeArgs({ sku: "b" }) },
				true,
			),
		).toThrow(TypeError);
		expect(() => createHitlKey({ ...good.key, frameId: -1 })).toThrow(
			TypeError,
		);
		expect(() => createHitlKey({ ...good.key, documentId: "" })).toThrow(
			TypeError,
		);
		expect(() => createHitlKey({ ...good.key, argsHash: "abcd" })).toThrow(
			TypeError,
		);
	});

	it("uses an unambiguous key encoding", () => {
		const a = hitlKeyToString(
			createHitlKey({
				tabId: 1,
				documentId: "x",
				frameId: 0,
				toolName: "t",
				argsHash: hashArgs("a"),
			}),
		);
		const b = hitlKeyToString(
			createHitlKey({
				tabId: 1,
				documentId: "x|0|t",
				frameId: 0,
				toolName: "t",
				argsHash: hashArgs("a"),
			}),
		);
		expect(a).not.toBe(b);
	});
});
