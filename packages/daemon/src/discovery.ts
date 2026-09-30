// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Local transport: an ephemeral loopback port plus a discovery file and a
 * bearer checked on upgrade. No well-known contended port is assumed; the
 * page itself never listens.
 */

export interface DiscoveryFile {
	readonly port: number;
	readonly pid: number;
	readonly token: string;
	readonly version: string;
}

export function discoveryFileName(): string {
	return "relay.json";
}

export function resolveDiscoveryDir(env: unknown): string {
	if (typeof env !== "object" || env === null) {
		throw new TypeError("bad env");
	}
	const record = env as Record<string, unknown>;
	const runtime = record.XDG_RUNTIME_DIR;
	if (typeof runtime === "string" && runtime.length > 0) {
		return `${runtime}/ax`;
	}
	const home = record.HOME;
	if (typeof home === "string" && home.length > 0) {
		return `${home}/.ax`;
	}
	throw new TypeError("no discovery directory");
}

export function createDiscoveryFile(parts: unknown): DiscoveryFile {
	if (typeof parts !== "object" || parts === null) {
		throw new TypeError("bad discovery file");
	}
	const record = parts as Record<string, unknown>;
	if (
		typeof record.port !== "number" ||
		!Number.isInteger(record.port) ||
		record.port <= 0 ||
		record.port > 65535
	) {
		throw new TypeError("bad port");
	}
	if (
		typeof record.pid !== "number" ||
		!Number.isInteger(record.pid) ||
		record.pid <= 0
	) {
		throw new TypeError("bad pid");
	}
	if (typeof record.token !== "string" || record.token.length < 16) {
		throw new TypeError("bad token");
	}
	if (typeof record.version !== "string" || record.version.length === 0) {
		throw new TypeError("bad version");
	}
	return {
		port: record.port,
		pid: record.pid,
		token: record.token,
		version: record.version,
	};
}

export function serializeDiscoveryFile(file: DiscoveryFile): string {
	return JSON.stringify(file);
}

export function parseDiscoveryFile(text: unknown): DiscoveryFile {
	if (typeof text !== "string") {
		throw new TypeError("bad discovery file");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw new TypeError("unparsable discovery file");
	}
	return createDiscoveryFile(parsed);
}

/**
 * Bearer gate for the local upgrade plus explicit loopback bind with origin
 * validation. The extension dials out; the daemon dials in.
 */
export function isLoopbackHost(host: unknown): boolean {
	if (typeof host !== "string") {
		return false;
	}
	const lower = host.toLowerCase();
	if (lower === "127.0.0.1" || lower === "localhost" || lower === "::1") {
		return true;
	}
	if (lower === "[::1]") {
		return true;
	}
	const parts = lower.split(".");
	return (
		parts.length === 4 &&
		parts[0] === "127" &&
		parts
			.slice(1)
			.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
}

export function checkBearer(presented: unknown, expected: unknown): void {
	if (typeof presented !== "string" || typeof expected !== "string") {
		throw new TypeError("bad bearer");
	}
	if (presented.length === 0 || presented !== expected) {
		throw new TypeError("bad bearer");
	}
}

export function checkUpgradeOrigin(origin: unknown): void {
	if (typeof origin !== "string") {
		throw new TypeError("bad origin");
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new TypeError("bad origin");
	}
	if (!isLoopbackHost(parsed.hostname)) {
		throw new TypeError("non-loopback origin");
	}
}
