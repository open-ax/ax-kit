// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { isAllowedToUse, isPotentiallyTrustworthy } from "./gates.js";
import { ensureState, handleDocumentUnload } from "./registry.js";
import type { ModelContext } from "./types.js";

/**
 * Define `document.modelContext` on one document. The surface stays inert
 * where the platform marks the context non-secure. The property is an own,
 * non-writable, non-configurable data property: hardening against naive
 * shadowing, not a browser-enforced boundary. Native prototypes are never
 * touched, and every document is installed explicitly, so no design depends
 * on script order: any later-obtained reference wins.
 */
export function installModelContext(doc: Document): ModelContext | undefined {
	const existing = (doc as unknown as Record<string, unknown>).modelContext;
	if (existing !== undefined) {
		return existing as ModelContext;
	}
	if (!isSecureContext(doc)) {
		return undefined;
	}
	if (!isAllowedToUse(doc)) {
		return undefined;
	}
	const state = ensureState(doc);
	Object.defineProperty(doc, "modelContext", {
		value: state.context,
		writable: false,
		configurable: false,
		enumerable: true,
	});
	watchUnload(doc);
	return state.context;
}

function watchUnload(doc: Document): void {
	const view = doc.defaultView;
	if (view === null) {
		return;
	}
	view.addEventListener("pagehide", (event) => {
		if (
			typeof PageTransitionEvent !== "undefined" &&
			event instanceof PageTransitionEvent &&
			event.persisted
		) {
			return;
		}
		handleDocumentUnload(doc);
	});
}

function isSecureContext(doc: Document): boolean {
	const view = doc.defaultView;
	const flag: unknown = view === null ? undefined : view.isSecureContext;
	if (typeof flag === "boolean") {
		return flag;
	}
	try {
		const url = new URL(doc.location.href);
		// An about:blank document inherits its creator's context; the caller
		// able to hand us that document already runs in this agent.
		if (url.protocol === "about:") {
			return true;
		}
		return isPotentiallyTrustworthy(url);
	} catch {
		return false;
	}
}
