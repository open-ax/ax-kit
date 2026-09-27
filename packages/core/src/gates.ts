// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { securityError } from "./errors.js";

/**
 * Precondition gates shared by the three methods. The draft states each gate;
 * a polyfill can only honor what the platform exposes, so every check below
 * is best-effort where the platform hides the signal (spec.md D13):
 *
 * - Fully active: a document with no window proxy has no browsing context.
 * - Origin-keyed: only `document.domain` drift is observable; the
 *   `Origin-Agent-Cluster` header is not. Anything else is assumed keyed.
 * - Allowed to use: when the Permissions Policy API is present it decides;
 *   otherwise the browser enforces denial and the polyfill assumes allowed.
 */

export function isFullyActive(doc: Document): boolean {
	return doc.defaultView !== null;
}

export function isOriginKeyed(doc: Document): boolean {
	const location = doc.location;
	if (location.protocol === "file:") {
		return true;
	}
	// Hostless documents (about:blank and friends) inherit their origin: with
	// no host to compare, drift is unobservable here. The top document that
	// can be checked still reports it.
	if (location.hostname === "") {
		return true;
	}
	try {
		if (doc.domain !== location.hostname) {
			return false;
		}
	} catch {
		return false;
	}
	return true;
}

export function originKeyedDiagnostic(doc: Document): string {
	return (
		`WebMCP is unavailable: the document at ${doc.location.href} is not ` +
		`origin-keyed (document.domain was modified or the response carries ` +
		`Origin-Agent-Cluster: ?0, possibly stripped by a proxy).`
	);
}

export function isAllowedToUse(doc: Document): boolean {
	try {
		const policy = (
			doc as unknown as {
				permissionsPolicy?: { allowsFeature?: unknown };
			}
		).permissionsPolicy;
		if (policy !== undefined && typeof policy.allowsFeature === "function") {
			return (
				(policy.allowsFeature as (feature: string) => unknown)("tools") !==
				false
			);
		}
	} catch {
		return false;
	}
	return true;
}

export function isPotentiallyTrustworthy(url: URL): boolean {
	switch (url.protocol) {
		case "https:":
		case "wss:":
		case "file:":
			return true;
		default:
			break;
	}
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") {
		return true;
	}
	if (/^127\./.test(host)) {
		return true;
	}
	if (host === "::1") {
		return true;
	}
	return false;
}

/**
 * Parse an origin allow-list (`exposedTo` or `fromOrigins`) into serialized
 * origins. Unparseable or non-trustworthy entries reject with `SecurityError`;
 * a non-list rejects with `TypeError`.
 */
export function parseOriginList(entries: unknown, kind: string): string[] {
	if (!Array.isArray(entries)) {
		throw new TypeError(`${kind} must be a list of origins`);
	}
	const origins: string[] = [];
	for (const entry of entries) {
		let parsed: URL;
		try {
			parsed = new URL(String(entry));
		} catch {
			throw securityError(`${kind} holds an unparseable origin`);
		}
		if (!isPotentiallyTrustworthy(parsed)) {
			throw securityError(`${kind} holds a non-trustworthy origin`);
		}
		origins.push(parsed.origin);
	}
	return origins;
}

export function warnDiagnostic(message: string): void {
	try {
		console.warn(message);
	} catch {
		// Diagnostics must never change control flow.
	}
}

/**
 * Structural `AbortSignal` check that also accepts cross-realm signals, where
 * `instanceof` fails.
 */
export function isAbortSignal(value: unknown): value is AbortSignal {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.aborted === "boolean" &&
		typeof candidate.addEventListener === "function" &&
		"reason" in candidate
	);
}
