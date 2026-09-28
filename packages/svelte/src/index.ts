// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle-native `document.modelContext` bindings for Svelte.
 *
 * Everything here is ours, not draft-derived: the draft defines the
 * `document.modelContext` surface, while the element binding and rune
 * helper are conveniences reachable only through this entry so no
 * spec-conformant core path can observe them.
 */

export { axTool, axToolEffect, isAxSupported } from "./action.js";
export type {
	AxAnnotations,
	AxExecuteCallback,
	AxExecuteOptions,
	AxModelContextLike,
	AxToolDefinition,
} from "./types.js";
