// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Human-confirmation (HITL) key binding and approval store.
 *
 * Everything here is ours, not draft-derived: the draft annotates a tool
 * with `consequentialHint`, while this module decides where confirmation
 * renders and what it binds to. Confirmation renders in the side panel
 * only — never in page DOM — and an approval binds tab, document, frame,
 * tool name, and argument hash, with all five re-verified at execution.
 */

export interface HitlKey {
	readonly tabId: number;
	readonly documentId: string;
	readonly frameId: number;
	readonly toolName: string;
	readonly argsHash: string;
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function checkToolName(name: string): void {
	if (name.length < 1 || name.length > 128 || !TOOL_NAME_PATTERN.test(name)) {
		throw new TypeError("bad tool name");
	}
}

/**
 * Deterministic argument canonicalization: object keys sorted in code-unit
 * order, arrays kept in order, no live references retained.
 */
export function canonicalizeArgs(value: unknown): string {
	return canonicalizeValue(value, new Set());
}

function canonicalizeValue(value: unknown, seen: Set<object>): string {
	if (value === null) {
		return "null";
	}
	const kind: string = typeof value;
	if (kind === "string") {
		return JSON.stringify(value) as string;
	}
	if (kind === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("non-finite number");
		}
		return JSON.stringify(value) as string;
	}
	if (kind === "boolean") {
		return value === true ? "true" : "false";
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new TypeError("circular argument");
		}
		seen.add(value);
		try {
			const parts: string[] = [];
			for (const entry of value) {
				parts.push(canonicalizeValue(entry, seen));
			}
			return `[${parts.join(",")}]`;
		} finally {
			seen.delete(value);
		}
	}
	if (kind === "object") {
		const record = value as Record<string, unknown>;
		const proto: unknown = Object.getPrototypeOf(record);
		if (proto !== Object.prototype && proto !== null) {
			throw new TypeError("bad argument object");
		}
		if (seen.has(record)) {
			throw new TypeError("circular argument");
		}
		seen.add(record);
		try {
			const keys = Object.keys(record).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			);
			const parts: string[] = [];
			for (const key of keys) {
				if (
					key === "__proto__" ||
					key === "constructor" ||
					key === "prototype"
				) {
					throw new TypeError(`forbidden key: ${key}`);
				}
				parts.push(
					`${JSON.stringify(key) as string}:${canonicalizeValue(record[key] as unknown, seen)}`,
				);
			}
			return `{${parts.join(",")}}`;
		} finally {
			seen.delete(record);
		}
	}
	throw new TypeError("unserializable argument");
}

/** FNV-1a 32-bit over UTF-16 code units, hex-encoded. Pure and dependency-free. */
export function hashArgs(canonical: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < canonical.length; index += 1) {
		hash ^= canonical.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Build a HITL key from validated parts. Rejects malformed parts with `TypeError`. */
export function createHitlKey(parts: unknown): HitlKey {
	if (typeof parts !== "object" || parts === null) {
		throw new TypeError("bad approval key");
	}
	const record = parts as Record<string, unknown>;
	const { tabId, documentId, frameId, toolName, argsHash } = record;
	if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
		throw new TypeError("bad tabId");
	}
	if (typeof documentId !== "string" || documentId.length === 0) {
		throw new TypeError("bad documentId");
	}
	if (typeof frameId !== "number" || !Number.isInteger(frameId)) {
		throw new TypeError("bad frameId");
	}
	if (typeof toolName !== "string") {
		throw new TypeError("bad tool name");
	}
	checkToolName(toolName);
	if (typeof argsHash !== "string" || argsHash.length === 0) {
		throw new TypeError("bad argsHash");
	}
	return { tabId, documentId, frameId, toolName, argsHash };
}

/** Stable string form used as the store key. */
export function hitlKeyToString(key: HitlKey): string {
	return `${key.tabId}|${key.documentId}|${key.frameId}|${key.toolName}|${key.argsHash}`;
}

/** True only when all five parts match. */
export function hitlKeysEqual(first: HitlKey, second: HitlKey): boolean {
	return (
		first.tabId === second.tabId &&
		first.documentId === second.documentId &&
		first.frameId === second.frameId &&
		first.toolName === second.toolName &&
		first.argsHash === second.argsHash
	);
}

/** The only confirmation surface this package supports. */
export const CONFIRMATION_SURFACE = "side-panel" as const;

export type ConfirmationSurface = typeof CONFIRMATION_SURFACE;

export interface ApprovalDetails {
	readonly key: HitlKey;
	readonly toolName: string;
	readonly origin: string;
	readonly frameOrigin: string;
	readonly argsJson: string;
	readonly consequentialHint: boolean;
	readonly readOnlyHint: boolean;
	readonly definitionVersion: string;
}

