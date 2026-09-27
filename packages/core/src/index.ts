// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { installModelContext } from "./install.js";

export { SPEC_VERSION } from "./constants.js";
export { ToolActivatedEvent, ToolCancelEvent } from "./events.js";
export { installModelContext } from "./install.js";
export type {
	ModelContext,
	ModelContextExecuteToolOptions,
	ModelContextGetToolOptions,
	ModelContextRegisterToolOptions,
	ModelContextTool,
	RegisteredTool,
	ToolAnnotations,
	ToolExecuteCallback,
	ToolExecuteCallbackOptions,
} from "./types.js";

const rootDocument: unknown =
	typeof document === "undefined" ? undefined : document;
if (rootDocument !== undefined) {
	installModelContext(rootDocument as Document);
}
