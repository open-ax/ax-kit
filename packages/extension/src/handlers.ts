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

function isJsonSerializable(value: unknown, seen: Set<object>): void {
	if (value === null) {
		return;
	}
	const kind: string = typeof value;
	if (kind === "string" || kind === "boolean") {
		return;
	}
	if (kind === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("non-finite number");
		}
		return;
	}
	if (kind === "undefined") {
		throw new TypeError("unserializable argument");
	}
	if (kind === "function" || kind === "symbol" || kind === "bigint") {
		throw new TypeError("unserializable argument");
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new TypeError("circular argument");
		}
		seen.add(value);
		try {
			for (const entry of value) {
				isJsonSerializable(entry, seen);
			}
		} finally {
			seen.delete(value);
		}
		return;
	}
	if (kind === "object") {
		const record = value as Record<string, unknown>;
		const proto: unknown = Object.getPrototypeOf(record);
		if (proto !== Object.prototype && proto !== null) {
			throw new TypeError("unserializable argument");
		}
		if (seen.has(record)) {
			throw new TypeError("circular argument");
		}
		seen.add(record);
		try {
			for (const key of Object.keys(record)) {
				if (
					key === "__proto__" ||
					key === "constructor" ||
					key === "prototype"
				) {
					throw new TypeError(`forbidden key: ${key}`);
				}
				isJsonSerializable(record[key] as unknown, seen);
			}
		} finally {
			seen.delete(record);
		}
		return;
	}
	throw new TypeError("unserializable argument");
}

/**
 * Build one injection request. The handler must be enumerated and the args
 * must survive a JSON round-trip; anything else rejects with `TypeError`
 * before reaching the worker.
 */
export function createInjectionRequest(
	handler: unknown,
	args: unknown,
): InjectionRequest {
	const name = assertHandlerName(handler);
	isJsonSerializable(args, new Set());
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
