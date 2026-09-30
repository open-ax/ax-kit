// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Native-messaging host manifest: field, path, registry-document, size,
 * and reachability behavior. Reachable only from extension pages and the
 * service worker; renderer input is validated and sanitized first.
 */

export interface NativeHostManifest {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly type: "stdio";
	readonly allowed_origins: ReadonlyArray<string>;
}

export const HOST_TO_BROWSER_MAX_BYTES: number = 1024 * 1024;
export const BROWSER_TO_HOST_MAX_BYTES: number = 1024 * 1024;

const NAME_PATTERN = /^[a-z0-9_.]+$/;

function isAbsolutePath(path: string): boolean {
	return (
		path.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith("\\\\")
	);
}

function isBareInterpreter(path: string): boolean {
	const first = path.trim().split(/\s+/)[0] ?? "";
	const lower = first.toLowerCase();
	const base = lower.split(/[\\/]/).pop() ?? lower;
	if (
		base === "node" ||
		base === "node.exe" ||
		base === "python" ||
		base === "python3" ||
		base === "sh" ||
		base === "bash" ||
		base === "cmd" ||
		base === "powershell"
	) {
		return true;
	}
	const target = first.split(/[\\/]/).pop() ?? first;
	if (
		target.toLowerCase().endsWith(".js") ||
		target.toLowerCase().endsWith(".ts") ||
		target.toLowerCase().endsWith(".py") ||
		target.toLowerCase().endsWith(".sh")
	) {
		return true;
	}
	return false;
}

export function createNativeHostManifest(parts: unknown): NativeHostManifest {
	if (typeof parts !== "object" || parts === null) {
		throw new TypeError("bad host manifest");
	}
	const record = parts as Record<string, unknown>;
	const { name, description, path, type, allowed_origins } = record;
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		throw new TypeError("bad host name");
	}
	if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) {
		throw new TypeError("bad host name");
	}
	if (typeof description !== "string" || description.length === 0) {
		throw new TypeError("bad host description");
	}
	if (typeof path !== "string" || path.length === 0) {
		throw new TypeError("bad host path");
	}
	if (!isAbsolutePath(path)) {
		throw new TypeError("host path must be absolute");
	}
	if (isBareInterpreter(path)) {
		throw new TypeError("bare interpreter invocation");
	}
	if (type !== "stdio") {
		throw new TypeError("bad host type");
	}
	if (!Array.isArray(allowed_origins)) {
		throw new TypeError("bad allowed origins");
	}
	for (const entry of allowed_origins) {
		if (typeof entry !== "string") {
			throw new TypeError("wildcard origins are forbidden");
		}
		if (entry.includes("*")) {
			throw new TypeError("wildcard origins are forbidden");
		}
		if (!entry.startsWith("chrome-extension://") || entry.length <= 21) {
			throw new TypeError("allowed origin must be chrome-extension://<id>");
		}
	}
	return {
		name,
		description,
		path,
		type: "stdio",
		allowed_origins: [...allowed_origins],
	};
}

/** Windows registry points at the manifest document, never the binary. */
export function windowsRegistryValue(manifestPath: unknown): string {
	if (typeof manifestPath !== "string" || manifestPath.length === 0) {
		throw new TypeError("bad manifest path");
	}
	if (!manifestPath.endsWith(".json")) {
		throw new TypeError("registry must point at the manifest document");
	}
	return manifestPath;
}

export function checkMessageSize(bytes: unknown, direction: unknown): void {
	if (direction !== "host-to-browser" && direction !== "browser-to-host") {
		throw new TypeError("bad direction");
	}
	if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
		throw new TypeError("bad message size");
	}
	if (direction === "host-to-browser" && bytes > HOST_TO_BROWSER_MAX_BYTES) {
		throw new TypeError("host message too large");
	}
	if (direction === "browser-to-host" && bytes > BROWSER_TO_HOST_MAX_BYTES) {
		throw new TypeError("browser message too large");
	}
}

/** Only extension pages and the worker may reach the host. */
export function assertWorkerReachable(caller: unknown): void {
	if (caller !== "extension-page" && caller !== "service-worker") {
		throw new TypeError("host reachable from worker contexts only");
	}
}

/** Renderer input is hostile: validate origin and sanitize the payload. */
export function sanitizeRendererPayload(
	payload: unknown,
): Record<string, unknown> {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		throw new TypeError("bad renderer payload");
	}
	const record = payload as Record<string, unknown>;
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") {
			throw new TypeError(`forbidden key: ${key}`);
		}
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		) {
			clean[key] = value;
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				throw new TypeError("non-finite number");
			}
			clean[key] = value;
		} else {
			throw new TypeError("renderer payload must be flat JSON scalars");
		}
	}
	return clean;
}
