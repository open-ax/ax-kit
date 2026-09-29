// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { AxToolSummary } from "./types.js";

/**
 * Code-unit name comparison, mirroring the draft's ascending sort. JS
 * relational comparison is code-unit based, so `<`/`>` implement the rule
 * without locale sensitivity: case and non-ASCII order by code point.
 */
export function compareToolNames(first: string, second: string): number {
	if (first < second) {
		return -1;
	}
	if (first > second) {
		return 1;
	}
	return 0;
}

/** Exact name lookup. Position is never identity. */
export function findToolByName(
	tools: ReadonlyArray<AxToolSummary>,
	name: string,
): AxToolSummary | undefined {
	return tools.find((tool) => tool.name === name);
}
