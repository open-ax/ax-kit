// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Enumerated injection handlers for Main-world traffic.
 *
 * Everything here is ours, not draft-derived: the draft defines the
 * `document.modelContext` surface, while this map is the only shape the
 * service worker may inject. The platform serializes the function and drops
 * closures, so each handler is self-contained by construction and unknown
 * names are unreachable.
 */

import { canonicalizeArgs } from "./hitl.js";

export const HANDLER_NAMES = ["listTools", "getTool", "executeTool"] as const;

export type HandlerName = (typeof HANDLER_NAMES)[number];

const HANDLER_SET: ReadonlySet<string> = new Set<string>(HANDLER_NAMES);

export function isHandlerName(value: unknown): value is HandlerName {
	return typeof value === "string" && HANDLER_SET.has(value);
}

export function assertHandlerName(value: unknown): HandlerName {
	if (!isHandlerName(value)) {
		throw new TypeError("unknown handler");
	}
	return value;
}

export interface InjectionRequest {
	readonly handler: HandlerName;
	readonly args: unknown;
}

/**
 * Build one injection request. The handler must be enumerated and the args
 * must survive a JSON round-trip; anything else rejects with `TypeError`
 * before reaching the worker. Validation reuses the HITL canonicalizer so
 * both paths enforce one JSON rule (finite numbers, proto-guard, no
 * cycles, no functions).
 */
export function createInjectionRequest(
	handler: unknown,
	args: unknown,
): InjectionRequest {
	const name = assertHandlerName(handler);
	canonicalizeArgs(args);
	const roundTrip: unknown = JSON.parse(JSON.stringify(args)) as unknown;
	return { handler: name, args: roundTrip };
}

/**
 * The transport this package supports. There is exactly one value: a
 * request/response injection from the service worker whose result returns
 * directly to the calling extension context. No DOM event bus, no
 * page-visible channel, and no one-shot handshake event exist here.
 */
export const TRANSPORT_KIND = "injection-only" as const;

export type TransportKind = typeof TRANSPORT_KIND;
