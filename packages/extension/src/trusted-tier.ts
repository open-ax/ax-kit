// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { assertToolName } from "./hitl.js";

/**
 * Trusted tier: the service worker as the single authorization point.
 *
 * Everything here is ours, not draft-derived: the draft defines the page
 * surface, while this module decides what executes. Main-world values
 * (names, descriptions, schemas, arguments, outputs, origins) arrive as
 * hostile input and are validated at the isolated boundary before any
 * worker decision. Registration and execution keep distinct signal
 * lifetimes, mirroring the core.
 */

export interface FrameToolView {
	readonly name: string;
	readonly origin: string;
	readonly frameOrigin: string;
	readonly description: string;
	readonly consequentialHint: boolean;
	readonly readOnlyHint: boolean;
	readonly definitionVersion: string;
	/**
	 * The argument names the page's own input schema declares.
	 *
	 * Arguments are minimised against this list rather than against whatever a
	 * caller sent, so a caller cannot introduce a key the page never asked for.
	 * A page with no declared properties declares none, and receives none.
	 */
	readonly declaredKeys: ReadonlyArray<string>;
}

function checkOrigin(origin: string): void {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new TypeError("bad origin");
	}
	if (parsed.origin === "null") {
		throw new TypeError("opaque origin");
	}
}

/** Validate one Main-world tool listing at the isolated boundary. */
export function validateFrameTool(value: unknown): FrameToolView {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("bad tool");
	}
	const record = value as Record<string, unknown>;
	const { name, origin, frameOrigin, description, definitionVersion } = record;
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	assertToolName(name);
	if (typeof origin !== "string" || typeof frameOrigin !== "string") {
		throw new TypeError("bad origin");
	}
	checkOrigin(origin);
	checkOrigin(frameOrigin);
	if (typeof description !== "string" || description.length === 0) {
		throw new TypeError("bad description");
	}
	if (typeof definitionVersion !== "string" || definitionVersion === "") {
		throw new TypeError("bad definition version");
	}
	const consequentialHint = record.consequentialHint;
	const readOnlyHint = record.readOnlyHint;
	if (
		typeof consequentialHint !== "boolean" ||
		typeof readOnlyHint !== "boolean"
	) {
		throw new TypeError("bad annotations");
	}
	// The keys the page declares it accepts. Arguments are minimised against
	// these, so they are validated at the boundary like every other field:
	// a malformed list is a malformed listing, not an empty one, because
	// treating it as empty would silently drop every argument.
	const declaredKeys = record.declaredKeys;
	if (!Array.isArray(declaredKeys)) {
		throw new TypeError("bad declared keys");
	}
	for (const key of declaredKeys) {
		if (typeof key !== "string" || key.length === 0) {
			throw new TypeError("bad declared keys");
		}
	}
	return {
		name,
		origin,
		frameOrigin,
		description,
		consequentialHint,
		readOnlyHint,
		definitionVersion,
		declaredKeys: [...declaredKeys] as string[],
	};
}

/**
 * Mirror exposure semantics: a tool is visible to the caller only when the
 * caller origin equals the owner or is explicitly allowed. Same shape the
 * core enforces, re-checked here so the worker never trusts a page claim.
 */
export function isExposedToCaller(
	ownerOrigin: string,
	allowedOrigins: ReadonlyArray<string>,
	callerOrigin: string,
): boolean {
	checkOrigin(ownerOrigin);
	checkOrigin(callerOrigin);
	for (const entry of allowedOrigins) {
		if (typeof entry !== "string") {
			throw new TypeError("bad allow-list");
		}
		checkOrigin(entry);
	}
	if (ownerOrigin === callerOrigin) {
		return true;
	}
	return allowedOrigins.includes(callerOrigin);
}

/**
 * Caller-controlled argument allow-list with data minimization: only keys
 * the caller explicitly allows cross into the invocation; anything else is
 * dropped rather than forwarded. Returns the minimized record directly.
 */
export function applyArgAllowList(
	args: unknown,
	allowedKeys: unknown,
): Record<string, unknown> {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new TypeError("bad arguments");
	}
	if (!Array.isArray(allowedKeys)) {
		throw new TypeError("bad allow-list");
	}
	const allowed = new Set<string>();
	for (const key of allowedKeys) {
		if (
			typeof key !== "string" ||
			key.length === 0 ||
			key === "__proto__" ||
			key === "constructor" ||
			key === "prototype"
		) {
			throw new TypeError("bad allow-list");
		}
		allowed.add(key);
	}
	const source = args as Record<string, unknown>;
	const minimized: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	for (const key of allowed) {
		if (Object.hasOwn(source, key)) {
			const value: unknown = source[key];
			if (value === undefined) {
				continue;
			}
			minimized[key] = value;
		}
	}
	return minimized;
}

/** Local trail disclaimer: page-unreachable does not mean tamper-proof. */
export const AUDIT_TRAIL_DISCLAIMER =
	"Local log only: held outside page reach with no integrity guarantee until shipped off-machine." as const;

export interface AuditEntry {
	readonly key: string;
	readonly toolName: string;
	readonly origin: string;
	/**
	 * `requested` is recorded when a confirmation is first raised. Without it
	 * the trail shows only outcomes, and an approval that was asked for and then
	 * dropped — the tab closed, the call abandoned — leaves no trace at all.
	 */
	readonly decision: "requested" | "approved" | "rejected" | "executed";
	readonly at: number;
}

/**
 * Worker-held audit trail. Entries are written by the service worker into
 * storage the page cannot reach; page-realm records are never presented
 * as tamper-proof.
 */
export class WorkerAuditTrail {
	private readonly entries: AuditEntry[] = [];

	append(entry: unknown): void {
		if (typeof entry !== "object" || entry === null) {
			throw new TypeError("bad audit entry");
		}
		const record = entry as Record<string, unknown>;
		if (
			typeof record.key !== "string" ||
			typeof record.toolName !== "string" ||
			typeof record.origin !== "string"
		) {
			throw new TypeError("bad audit entry");
		}
		if (
			record.decision !== "requested" &&
			record.decision !== "approved" &&
			record.decision !== "rejected" &&
			record.decision !== "executed"
		) {
			throw new TypeError("bad audit decision");
		}
		this.entries.push({
			key: record.key,
			toolName: record.toolName,
			origin: record.origin,
			decision: record.decision,
			at: Date.now(),
		});
		if (this.entries.length > 1000) {
			this.entries.splice(0, this.entries.length - 1000);
		}
	}

	list(): AuditEntry[] {
		return [...this.entries];
	}
}
