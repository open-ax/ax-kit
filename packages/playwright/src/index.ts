// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Runner-side companion for driving the typed page surface in tests.
 *
 * The fixture installs the built page-side bundle before application code
 * runs and attaches a runner-realm companion to the page. Nothing enters
 * the page namespace besides the typed surface itself.
 */

export type { AxPage } from "./ax.js";
export { AxCompanion } from "./ax.js";
export { AxMissingSurfaceError } from "./errors.js";
export { AxParseError, executeTool, getAvailableTools } from "./execute.js";
export { expect, test } from "./fixture.js";
export { compareToolNames, findToolByName } from "./match.js";
export { resolveInitScriptPath } from "./paths.js";
export type {
	AxExecuteOptions,
	AxExpectOptions,
	AxListOptions,
	AxToolAnnotations,
	AxToolSummary,
	AxWaitOptions,
} from "./types.js";
export { expectTool, waitForTool } from "./wait.js";