export interface ApprovalActivity {
	readonly kind:
		| "requested"
		| "approved"
		| "rejected"
		| "consumed"
		| "invalidated";
	readonly key: string;
	readonly at: number;
}

function readDetails(value: unknown): ApprovalDetails {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("bad approval");
	}
	const record = value as Record<string, unknown>;
	const key = createHitlKey(record.key as unknown);
	const toolName = record.toolName;
	const origin = record.origin;
	const frameOrigin = record.frameOrigin;
	const argsJson = record.argsJson;
	const definitionVersion = record.definitionVersion;
	if (typeof toolName !== "string") {
		throw new TypeError("bad tool name");
	}
	checkToolName(toolName);
	if (typeof origin !== "string" || typeof frameOrigin !== "string") {
		throw new TypeError("bad origin");
	}
	if (typeof argsJson !== "string") {
		throw new TypeError("bad arguments");
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
	return {
		key,
		toolName,
		origin,
		frameOrigin,
		argsJson,
		consequentialHint,
		readOnlyHint,
		definitionVersion,
	};
}

/**
 * Approval state held outside any page lifetime so navigation cannot orphan
 * or replay an approval. Approvals are single-use: confirming then executing
 * consumes the entry, and consequential tools never carry a standing
 * approval. A definition change invalidates the pending entry, forcing a
 * re-rendered confirmation.
 */
export class ApprovalStore {
	private readonly pending = new Map<string, ApprovalDetails>();
	private readonly approved = new Set<string>();
	private readonly activity: ApprovalActivity[] = [];

	/** Pending entries keyed by stable string form. */
	pendingKeys(): string[] {
		return [...this.pending.keys()];
	}

	/** Recent activity, oldest first. Observable and interruptible by the holder. */
	activityLog(): ApprovalActivity[] {
		return [...this.activity];
	}

	private record(kind: ApprovalActivity["kind"], key: string): void {
		this.activity.push({ kind, key, at: Date.now() });
	}

	/**
	 * File a pending approval. Must be gesture-initiated: callers pass
	 * `gesture: true` from a user-action handler, otherwise this rejects.
	 * Replaces any earlier pending entry for the same key.
	 */
	requestApproval(details: unknown, gesture: unknown): string {
		if (gesture !== true) {
			throw new TypeError("approval requires a user gesture");
		}
		const parsed = readDetails(details);
		const key = hitlKeyToString(parsed.key);
		this.pending.set(key, parsed);
		this.approved.delete(key);
		this.record("requested", key);
		return key;
	}

	/** Confirm a pending approval. Leaves it approved until executed once. */
	approveApproval(key: unknown): void {
		if (typeof key !== "string") {
			throw new TypeError("bad approval key");
		}
		if (!this.pending.has(key)) {
			throw new TypeError("unknown approval");
		}
		this.approved.add(key);
		this.record("approved", key);
	}

	rejectApproval(key: unknown): void {
		if (typeof key !== "string") {
			throw new TypeError("bad approval key");
		}
		this.pending.delete(key);
		this.approved.delete(key);
		this.record("rejected", key);
	}

	/**
	 * Verify a pending approval against the live target immediately before
	 * execution. All five key parts plus the definition version must match;
	 * a version drift rejects so the UI re-renders the confirmation.
	 * Success consumes the approval: no replay without a fresh gesture.
	 */
	verifyAndConsume(
		key: unknown,
		liveKey: unknown,
		liveDefinitionVersion: unknown,
	): void {
		if (typeof key !== "string") {
			throw new TypeError("bad approval key");
		}
		const pending = this.pending.get(key);
		if (pending === undefined || !this.approved.has(key)) {
			throw new TypeError("approval not granted");
		}
		const live = createHitlKey(liveKey);
		if (!hitlKeysEqual(pending.key, live)) {
			this.pending.delete(key);
			this.approved.delete(key);
			this.record("invalidated", key);
			throw new TypeError("approval target changed");
		}
		if (
			typeof liveDefinitionVersion !== "string" ||
			liveDefinitionVersion !== pending.definitionVersion
		) {
			this.pending.delete(key);
			this.approved.delete(key);
			this.record("invalidated", key);
			throw new TypeError("tool definition changed");
		}
		this.pending.delete(key);
		this.approved.delete(key);
		this.record("consumed", key);
	}

	/** Navigation invalidates every pending entry for the old document. */
	invalidateDocument(documentId: unknown): void {
		if (typeof documentId !== "string") {
			throw new TypeError("bad documentId");
		}
		for (const [key, details] of this.pending) {
			if (details.key.documentId === documentId) {
				this.pending.delete(key);
				this.approved.delete(key);
				this.record("invalidated", key);
			}
		}
	}
}
