// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Click dispatch for React-managed nodes. Best-effort progressive
 * enhancement over native dispatch: invoke the nearest enclosing `onClick`
 * via the framework props prefix with a synthesized event carrying the real
 * target, and always fall back to native bubbling dispatch. Click-only and
 * single-handler by design: capture handlers, other event types, and further
 * ancestors never run through the bridge. Plain DOM and everything the
 * bridge misses use native dispatch with no bridge. Failure of the
 * enhancement never rejects an invocation native dispatch could complete. A
 * bridged handler that throws is reported without a native re-run, so one
 * logical click never invokes the handler twice. Scoped to React-managed
 * nodes; plain DOM uses native dispatch with no bridge.
 */

const PROPS_PREFIX = "__reactProps$";

export type AxDispatchOutcome = "bridge" | "native";

interface AxSyntheticClick {
	readonly type: "click";
	readonly bubbles: boolean;
	readonly cancelable: boolean;
	readonly defaultPrevented: boolean;
	readonly target: EventTarget;
	readonly currentTarget: EventTarget;
	readonly nativeEvent: Event;
	preventDefault(): void;
	stopPropagation(): void;
	isDefaultPrevented(): boolean;
	isPropagationStopped(): boolean;
}

function isDisabled(el: Element): boolean {
	try {
		if (typeof el.matches === "function" && el.matches(":disabled")) {
			return true;
		}
	} catch {
		// Fall through to the own-property check below.
	}
	try {
		return (el as unknown as { disabled?: unknown }).disabled === true;
	} catch {
		return false;
	}
}

function nativeEventFor(target: Element): Event {
	const view = target.ownerDocument?.defaultView ?? undefined;
	try {
		return new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			view: view ?? null,
		});
	} catch {
		return new Event("click", { bubbles: true, cancelable: true });
	}
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

/**
 * The native click up the target's own prototype chain, skipping own
 * expandos. A page-owned `click` property must never shadow the trusted
 * activation the bridge falls back to.
 */
function nativeClickOf(target: Element): (() => void) | undefined {
	let proto: unknown = Object.getPrototypeOf(target);
	while (proto !== null) {
		const found = (proto as Record<string, unknown>).click;
		if (typeof found === "function") {
			return found as () => void;
		}
		proto = Object.getPrototypeOf(proto);
	}
	return undefined;
}

function nativeDispatch(target: Element): void {
	const nativeClick = nativeClickOf(target);
	if (nativeClick !== undefined) {
		try {
			nativeClick.call(target);
			return;
		} catch {
			// Fall through to event dispatch below.
		}
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
 * Drive one click. Returns how it was handled. Never throws for a reachable
 * target: bridge failure falls back to native dispatch with a logged
 * fallback. Non-element targets reject with `TypeError`.
 */
export function dispatchAxClick(target: Element): AxDispatchOutcome {
	if (
		typeof target !== "object" ||
		target === null ||
		(target as Node).nodeType !== 1
	) {
		throw new TypeError("bad dispatch target");
	}
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
					if (isDisabled(node) || isDisabled(original)) {
						break;
					}
					let defaultPrevented = false;
					let propagationStopped = false;
					let nativeEvent: Event;
					try {
						nativeEvent = nativeEventFor(original);
					} catch {
						break;
					}
					const synthetic: AxSyntheticClick = {
						type: "click",
						bubbles: true,
						cancelable: true,
						get defaultPrevented(): boolean {
							return defaultPrevented;
						},
						target: original,
						currentTarget: node,
						nativeEvent,
						preventDefault(): void {
							defaultPrevented = true;
							try {
								nativeEvent.preventDefault();
							} catch {
								// Native event is best-effort only.
							}
						},
						stopPropagation(): void {
							propagationStopped = true;
							try {
								nativeEvent.stopPropagation();
							} catch {
								// Native event is best-effort only.
							}
						},
						isDefaultPrevented(): boolean {
							return defaultPrevented;
						},
						isPropagationStopped(): boolean {
							return propagationStopped;
						},
					};
					try {
						handler.call(node, synthetic);
					} catch (error) {
						console.error(
							"[ax-kit/react] bridged handler threw; skipping native fallback",
							error,
						);
					}
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
