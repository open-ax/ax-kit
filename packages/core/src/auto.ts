// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-installing entry point. Importing this module installs the tool surface
 * against the ambient document; importing it twice does nothing the second time.
 *
 * It exists for the one place a polyfill belongs in a server-rendered
 * application: the framework's client entry hook, which runs before hydration
 * precisely so that something can be installed into the page. The alternative
 * is marking every component client-side so the import executes in a browser,
 * which throws away server rendering — and a reference implementation gets
 * copied.
 *
 * ## Why a separate entry point
 *
 * Not because of any marker on the surface, but because of bytes. The root
 * entry is measured against a hard 5 kB gzip budget with very little headroom.
 * An auto-installer is small, and small is not free: putting it in the root
 * entry spends budget the conformance work needs. It is also measured in its
 * own right rather than hiding inside the root's number, because `size-limit`
 * reads one artifact file per budget.
 *
 * ## What it does when there is no document
 *
 * Nothing. An application that renders on a server evaluates this module there
 * too, and a `ReferenceError` at import time would make the application
 * unrenderable. Absence of a document is the normal case on a server, so it is
 * not an error.
 *
 * ## What it does when the platform already has the surface
 *
 * Stands down. A native `document.modelContext` is left exactly as it is. A
 * polyfill that overwrites a native implementation is worse than one that does
 * not, because it makes the platform look broken.
 */

import { installModelContext } from "./install.js";
import type { ModelContext } from "./types.js";

/**
 * Install the tool surface against the ambient document.
 *
 * Safe to call anywhere, any number of times, and safe to import in an
 * environment with no DOM. Where the platform already provides
 * `document.modelContext`, or where this module has already installed it, the
 * existing surface is preserved and returned.
 *
 * A refusal — an insecure context, or a denied `tools` Permissions Policy
 * feature — is reported as `undefined` rather than thrown. This is a
 * side-effecting import, and an import that throws takes the importing
 * application down with it. Both refusals stay observable afterwards through
 * the draft's own error taxonomy, so an application that wants to report them
 * still can.
 */
export function autoInstallModelContext(): ModelContext | undefined {
	const doc = ambientDocument();
	if (doc === undefined) {
		return undefined;
	}
	// Stand down rather than replace. `installModelContext` re-installs over a
	// surface it did not create, because an idlharness-observed difference
	// between an own property and a prototype accessor makes replacing a native
	// implementation the wrong default. The check lives here rather than in
	// `install.ts` so that the root entry does not grow to carry it: an
	// explicit installer is a caller that has already decided, and only an
	// automatic one is guessing.
	if (
		(doc as unknown as Record<string, unknown>)["modelContext"] !== undefined
	) {
		return undefined;
	}
	try {
		return installModelContext(doc);
	} catch {
		// `installModelContext` is written not to throw for a document it
		// declines to serve. This is belt-and-braces against a future change
		// making it throw, because the failure mode of throwing from here is an
		// application that will not boot — far worse than a page with no tool
		// surface.
		return undefined;
	}
}

/**
 * The ambient document, or `undefined` when there is none.
 *
 * Read through `globalThis` rather than as a bare `document` identifier: a bare
 * reference is a `ReferenceError` in an environment that has no such binding,
 * and this import happens on a server.
 *
 * A real document is an object carrying a `location`. Checking for an object
 * alone would accept a `document` global that is a stub — a test double, or a
 * partial DOM implementation — and install against it, producing a surface
 * that silently does nothing. That failure is not reportable from inside
 * `installModelContext`, which has no way to tell the two apart.
 */
function ambientDocument(): Document | undefined {
	const candidate = (globalThis as unknown as Record<string, unknown>)[
		"document"
	];
	if (typeof candidate !== "object" || candidate === null) {
		return undefined;
	}
	if (typeof (candidate as { location?: unknown }).location !== "object") {
		return undefined;
	}
	return candidate as Document;
}

autoInstallModelContext();
