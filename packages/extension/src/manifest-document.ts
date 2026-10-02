// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The emitted Manifest V3 document.
 *
 * Everything here is ours, not the draft's: the draft defines no manifest.
 * Posture comes from `defaultManifestPosture()` rather than being retyped, so
 * the emitted file and the posture assertions cannot describe two different
 * intentions. The emitted document is what the posture assertions are run
 * against — a hand-written equivalent would test a fiction.
 */

import { assertManifestPosture, defaultManifestPosture } from "./manifest.js";

export interface ManifestDocument {
	readonly manifest_version: 3;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly incognito: "not_allowed";
	readonly background: {
		readonly service_worker: string;
		readonly type: "module";
	};
	readonly host_permissions: ReadonlyArray<string>;
	readonly permissions: ReadonlyArray<string>;
	readonly content_security_policy: {
		readonly extension_pages: string;
	};
	readonly externally_connectable: {
		readonly ids: ReadonlyArray<string>;
		readonly matches: ReadonlyArray<string>;
	};
	readonly action: {
		readonly default_title: string;
	};
	readonly side_panel: {
		readonly default_path: string;
	};
	readonly minimum_chrome_version: string;
}

/**
 * Build the manifest from a posture. `assertManifestPosture` runs first, so an
 * unknown or hostile posture rejects here rather than producing a file that
 * claims a posture it does not hold.
 *
 * The posture arrives as `unknown` for the same reason `assertManifestPosture`
 * takes one: it is validated from scratch at this boundary, so the parameter
 * type must not claim a caller already guaranteed what validation exists to
 * check.
 */
export function createManifestDocument(
	posture: unknown,
	name: string,
	version: string,
	description: string,
): ManifestDocument {
	const held = assertManifestPosture(posture);
	if (held.backgroundKind !== "service-worker") {
		// The emitted document is service-worker only. An event-page posture has
		// no place in this build, and silently shipping one would claim a
		// lifecycle the bundle does not have.
		throw new TypeError("emitted manifest requires a service worker");
	}
	return {
		manifest_version: 3,
		name,
		version,
		description,
		incognito: held.incognito,
		background: { service_worker: "sw.js", type: "module" },
		// The only permissions the bridge needs: script injection into Main
		// world, and the side panel the confirmation renders in.
		host_permissions: [...held.hostMatches],
		permissions: ["scripting", "sidePanel", "tabs", "storage"],
		content_security_policy: {
			extension_pages: "script-src 'self'; object-src 'self'",
		},
		externally_connectable: {
			ids: [...held.externallyConnectable.ids],
			matches: [...held.externallyConnectable.matches],
		},
		action: { default_title: "ax-kit" },
		side_panel: { default_path: "panel.html" },
		minimum_chrome_version: "116",
	};
}

/** The manifest this package ships, at its default posture. */
export function defaultManifestDocument(): ManifestDocument {
	return createManifestDocument(
		defaultManifestPosture(),
		"ax-kit",
		"0.0.0",
		"Trusted-tier bridge for document.modelContext.",
	);
}
