// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Local transport: an ephemeral loopback port plus a discovery file and a
 * bearer checked on upgrade. No well-known contended port is assumed; the
 * page itself never listens.
 */

import { join } from "node:path";

export interface DiscoveryFile {
	readonly port: number;
	readonly pid: number;
	readonly token: string;
	readonly version: string;
}

export const DISCOVERY_FILE_NAME = "relay.json" as const;

/**
 * Where the discovery file lives, per platform.
 *
 * The directory is chosen by what the platform actually guarantees, not by
 * guessing a home directory. A directory that resolves on the developer's
 * machine and throws on the other platform is a bridge that only runs where it
 * was written, which is the same class of defect as the missing rendezvous this
 * whole layer exists to fix.
 *
 * The file carries a bearer, so it is written `0600` inside a directory only the
 * user can reach. `%LOCALAPPDATA%` is that place on Windows; `$XDG_RUNTIME_DIR`
 * is the documented answer on Linux; `~/.ax` is the portable last resort on a
 * platform that offers nothing better.
 *
 * The platform is a parameter rather than a global read so the branches can be
 * tested on the machine that is not them. A discovery path only ever exercised
 * on the platform it was written on is an untested path.
 */
export function resolveDiscoveryDir(
	env: unknown,
	onWarn?: (message: string) => void,
	platform: string = process.platform,
): string {
	if (typeof env !== "object" || env === null) {
		throw new TypeError("bad env");
	}
	const record = env as Record<string, unknown>;
	const read = (key: string): string | undefined => {
		const value = record[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	if (platform === "win32") {
		const local = read("LOCALAPPDATA");
		if (local !== undefined) {
			return join(local, "ax-kit");
		}
		const profile = read("USERPROFILE");
		if (profile !== undefined) {
			onWarn?.("LOCALAPPDATA unset, falling back to USERPROFILE/.ax-kit");
			return join(profile, ".ax-kit");
		}
		// `HOME` is checked last and only because a Windows shell that has been
		// through Git Bash or WSL will have it while a plain `cmd.exe` will not.
		const home = read("HOME");
		if (home !== undefined) {
			onWarn?.("LOCALAPPDATA unset, falling back to HOME/.ax-kit");
			return join(home, ".ax-kit");
		}
		throw new TypeError("no discovery directory");
	}
	const runtime = read("XDG_RUNTIME_DIR");
	if (runtime !== undefined) {
		return join(runtime, "ax");
	}
	const home = read("HOME");
	if (home !== undefined) {
		onWarn?.("XDG_RUNTIME_DIR unset, falling back to HOME/.ax");
		return join(home, ".ax");
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
	if (presented.length === 0 || presented.length !== expected.length) {
		throw new TypeError("bad bearer");
	}
	let diff = 0;
	for (let i = 0; i < expected.length; i += 1) {
		diff |= (presented.charCodeAt(i) ^ expected.charCodeAt(i)) & 0xffff;
	}
	if (diff !== 0) {
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
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError("non-loopback origin");
	}
	if (!isLoopbackHost(parsed.hostname)) {
		throw new TypeError("non-loopback origin");
	}
}

/**
 * An extension origin, with or without its trailing slash.
 *
 * Measured against a real browser: a `fetch` from an extension's service worker
 * presents `Origin: chrome-extension://<id>`, and the same browser passes
 * `chrome-extension://<id>/` to a native host. Both spellings are the same
 * origin, and a gate that accepts only one refuses a caller that is exactly
 * who it claims to be.
 */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/?$/;

/**
 * The origin gate for the relay endpoints.
 *
 * Three callers reach this listener and they arrive differently, so all three
 * are named here rather than one being waved through on the strength of
 * another:
 *
 * - a local MCP client, which sends a loopback `http:`/`https:` origin;
 * - the extension's service worker, which sends `chrome-extension://<id>` on
 *   some paths and sends **no `Origin` header at all** on the relay fetch;
 * - a web page, which always sends its own.
 *
 * The middle case is the one that was measured wrong. An extension holding host
 * permissions makes a privileged fetch, which the browser exempts from CORS: no
 * preflight accompanies it and no `Origin` accompanies it either. A gate that
 * required an origin therefore refused a caller that was exactly who it claimed
 * to be — the listener's own 403 said so, from the extension, on every request.
 *
 * So an absent origin is admitted, and the bearer carries authentication for
 * that caller. This is not the gate being loosened past a page, because a page
 * cannot reach the admitted state: it holds no host permissions, its fetch is
 * ordinary CORS, and `Origin` is required on a non-simple request — which is
 * why the header is present, is checked, and is refused when it is not loopback.
 * A caller presenting no origin has already shown it is not a page. The bearer
 * is a per-run random in a `0600` file inside the user's own directory, and it
 * is what a page is actually kept out by.
 *
 * Admitting a *present* extension origin is likewise not a widening. That
 * origin is not in a page's origin space: no document, and no `fetch` from one,
 * can present `chrome-extension://` as its own. What the check exists to stop is
 * a name that resolves to loopback — a rebinding or host-header trick — and
 * neither admitted case is such a name.
 */
export function checkRelayOrigin(origin: unknown): void {
	if (origin === undefined) {
		return;
	}
	if (typeof origin !== "string") {
		throw new TypeError("bad origin");
	}
	if (EXTENSION_ORIGIN.test(origin)) {
		return;
	}
	checkUpgradeOrigin(origin);
}
