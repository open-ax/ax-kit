// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAxClick } from "../../src/index.js";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
	true;

let roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots = [];
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	return el;
}

async function settled(): Promise<void> {
	await act(async () => {});
}

describe("dispatch outcome", () => {
	it("reaches the enclosing handler with the real target", async () => {
		const seen: EventTarget[] = [];
		function Page(): React.ReactNode {
			return (
				<button
					type="button"
					onClick={(event: unknown) => {
						seen.push((event as { target: EventTarget }).target);
					}}
				>
					save
				</button>
			);
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		expect(dispatchAxClick(button)).toBe("bridge");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(button);
	});

	it("traverses from a nested node to the enclosing handler", async () => {
		const seen: EventTarget[] = [];
		function Page(): React.ReactNode {
			return (
				<button
					type="button"
					onClick={(event: unknown) => {
						seen.push((event as { target: EventTarget }).target);
					}}
				>
					<span data-icon="true">icon</span>
				</button>
			);
		}
		const host = await render(<Page />);
		await settled();
		const icon = host.querySelector('[data-icon="true"]');
		expect(icon).not.toBeNull();
		if (icon === null) {
			throw new Error("missing icon");
		}
		expect(dispatchAxClick(icon)).toBe("bridge");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(icon);
	});

	it("uses native bubbling dispatch for plain nodes", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		let calls = 0;
		el.addEventListener("click", () => {
			calls += 1;
		});
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(dispatchAxClick(el)).toBe("native");
		expect(calls).toBe(1);
		expect(log).not.toHaveBeenCalled();
		el.remove();
	});

	it("falls back with a logged fallback and still completes", async () => {
		function Page(): React.ReactNode {
			return <button type="button">plain</button>;
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		let calls = 0;
		button.addEventListener("click", () => {
			calls += 1;
		});
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(dispatchAxClick(button)).toBe("native");
		expect(log).toHaveBeenCalled();
		expect(calls).toBe(1);
	});

	it("never invokes a throwing bridge handler twice", async () => {
		let bridgeCalls = 0;
		function Page(): React.ReactNode {
			return (
				<button
					type="button"
					onClick={() => {
						bridgeCalls += 1;
						throw new Error("boom");
					}}
				>
					save
				</button>
			);
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		let nativeCalls = 0;
		button.addEventListener("click", () => {
			nativeCalls += 1;
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(dispatchAxClick(button)).toBe("bridge");
		expect(bridgeCalls).toBe(1);
		expect(nativeCalls).toBe(0);
		expect(error).toHaveBeenCalled();
	});

	it("rejects non-element targets with TypeError", () => {
		expect(() => dispatchAxClick(null as unknown as Element)).toThrow(
			TypeError,
		);
		expect(() => dispatchAxClick({} as unknown as Element)).toThrow(TypeError);
	});

	it("skips the bridge for disabled controls", async () => {
		let bridgeCalls = 0;
		function Page(): React.ReactNode {
			return (
				<button
					type="button"
					disabled
					onClick={() => {
						bridgeCalls += 1;
					}}
				>
					save
				</button>
			);
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(dispatchAxClick(button)).toBe("native");
		expect(bridgeCalls).toBe(0);
		expect(log).toHaveBeenCalled();
	});

	it("skips the bridge for controls disabled by a fieldset", async () => {
		let bridgeCalls = 0;
		function Page(): React.ReactNode {
			return (
				<fieldset disabled>
					<button
						type="button"
						onClick={() => {
							bridgeCalls += 1;
						}}
					>
						save
					</button>
				</fieldset>
			);
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		expect(dispatchAxClick(button)).toBe("native");
		expect(bridgeCalls).toBe(0);
		expect(log).toHaveBeenCalled();
	});

	it("provides the event contract expected by handlers", async () => {
		const seen: unknown[] = [];
		function Page(): React.ReactNode {
			return (
				<button
					type="button"
					onClick={(event: unknown) => {
						seen.push(event);
					}}
				>
					save
				</button>
			);
		}
		const host = await render(<Page />);
		await settled();
		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		if (button === null) {
			throw new Error("missing button");
		}
		expect(dispatchAxClick(button)).toBe("bridge");
		expect(seen).toHaveLength(1);
		const event = seen[0] as {
			type: unknown;
			bubbles: unknown;
			cancelable: unknown;
			target: unknown;
			currentTarget: unknown;
			nativeEvent: unknown;
			defaultPrevented: unknown;
			isDefaultPrevented: () => boolean;
			isPropagationStopped: () => boolean;
			preventDefault: () => void;
		};
		expect(event.type).toBe("click");
		expect(event.bubbles).toBe(true);
		expect(event.cancelable).toBe(true);
		expect(event.target).toBe(button);
		expect(event.nativeEvent).toBeInstanceOf(Event);
		expect((event.nativeEvent as Event).type).toBe("click");
		expect(event.defaultPrevented).toBe(false);
		expect(event.isDefaultPrevented()).toBe(false);
		expect(event.isPropagationStopped()).toBe(false);
		event.preventDefault();
		expect(event.isDefaultPrevented()).toBe(true);
	});
});
