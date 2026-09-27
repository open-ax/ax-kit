// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { isPotentiallyTrustworthy } from "./gates.js";
import { ensureState } from "./registry.js";
import type { ModelContext } from "./types.js";

/**
 * Define `document.modelContext` on one document. The surface stays inert
 * where the platform marks the context non-secure. The property is an own,
 * non-writable, non-configurable data property: hardening against naive
 * shadowing, not a browser-enforced boundary (spec.md D16). Native prototypes
 * are never touched; every document is installed explicitly, so no design
 * depends on script order (spec.md D14).
 */
export function installModelContext(doc: Document): ModelContext | undefined {
	const existing = (doc as unknown as Record<string, unknown>)["modelContext"];
	if (existing !== undefined) {
		return existing as ModelContext;
	}
	if (!isSecureContext(doc)) {
		return undefined;
	}
	const state = ensureState(doc);
	Object.defineProperty(doc, "modelContext", {
		value: state.context,
		writable: false,
		configurable: false,
		enumerable: true,
	});
	return state.context;
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
