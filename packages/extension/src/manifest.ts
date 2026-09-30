// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Extension manifest posture and lifecycle discipline.
 *
 * Everything here is ours, not draft-derived: the draft defines no manifest.
 * Defaults below are fail-closed and every broad scope carries a review
 * note explaining why it was requested.
 */

export interface ExternallyConnectable {
	readonly ids: ReadonlyArray<string>;
	readonly matches: ReadonlyArray<string>;
}

export interface ManifestPosture {
	readonly incognito: "not_allowed";
	readonly externallyConnectable: ExternallyConnectable;
	readonly hostMatches: ReadonlyArray<string>;
	readonly allFrames: boolean;
	readonly hostScopeJustification: string;
	readonly backgroundKind: "service-worker" | "event-page";
}

/**
 * Chrome-first defaults: external connections denied unless an explicit
 * identifier and match allow them, private browsing closed, broad host scope
 * flagged with a justification for review.
 */
export function defaultManifestPosture(): ManifestPosture {
	return {
		incognito: "not_allowed",
		externallyConnectable: { ids: [], matches: [] },
		hostMatches: ["<all_urls>"],
		allFrames: true,
		hostScopeJustification:
			"Broad host plus all-frames scope is both the largest permission " +
			"liability and the largest injection exposure; requested deliberately " +
			"and justified at review, never inherited.",
		backgroundKind: "service-worker",
	};
}

/** Firefox target: non-persistent background page, verified separately. */
export function firefoxManifestPosture(): ManifestPosture {
	const base = defaultManifestPosture();
	return { ...base, backgroundKind: "event-page" };
}

export function assertManifestPosture(value: unknown): ManifestPosture {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("bad manifest posture");
	}
	const record = value as Record<string, unknown>;
	if (record.incognito !== "not_allowed") {
		throw new TypeError("private browsing must stay closed");
	}
	const ext = record.externallyConnectable;
	if (typeof ext !== "object" || ext === null) {
		throw new TypeError("bad external connection gate");
	}
	const extRecord = ext as Record<string, unknown>;
	if (!Array.isArray(extRecord.ids) || !Array.isArray(extRecord.matches)) {
		throw new TypeError("bad external connection gate");
	}
	for (const entry of [...extRecord.ids, ...extRecord.matches]) {
		if (typeof entry !== "string") {
			throw new TypeError("bad external connection gate");
		}
	}
	if (!Array.isArray(record.hostMatches)) {
		throw new TypeError("bad host scope");
	}
	for (const entry of record.hostMatches as unknown[]) {
		if (typeof entry !== "string") {
			throw new TypeError("bad host scope");
		}
	}
	if (typeof record.allFrames !== "boolean") {
		throw new TypeError("bad frame scope");
	}
	if (
		typeof record.hostScopeJustification !== "string" ||
		record.hostScopeJustification.length === 0
	) {
		throw new TypeError("host scope needs a review justification");
	}
	if (
		record.backgroundKind !== "service-worker" &&
		record.backgroundKind !== "event-page"
	) {
		throw new TypeError("bad background kind");
	}
	const extGate = ext as Record<string, unknown>;
	return {
		incognito: "not_allowed",
		externallyConnectable: {
			ids: [...(extGate.ids as string[])],
			matches: [...(extGate.matches as string[])],
		},
		hostMatches: [...(record.hostMatches as string[])],
		allFrames: record.allFrames as boolean,
		hostScopeJustification: record.hostScopeJustification as string,
		backgroundKind: record.backgroundKind as "service-worker" | "event-page",
	};
}

/**
 * Orphan discipline: content contexts that outlive a reload or update must
 * never approve or execute. Callers pass the live-valid flag; a stale
 * context rejects here, failing closed.
 */
export function assertLiveContext(isLive: unknown): void {
	if (isLive !== true) {
		throw new TypeError("stale extension context");
	}
}
