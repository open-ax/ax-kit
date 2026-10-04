// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { securityError } from "./errors.js";

/**
 * Precondition gates shared by the three methods. The draft states each gate;
 * a polyfill can only honor what the platform exposes, so every check below
 * is best-effort where the platform hides the signal:
 *
 * - Fully active: a document with no window proxy has no browsing context.
 * - Allowed to use: when the Permissions Policy API is present it decides;
 *   otherwise the browser enforces denial and the polyfill assumes allowed.
 */

export function isFullyActive(doc: Document): boolean {
	return doc.defaultView !== null;
}

export function isAllowedToUse(doc: Document): boolean {
	try {
		const policy = (
			doc as unknown as {
				permissionsPolicy?: {
					allowsFeature?: unknown;
					features?: unknown;
				};
			}
		).permissionsPolicy;
		if (policy !== undefined && typeof policy.allowsFeature === "function") {
			// allowsFeature reports false for an unknown feature as well as a
			// denied one. Only treat false as a denial when the feature list
			// names "tools"; otherwise the browser simply predates the draft.
			// allowedFeatures is unusable here: it also omits known denials.
			const known = policy.features;
			if (typeof known === "function") {
				try {
					const names = (known as () => unknown).call(policy);
					if (Array.isArray(names) && !names.includes("tools")) {
						return true;
					}
				} catch {
					// Fall through to allowsFeature below.
				}
			}
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
	if (
		url.protocol === "https:" ||
		url.protocol === "wss:" ||
		url.protocol === "file:"
	) {
		return true;
	}
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]" || host === "::1") {
		return true;
	}
	if (isLoopbackIPv4(host)) {
		return true;
	}
	return false;
}

function isLoopbackIPv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4 || parts[0] !== "127") {
		return false;
	}
	return parts
		.slice(1)
		.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Parse an origin allow-list (`exposedTo` or `fromOrigins`) into serialized
 * origins. Unparseable or non-trustworthy entries reject with `SecurityError`;
 * a non-list rejects with `TypeError`.
 */
export function parseOriginList(entries: unknown, kind: string): string[] {
	if (!Array.isArray(entries)) {
		throw new TypeError(`${kind}: bad origin list`);
	}
	const origins: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") {
			throw new TypeError(`${kind}: bad origin list`);
		}
		let parsed: URL;
		try {
			parsed = new URL(entry);
		} catch {
			throw securityError(`${kind}: unparseable origin`);
		}
		if (!isPotentiallyTrustworthy(parsed)) {
			throw securityError(`${kind}: untrustworthy origin`);
		}
		if (parsed.origin === "null") {
			throw securityError(`${kind}: opaque origin`);
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
