// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Fallback-wrapped dispatch for React-managed nodes. Best-effort
 * progressive enhancement over native dispatch: traverse enclosing
 * handlers via the framework props prefix, invoke with a synthesized event
 * carrying the real target, and always fall back to native bubbling
 * dispatch. Failure of the enhancement never rejects an invocation native
 * dispatch could complete. Scoped to React-managed nodes; plain DOM uses
 * native dispatch with no bridge.
 */

const PROPS_PREFIX = "__reactProps$";

export type AxDispatchOutcome = "bridge" | "native";

interface AxSyntheticClick {
	readonly bubbles: boolean;
	readonly cancelable: boolean;
	readonly target: EventTarget;
	readonly currentTarget: EventTarget;
	preventDefault(): void;
	stopPropagation(): void;
	readonly nativeEvent: null;
}

function readPropsKey(el: Element): string | undefined {
	try {
		for (const key of Object.keys(el)) {
			if (key.startsWith(PROPS_PREFIX)) {
				return key;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function readHandler(
	el: Element,
	key: string,
): ((event: unknown) => void) | undefined {
	try {
		const props = (el as unknown as Record<string, unknown>)[key] as
			| Record<string, unknown>
			| null
			| undefined;
		if (typeof props !== "object" || props === null) {
			return undefined;
		}
		const handler = props.onClick;
		return typeof handler === "function"
			? (handler as (event: unknown) => void)
			: undefined;
	} catch {
		return undefined;
	}
}

function nativeDispatch(target: Element): void {
	try {
		const clickable = target as unknown as { click?: unknown };
		if (typeof clickable.click === "function") {
			(clickable.click as () => void).call(target);
			return;
		}
	} catch {
		// Fall through to event dispatch below.
	}
	const view = target.ownerDocument?.defaultView ?? undefined;
	try {
		target.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				view: view ?? null,
			}),
		);
	} catch {
		target.dispatchEvent(
			new Event("click", { bubbles: true, cancelable: true }),
		);
	}
}

/**
 * Drive one interaction. Returns how it was handled. Never throws for a
 * reachable target: bridge failure falls back to native dispatch with a
 * logged fallback.
 */
export function dispatchAxAction(target: Element): AxDispatchOutcome {
	const original = target;
	let node: Element | null = target;
	let sawReactNode = false;
	try {
		while (node !== null) {
			const key = readPropsKey(node);
			if (key !== undefined) {
				sawReactNode = true;
				const handler = readHandler(node, key);
				if (handler !== undefined) {
					const synthetic: AxSyntheticClick = {
						bubbles: true,
						cancelable: true,
						target: original,
						currentTarget: node,
						preventDefault() {},
						stopPropagation() {},
						nativeEvent: null,
					};
					handler.call(node, synthetic);
					return "bridge";
				}
			}
			node = node.parentElement;
		}
	} catch {
		// Best-effort only: fall through to native dispatch below.
	}
	if (sawReactNode) {
		console.info("[ax-kit/react] dispatch fallback to native dispatch");
	}
	try {
		nativeDispatch(original);
	} catch {
		// Native dispatch is the last resort; its failure is observed by the
		// caller through the DOM, never as a rejection here.
	}
	return "native";
}
