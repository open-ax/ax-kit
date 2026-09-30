// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { assertHandlerName } from "./handlers.js";
import type { HitlKey } from "./hitl.js";
import { hitlKeyToString } from "./hitl.js";
import { assertLiveContext } from "./manifest.js";

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
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function checkName(name: string): void {
	if (name.length < 1 || name.length > 128 || !TOOL_NAME_PATTERN.test(name)) {
		throw new TypeError("bad tool name");
	}
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
	checkName(name);
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
	return {
		name,
		origin,
		frameOrigin,
		description,
		consequentialHint,
		readOnlyHint,
		definitionVersion,
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

export interface AllowListDecision {
	readonly allowed: boolean;
	readonly minimizedArgs: Record<string, unknown>;
}

/**
 * Caller-controlled argument allow-list with data minimization: only keys
 * the caller explicitly allows cross into the invocation; anything else is
 * dropped rather than forwarded.
 */
export function applyArgAllowList(
	args: unknown,
	allowedKeys: unknown,
): AllowListDecision {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new TypeError("bad arguments");
	}
	if (!Array.isArray(allowedKeys)) {
		throw new TypeError("bad allow-list");
	}
	const allowed = new Set<string>();
	for (const key of allowedKeys) {
		if (typeof key !== "string" || key.length === 0) {
			throw new TypeError("bad allow-list");
		}
		allowed.add(key);
	}
	const source = args as Record<string, unknown>;
	const minimized: Record<string, unknown> = {};
	for (const key of allowed) {
		if (Object.hasOwn(source, key)) {
			minimized[key] = source[key] as unknown;
		}
	}
	return { allowed: true, minimizedArgs: minimized };
}

/** Local trail disclaimer: page-unreachable does not mean tamper-proof. */
export const AUDIT_TRAIL_DISCLAIMER =
	"Local log only: held outside page reach with no integrity guarantee until shipped off-machine." as const;

export interface AuditEntry {
	readonly key: string;
	readonly toolName: string;
	readonly origin: string;
	readonly decision: "approved" | "rejected" | "executed";
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
	}

	list(): AuditEntry[] {
		return [...this.entries];
	}
}

export interface AuthorizationInput {
	readonly handler: unknown;
	readonly contextLive: unknown;
	readonly key: HitlKey;
	readonly approvedKey: string;
	readonly callerOrigin: string;
	readonly allowedOrigins: ReadonlyArray<string>;
}

/**
 * Single authorization point. Validates the handler name, the context
 * liveness, the HITL binding, and the exposure gate before execution.
 */
export function authorizeExecution(input: AuthorizationInput): string {
	assertHandlerName(input.handler);
	assertLiveContext(input.contextLive);
	if (hitlKeyToString(input.key) !== input.approvedKey) {
		throw new TypeError("approval target changed");
	}
	if (
		!isExposedToCaller(
			input.callerOrigin,
			input.allowedOrigins,
			input.callerOrigin,
		)
	) {
		throw new TypeError("tool not exposed");
	}
	return input.approvedKey;
}
