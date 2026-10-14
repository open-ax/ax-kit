// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Native-messaging host manifest: the document a browser reads to locate the
 * host binary, and the rules its fields must satisfy.
 *
 * This module owns the manifest and nothing else. The process it describes is
 * `browser-host.ts`; the framing it speaks, and the per-message size cap that
 * has to hold while a message is being written, live there.
 *
 * What remains here is what a caller can get wrong before a process ever
 * starts: a relative path the browser cannot launch, and an `allowed_origins`
 * entry admitting an origin no extension should reach. Both are refused at
 * construction rather than warned about, because both fail as a bridge that
 * silently does not exist.
 */

export interface NativeHostManifest {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly type: "stdio";
	readonly allowed_origins: ReadonlyArray<string>;
}

const NAME_PATTERN = /^[a-z0-9_.]+$/;

const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/;

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
		if (!EXTENSION_ORIGIN_PATTERN.test(entry)) {
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
