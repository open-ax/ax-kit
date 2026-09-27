// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Change notification. The draft defines `toolchange` as a plain `Event`
 * with no payload and no interface: listeners re-list instead of reading a
 * detail shape. Activation and cancellation events arrive with ticket 05.
 */

export const TOOL_CHANGE = "toolchange";

export function fireToolChange(target: EventTarget): void {
	target.dispatchEvent(new Event(TOOL_CHANGE));
}
