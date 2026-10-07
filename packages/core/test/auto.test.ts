// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// The auto-installing entry point, verified in a real browser and against the
// absence of a DOM. No sleeps: each assertion waits on an event or a promise.
//
// The no-document case cannot be exercised in a browser — every browser test
// has a document — so it is covered here in the fast layer with the ambient
// global temporarily removed. That is the case a server-rendered application
// hits, and it is the one that would take the application down.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoInstallModelContext } from "../src/auto.js";
import { installModelContext } from "../src/index.js";

const GLOBAL = globalThis as unknown as Record<string, unknown>;

/**
 * A fresh document to install into, and the descriptor needed to put the real
 * one back.
 *
 * Installing the real `document` twice is impossible: `modelContext` is defined
 * non-configurable, so the second attempt throws. Each case that needs its own
 * document therefore takes a detached one and restores the original afterwards.
 * The original's own descriptor is captured rather than assumed, because the
 * surface is only there if some earlier case in this file installed it.
 */
function freshDocument(): { doc: Document; restore: () => void } {
	const real = GLOBAL["document"] as Document | undefined;
	const realDescriptor =
		real === undefined
			? undefined
			: Object.getOwnPropertyDescriptor(real, "modelContext");
	const doc = document.implementation.createHTMLDocument("auto");
	return {
		doc,
		restore: () => {
			if (real === undefined) {
				return;
			}
			if (realDescriptor !== undefined) {
				Object.defineProperty(real, "modelContext", realDescriptor);
			} else {
				Reflect.deleteProperty(real, "modelContext");
			}
		},
	};
}

/**
 * Point the ambient global at a document for the duration of one case.
 *
 * `document` is read through `globalThis` by the entry point precisely so that
 * this is possible — and so that the real server-rendered case, where there is
 * no `document` at all, is the same code path rather than a special case.
 */
function withDocument(doc: Document): () => void {
	const real = GLOBAL["document"];
	GLOBAL["document"] = doc;
	return () => {
		GLOBAL["document"] = real;
	};
}

describe("autoInstallModelContext without a document", () => {
	let saved: unknown;
	let had: boolean;

	beforeEach(() => {
		had = "document" in GLOBAL;
		saved = GLOBAL["document"];
		delete GLOBAL["document"];
	});

	afterEach(() => {
		if (had) {
			GLOBAL["document"] = saved;
		} else {
			delete GLOBAL["document"];
		}
	});

	it("does not throw when there is no document", () => {
		// The failure this guards is a ReferenceError at import time in a
		// server-rendered application, which makes the application unrenderable
		// rather than merely lacking a tool surface.
		expect(autoInstallModelContext()).toBeUndefined();
	});

	it("does not throw when the document global is not a document", () => {
		// A test double or a partial DOM implementation still installs
		// successfully against a plain object, producing a surface that silently
		// does nothing. Refusing it is not observable from inside
		// installModelContext, so it is observable here instead.
		GLOBAL["document"] = {};
		expect(autoInstallModelContext()).toBeUndefined();

		GLOBAL["document"] = { location: undefined };
		expect(autoInstallModelContext()).toBeUndefined();

		GLOBAL["document"] = "not an object";
		expect(autoInstallModelContext()).toBeUndefined();
	});

	it("does not throw when the document has a location", () => {
		// A document-shaped object with a location is accepted as a document, so
		// this reaches installModelContext rather than the type guard. It must
		// still not throw out of an import-time call.
		GLOBAL["document"] = { location: { href: "https://example.test/" } };
		expect(() => autoInstallModelContext()).not.toThrow();
	});

	it("installs nothing into a document the secure-context gate refuses", () => {
		// happy-dom reports about:blank as inheriting a secure context, so the
		// refused case is reached with a document whose URL cannot be trusted. A
		// refusal must be reported, not thrown, because this runs at import time
		// in an application that has no way to catch it usefully.
		GLOBAL["document"] = {
			location: { href: "http://insecure.example.test/page" },
		};
		expect(autoInstallModelContext()).toBeUndefined();
	});
});

describe("autoInstallModelContext in a document", () => {
	it("installs the surface against the ambient document", () => {
		const { doc, restore } = freshDocument();
		const put = withDocument(doc);
		try {
			const context = autoInstallModelContext();
			expect(context).toBeDefined();
			expect((doc as unknown as Record<string, unknown>)["modelContext"]).toBe(
				context,
			);
		} finally {
			put();
			restore();
		}
	});

	it("is idempotent", () => {
		const { doc, restore } = freshDocument();
		const put = withDocument(doc);
		try {
			const first = autoInstallModelContext();
			expect(first).toBeDefined();
			// The second call stands down rather than replacing, so the surface a
			// caller already holds stays valid.
			expect(autoInstallModelContext()).toBeUndefined();
			expect((doc as unknown as Record<string, unknown>)["modelContext"]).toBe(
				first,
			);
		} finally {
			put();
			restore();
		}
	});

	it("preserves a surface installed explicitly", () => {
		const { doc, restore } = freshDocument();
		const put = withDocument(doc);
		try {
			const explicit = installModelContext(doc);
			expect(explicit).toBeDefined();
			expect(autoInstallModelContext()).toBeUndefined();
			expect((doc as unknown as Record<string, unknown>)["modelContext"]).toBe(
				explicit,
			);
		} finally {
			put();
			restore();
		}
	});

	it("preserves a native surface rather than replacing it", () => {
		// A native document.modelContext is what this polyfill stands in for, so
		// overwriting one is the failure this guards. It is the observable
		// counterpart of the own-property-versus-prototype-accessor difference
		// the conformance suite records as a known gap.
		const { doc, restore } = freshDocument();
		const holder = doc as unknown as Record<string, unknown>;
		Object.defineProperty(holder, "modelContext", {
			value: { native: true },
			writable: false,
			configurable: true,
			enumerable: true,
		});
		const put = withDocument(doc);
		try {
			expect(autoInstallModelContext()).toBeUndefined();
			expect((holder["modelContext"] as { native?: boolean }).native).toBe(
				true,
			);
		} finally {
			put();
			restore();
		}
	});

	it("installs into a detached document, whose surface then refuses work", async () => {
		// Installation succeeds — the secure-context gate passes for about:blank
		// — but a document with no browsing context is not fully active, so the
		// draft's own methods reject with InvalidStateError. That is the
		// specified behaviour and it is why the enumeration and invocation
		// assertions live in the browser layer, against a real document.
		//
		// Asserted here rather than passed over because it is the difference
		// between "installed" and "usable", and a reader of this entry point
		// deserves to know which one an import-time call can promise.
		const { doc, restore } = freshDocument();
		const put = withDocument(doc);
		try {
			const context = autoInstallModelContext();
			expect(context).toBeDefined();
			if (context === undefined) {
				return;
			}
			await expect(
				context.registerTool({
					name: "auto_probe",
					description: "installed by the auto-installing entry point",
					execute: async () => ({ ok: true }),
				}),
			).rejects.toThrowError(
				expect.objectContaining({ name: "InvalidStateError" }),
			);
		} finally {
			put();
			restore();
		}
	});
});
