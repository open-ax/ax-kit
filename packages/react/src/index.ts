// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * Lifecycle-native `document.modelContext` bindings for React.
 *
 * Everything here is ours, not draft-derived: the draft defines the
 * `document.modelContext` surface, while these hooks and the provider are
 * conveniences reachable only through this entry so no spec-conformant core
 * path can observe them.
 */

export type { AxProviderProps } from "./context.js";
export { AxProvider } from "./context.js";
export type { AxDispatchOutcome } from "./dispatch.js";
export { dispatchAxClick } from "./dispatch.js";
export { isAxSupported, useAxTool } from "./hooks.js";
export type {
	AxAnnotations,
	AxExecuteCallback,
	AxExecuteOptions,
	AxMiddleware,
	AxToolDefinition,
	AxToolHandle,
	AxToolOptions,
} from "./types.js";
