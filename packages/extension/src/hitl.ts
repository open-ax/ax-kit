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

export function assertToolName(name: unknown): void {
	if (typeof name !== "string") {
		throw new TypeError("bad tool name");
	}
	checkToolName(name);
}

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

/** SHA-256 over UTF-8 bytes, hex-encoded. Pure and dependency-free. */
export function hashArgs(canonical: string): string {
	const bytes = encodeUtf8(canonical);
	return sha256Hex(bytes);
}

function encodeUtf8(text: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		let code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i += 1;
			}
		}
		if (code < 0x80) {
			out.push(code);
		} else if (code < 0x800) {
			out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			out.push(
				0xe0 | (code >> 12),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
		} else {
			out.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
		}
	}
	return out;
}

function sha256Hex(bytes: number[]): string {
	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;
	const bitLen = bytes.length * 8;
	bytes.push(0x80);
	while (bytes.length % 64 !== 56) {
		bytes.push(0);
	}
	const hi = Math.floor(bitLen / 0x100000000);
	const lo = bitLen >>> 0;
	bytes.push(
		(hi >>> 24) & 0xff,
		(hi >>> 16) & 0xff,
		(hi >>> 8) & 0xff,
		hi & 0xff,
		(lo >>> 24) & 0xff,
		(lo >>> 16) & 0xff,
		(lo >>> 8) & 0xff,
		lo & 0xff,
	);
	const w = new Array<number>(64);
	for (let off = 0; off < bytes.length; off += 64) {
		for (let i = 0; i < 16; i += 1) {
			w[i] =
				((bytes[off + i * 4] ?? 0) << 24) |
				((bytes[off + i * 4 + 1] ?? 0) << 16) |
				((bytes[off + i * 4 + 2] ?? 0) << 8) |
				(bytes[off + i * 4 + 3] ?? 0);
		}
		for (let i = 16; i < 64; i += 1) {
			const s0 =
				(((w[i - 15] ?? 0) >>> 7) | ((w[i - 15] ?? 0) << 25)) ^
				(((w[i - 15] ?? 0) >>> 18) | ((w[i - 15] ?? 0) << 14)) ^
				((w[i - 15] ?? 0) >>> 3);
			const s1 =
				(((w[i - 2] ?? 0) >>> 17) | ((w[i - 2] ?? 0) << 15)) ^
				(((w[i - 2] ?? 0) >>> 19) | ((w[i - 2] ?? 0) << 13)) ^
				((w[i - 2] ?? 0) >>> 10);
			w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i += 1) {
			const s1 =
				((e >>> 6) | (e << 26)) ^
				((e >>> 11) | (e << 21)) ^
				((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + s1 + ch + (k[i] ?? 0) + (w[i] ?? 0)) | 0;
			const s0 =
				((a >>> 2) | (a << 30)) ^
				((a >>> 13) | (a << 19)) ^
				((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + maj) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
		h5 = (h5 + f) | 0;
		h6 = (h6 + g) | 0;
		h7 = (h7 + h) | 0;
	}
	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((part) => (part >>> 0).toString(16).padStart(8, "0"))
		.join("");
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
	if (
		typeof documentId !== "string" ||
		documentId.length === 0 ||
		documentId.length > 512
	) {
		throw new TypeError("bad documentId");
	}
	if (
		typeof frameId !== "number" ||
		!Number.isInteger(frameId) ||
		frameId < 0
	) {
		throw new TypeError("bad frameId");
	}
	if (typeof toolName !== "string") {
		throw new TypeError("bad tool name");
	}
	checkToolName(toolName);
	if (typeof argsHash !== "string" || !/^[0-9a-f]{64}$/.test(argsHash)) {
		throw new TypeError("bad argsHash");
	}
	return { tabId, documentId, frameId, toolName, argsHash };
}

/** Stable string form used as the store key. JSON array: unambiguous. */
export function hitlKeyToString(key: HitlKey): string {
	return JSON.stringify([
		key.tabId,
		key.documentId,
		key.frameId,
		key.toolName,
		key.argsHash,
	]);
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
	/**
	 * The text a person is shown. It is carried on the approval rather than read
	 * back from elsewhere so that what is rendered and what was decided on are
	 * the same value, and so a definition change to it is caught by the version.
	 */
	readonly description: string;
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
	const description = record.description;
	const origin = record.origin;
	const frameOrigin = record.frameOrigin;
	const argsJson = record.argsJson;
	const definitionVersion = record.definitionVersion;
	if (typeof toolName !== "string") {
		throw new TypeError("bad tool name");
	}
	checkToolName(toolName);
	if (key.toolName !== toolName) {
		throw new TypeError("approval tool mismatch");
	}
	if (typeof description !== "string" || description.length === 0) {
		throw new TypeError("bad description");
	}
	if (typeof origin !== "string" || typeof frameOrigin !== "string") {
		throw new TypeError("bad origin");
	}
	if (typeof argsJson !== "string") {
		throw new TypeError("bad arguments");
	}
	if (hashArgs(argsJson) !== key.argsHash) {
		throw new TypeError("approval args mismatch");
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
		description,
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

	/**
	 * Bindings of pending approvals naming the same target as `target`.
	 *
	 * A target is tab, document, frame, and tool. The arguments hash is not part
	 * of it: two pending approvals for one target means a person was asked about
	 * this tool and a different invocation of it arrived, which is a moved target
	 * rather than a second question worth asking.
	 *
	 * Answered from the structured keys the store already holds, and validated
	 * through `createHitlKey` so a malformed target is refused rather than matched
	 * against nothing. A caller comparing the serialised form would have to parse
	 * a binding back into parts to ask this, and a parse that failed would answer
	 * "no other approval" — the one answer that lets a consequential call through
	 * with the check silently not run.
	 */
	pendingBindingsFor(target: unknown): string[] {
		const wanted = createHitlKey(target);
		const found: string[] = [];
		for (const [binding, details] of this.pending) {
			const candidate = details.key;
			if (
				candidate.tabId === wanted.tabId &&
				candidate.documentId === wanted.documentId &&
				candidate.frameId === wanted.frameId &&
				candidate.toolName === wanted.toolName
			) {
				found.push(binding);
			}
		}
		return found;
	}

	/** The definition version a pending entry was filed with, if still pending. */
	pendingDefinitionVersion(key: unknown): string | undefined {
		if (typeof key !== "string") {
			throw new TypeError("bad approval key");
		}
		return this.pending.get(key)?.definitionVersion;
	}

	/** Recent activity, oldest first. Observable and interruptible by the holder. */
	activityLog(): ApprovalActivity[] {
		return [...this.activity];
	}

	private record(kind: ApprovalActivity["kind"], key: string): void {
		this.activity.push({ kind, key, at: Date.now() });
		if (this.activity.length > 500) {
			this.activity.splice(0, this.activity.length - 500);
		}
	}

	/**
	 * File a pending approval. Replaces any earlier pending entry for the same
	 * key.
	 *
	 * Filing is not authorisation: it raises a question in the panel and grants
	 * nothing, so there is no gesture to assert here and a flag saying otherwise
	 * would only be something the one caller fills in for itself. The answer is
	 * `approveApproval`, which is bound to this key and reachable only from the
	 * panel's own click.
	 */
	requestApproval(details: unknown): string {
		const parsed = readDetails(details);
		const key = hitlKeyToString(parsed.key);
		this.pending.set(key, parsed);
		this.approved.delete(key);
		this.record("requested", key);
		return key;
	}

	/**
	 * True when a person has answered this exact invocation.
	 *
	 * Distinct from being pending: an entry waiting in the panel has been asked
	 * about, not answered, and treating the two as the same would consume an
	 * approval nobody gave.
	 */
	isApproved(key: unknown): boolean {
		if (typeof key !== "string") {
			throw new TypeError("bad approval key");
		}
		return this.approved.has(key);
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
		this.dropPending((key) => key.documentId === documentId);
	}

	/**
	 * Navigation invalidates every pending entry for a tab.
	 *
	 * Keyed on the tab rather than on the document identifier because the tab
	 * is the part the browser reports and this store cannot be asked to trust a
	 * caller-supplied identifier to decide what it should discard.
	 */
	invalidateTab(tabId: unknown): void {
		if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
			throw new TypeError("bad tabId");
		}
		this.dropPending((key) => key.tabId === tabId);
	}

	private dropPending(matches: (key: HitlKey) => boolean): void {
		for (const [binding, details] of this.pending) {
			if (matches(details.key)) {
				this.pending.delete(binding);
				this.approved.delete(binding);
				this.record("invalidated", binding);
			}
		}
	}
}
