// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAxAction } from "../../src/index.js";

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
		expect(dispatchAxAction(button)).toBe("bridge");
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
		expect(dispatchAxAction(icon)).toBe("bridge");
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
		expect(dispatchAxAction(el)).toBe("native");
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
		expect(dispatchAxAction(button)).toBe("native");
		expect(log).toHaveBeenCalled();
		expect(calls).toBe(1);
	});
});
