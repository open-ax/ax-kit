// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Change notification. The draft defines `toolchange` as a plain `Event`
 * with no payload and no interface: listeners re-list instead of reading a
 * detail shape. Activation and cancellation events arrive with ticket 05.
 */

export const TOOL_CHANGE = "toolchange";
export const TOOL_ACTIVATED = "toolactivated";
export const TOOL_CANCEL = "toolcancel";

export function fireToolChange(target: EventTarget): void {
	target.dispatchEvent(new Event(TOOL_CHANGE));
}

interface ToolLifecycleInit extends EventInit {
	readonly toolName?: string | undefined;
}

function lifecycleInit(
	init: ToolLifecycleInit | undefined,
): [EventInit, string] {
	const toolName = init?.toolName === undefined ? "" : String(init.toolName);
	const rest: EventInit = { ...init, cancelable: false };
	return [rest, toolName];
}

/**
 * Activation notification carrying only the tool name. Constructible and
 * non-cancelable: any `cancelable` flag in `init` is ignored.
 */
export class ToolActivatedEvent extends Event {
	readonly toolName: string;

	constructor(type: string, init?: ToolLifecycleInit | undefined) {
		const [rest, toolName] = lifecycleInit(init);
		super(type, rest);
		this.toolName = toolName;
	}
}

/**
 * Cancellation notification carrying only the tool name. Constructible and
 * non-cancelable: any `cancelable` flag in `init` is ignored.
 */
export class ToolCancelEvent extends Event {
	readonly toolName: string;

	constructor(type: string, init?: ToolLifecycleInit | undefined) {
		const [rest, toolName] = lifecycleInit(init);
		super(type, rest);
		this.toolName = toolName;
	}
}

export function fireToolActivated(target: EventTarget, toolName: string): void {
	target.dispatchEvent(new ToolActivatedEvent(TOOL_ACTIVATED, { toolName }));
}

export function fireToolCancel(target: EventTarget, toolName: string): void {
	target.dispatchEvent(new ToolCancelEvent(TOOL_CANCEL, { toolName }));
}
