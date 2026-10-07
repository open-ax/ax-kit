/**
 * The polyfill's installation, as one shared promise.
 *
 * ## Why a promise and not an import in each component
 *
 * Installing means a dynamic `import()`, which resolves asynchronously. Two
 * components each doing that independently race: the first effect to run sees no
 * `document.modelContext` and concludes the feature is unavailable, while the
 * second one installs it moments later.
 *
 * That race is not theoretical and it cost a real debugging session here. The
 * built page reported "no tool surface" *while* `document.modelContext` existed
 * and returned an empty list — the polyfill had installed, and the component that
 * asked had simply asked too early.
 *
 * One memoized promise removes the race by construction: whoever asks first starts
 * the install, everyone else awaits the same result, and no caller has to decide
 * whether it is early.
 */

import type { ModelContext } from "@ax-kit/core";

let installing: Promise<ModelContext | undefined> | undefined;

/**
 * Install the polyfill if it is not already there, and resolve to the surface.
 *
 * Resolves `undefined` where there is no document, or where the platform refused
 * the surface — an insecure context, or a denied `tools` Permissions Policy
 * feature. Both are ordinary outcomes rather than failures, and a caller that
 * wants to distinguish them can read `document.modelContext` afterwards.
 *
 * Memoized. A second call after a successful install returns the same surface; a
 * second call after a refusal does not retry, because the gate that refused will
 * refuse again and a retry loop would be a way to hammer a decision the platform
 * has already made.
 */
export function ensurePolyfill(): Promise<ModelContext | undefined> {
	installing ??= install();
	return installing;
}

async function install(): Promise<ModelContext | undefined> {
	// Already there — either the platform provides it or something installed it
	// before this module was reached. Either way, leave it alone: a polyfill that
	// overwrites a native implementation makes the platform look broken.
	const existing = (document as unknown as { modelContext?: ModelContext })
		.modelContext;
	if (existing !== undefined) {
		return existing;
	}
	await import("@ax-kit/core/auto");
	return (document as unknown as { modelContext?: ModelContext }).modelContext;
}
