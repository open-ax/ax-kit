// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle-native `document.modelContext` bindings for Vue.
 *
 * Everything here is ours, not draft-derived: the draft defines the
 * `document.modelContext` surface, while the composable and directive are
 * conveniences reachable only through this entry so no spec-conformant core
 * path can observe them.
 */

export type { AxToolHandle } from "./composable.js";
export { isAxSupported, useAxTool } from "./composable.js";
export { vAxTool } from "./directive.js";
export type {
	AxAnnotations,
	AxExecuteCallback,
	AxExecuteOptions,
	AxModelContextLike,
	AxToolDefinition,
} from "./types.js";
