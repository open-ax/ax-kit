// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/** Parse `ax-kit audit <url>` args. Throws on any other invocation. */
export function parseAuditTarget(args: readonly string[]): string {
	const command = args[0];
	const target = args[1];
	if (
		command !== "audit" ||
		typeof target !== "string" ||
		target.length === 0
	) {
		throw new TypeError("usage: ax-kit audit <url>");
	}
	return target;
}
