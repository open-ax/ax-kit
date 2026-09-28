// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxProvider, useAxTool } from "../src/index.js";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
	true;

function context(): ModelContext {
	const raw = document as unknown as Record<string, unknown>;
	const mc = raw.modelContext as ModelContext | undefined;
	if (mc === undefined) {
		throw new Error("modelContext not installed");
	}
	return mc;
}

function nextTask(): Promise<void> {
	return new Promise<void>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = (): void => {
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}

async function settle(): Promise<void> {
	await nextTask();
	await nextTask();
}

async function listedNames(): Promise<string[]> {
	return (await context().getTools()).map((t) => t.name);
}

let roots: Array<ReturnType<typeof createRoot>> = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
	document.body.innerHTML = "";
	installModelContext(document);
});

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots = [];
	for (const el of containers) {
		el.remove();
	}
	containers = [];
	const { unregisterTool } = await import("@ax-kit/core/ax");
	for (const tool of await context().getTools()) {
		unregisterTool(tool.name);
	}
	await settle();
	document.body.innerHTML = "";
});

async function mount(
	node: React.ReactNode,
	strict = false,
): Promise<HTMLElement> {
	const el = document.createElement("div");
	document.body.appendChild(el);
	containers.push(el);
	const root = createRoot(el);
	roots.push(root);
	const tree = strict ? <StrictMode>{node}</StrictMode> : node;
	await act(async () => {
		root.render(tree);
	});
	return el;
}

describe("useAxTool binding contract", () => {
	it("registers on mount and removes on unmount", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "hook_mount",
				description: "mount lifecycle",
				execute: async () => "ok",
			});
			return null;
		}
		const el = document.createElement("div");
		document.body.appendChild(el);
		containers.push(el);
		const root = createRoot(el);
		roots.push(root);
		await act(async () => {
			root.render(<Tool />);
		});
		await settle();
		expect(await listedNames()).toContain("hook_mount");
		await act(async () => {
			root.unmount();
		});
		roots.pop();
		await settle();
		expect(await listedNames()).not.toContain("hook_mount");
		el.remove();
		containers.pop();
	});

	it("leaves exactly one registration under StrictMode double-mount", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "hook_strict",
				description: "strict gate",
				execute: async () => "ok",
			});
			return null;
		}
		await mount(<Tool />, true);
		await settle();
		await settle();
		const names = (await listedNames()).filter((n) => n === "hook_strict");
		expect(names).toEqual(["hook_strict"]);
	});

	it("returns an inert handle where the surface is absent", async () => {
		const { isAxSupported } = await import("../src/index.js");
		expect(isAxSupported(document)).toBe(true);
		const detached = document.implementation.createHTMLDocument("detached");
		expect(isAxSupported(detached)).toBe(false);
		expect(isAxSupported(undefined)).toBe(false);
	});

	it("forwards execution to the latest handler without re-register churn", async () => {
		function Tool({ value }: { value: string }): React.ReactNode {
			useAxTool({
				name: "hook_fresh",
				description: "freshness",
				execute: async () => value,
			});
			return null;
		}
		const el = document.createElement("div");
		document.body.appendChild(el);
		containers.push(el);
		const root = createRoot(el);
		roots.push(root);
		await act(async () => {
			root.render(<Tool value="first" />);
		});
		await settle();
		await act(async () => {
			root.render(<Tool value="second" />);
		});
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "hook_fresh",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		const json = await context().executeTool(tool, {});
		expect(JSON.parse(json)).toBe("second");
	});

	it("swaps definition on identity change", async () => {
		function Tool({ description }: { description: string }): React.ReactNode {
			useAxTool({
				name: "hook_identity",
				description,
				execute: async () => "ok",
			});
			return null;
		}
		const el = document.createElement("div");
		document.body.appendChild(el);
		containers.push(el);
		const root = createRoot(el);
		roots.push(root);
		await act(async () => {
			root.render(<Tool description="one" />);
		});
		await settle();
		await act(async () => {
			root.render(<Tool description="two" />);
		});
		await settle();
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "hook_identity",
		);
		expect(tool?.description).toBe("two");
	});

	it("surfaces invalid identity with the specified error family", async () => {
		let error: unknown;
		function Tool(): React.ReactNode {
			const handle = useAxTool({
				name: "bad name!",
				description: "bad",
				execute: async () => "ok",
			});
			error = handle.error;
			return null;
		}
		await mount(<Tool />);
		await settle();
		await settle();
		const err = error as DOMException | null;
		expect(err?.name).toBe("InvalidStateError");
	});

	it("keeps registration and execution lifetimes distinct", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "hook_signals",
				description: "signals",
				execute: async (_args, { signal }) => {
					await new Promise<void>((_resolve, reject) => {
						if (signal.aborted) {
							reject(signal.reason);
							return;
						}
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
						// Never resolves unless aborted: proves execution abort settles the call.
					});
					return "unreached";
				},
			});
			return null;
		}
		await mount(<Tool />);
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "hook_signals",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		const controller = new AbortController();
		const pending = context().executeTool(
			tool,
			{},
			{ signal: controller.signal },
		);
		controller.abort(new DOMException("stop", "AbortError"));
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		// Aborting one invocation leaves the tool available.
		expect(await listedNames()).toContain("hook_signals");
	});

	it("preserves consequential annotation and origin scoping", async () => {
		function Tool(): React.ReactNode {
			useAxTool({
				name: "hook_scoped",
				description: "scoped",
				annotations: { consequentialHint: true },
				execute: async () => "ok",
			});
			return null;
		}
		await mount(<Tool />);
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "hook_scoped",
		);
		expect(tool?.annotations?.consequentialHint).toBe(true);
		expect(tool?.origin).toBe(document.location.origin);
	});

	it("matches by name in code-unit order, never positional", async () => {
		function Tools(): React.ReactNode {
			useAxTool({ name: "order_b", description: "b", execute: async () => 1 });
			return null;
		}
		function Tools2(): React.ReactNode {
			useAxTool({ name: "order_A", description: "a", execute: async () => 1 });
			return null;
		}
		await mount(
			<>
				<Tools />
				<Tools2 />
			</>,
		);
		await settle();
		const names = (await listedNames()).filter((n) => n.startsWith("order_"));
		expect(names).toEqual(["order_A", "order_b"]);
	});

	it("treats change notification as a hint with no ordering guarantee", async () => {
		let hints = 0;
		function Tool(): React.ReactNode {
			useAxTool({
				name: "hook_hint",
				description: "hint",
				execute: async () => "ok",
			});
			return null;
		}
		const mc = context();
		await settle();
		const onChange = (): void => {
			hints += 1;
		};
		mc.addEventListener("toolchange", onChange);
		await mount(<Tool />);
		await settle();
		expect(hints).toBeGreaterThanOrEqual(1);
		mc.removeEventListener("toolchange", onChange);
		// Consumer re-lists on hint rather than trusting payload order.
		expect(await listedNames()).toContain("hook_hint");
	});
});

describe("named tool registration and provider", () => {
	it("registers a tool by name and handler", async () => {
		function Tool(): React.ReactNode {
			useAxTool("action_tool", async () => "done", {
				description: "does work",
			});
			return null;
		}
		await mount(<Tool />);
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "action_tool",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		const json = await context().executeTool(tool, {});
		expect(JSON.parse(json)).toBe("done");
	});

	it("prefixes names and runs middleware through the provider", async () => {
		const seen: unknown[] = [];
		function Tool(): React.ReactNode {
			useAxTool({
				name: "prefixed",
				description: "namespaced",
				execute: async () => "inner",
			});
			return null;
		}
		await mount(
			<AxProvider
				namespace="cart."
				middleware={async (next, args, opts) => {
					seen.push(args);
					const out = (await next(args, opts)) as string;
					return `${out}!`;
				}}
			>
				<Tool />
			</AxProvider>,
		);
		await settle();
		expect(await listedNames()).toContain("cart.prefixed");
		const tool = (await context().getTools()).find(
			(t) => t.name === "cart.prefixed",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		const json = await context().executeTool(tool, {});
		expect(JSON.parse(json)).toBe("inner!");
		expect(seen).toEqual([{}]);
	});

	it("observes latest state through actions", async () => {
		function Counter(): React.ReactNode {
			const [count] = useState(7);
			useAxTool("state_tool", async () => count, {
				description: "reads state",
			});
			return null;
		}
		await mount(<Counter />);
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "state_tool",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		expect(JSON.parse(await context().executeTool(tool, {}))).toBe(7);
	});

	it("does not register during server rendering", async () => {
		const { renderToString } = await import("react-dom/server");
		const before = new Set(await listedNames());
		let handle: ReturnType<typeof useAxTool> | undefined;
		function Tool(): React.ReactNode {
			handle = useAxTool({
				name: "hook_ssr",
				description: "ssr",
				execute: async () => "ok",
			});
			return null;
		}
		renderToString(<Tool />);
		await settle();
		expect(await listedNames()).not.toContain("hook_ssr");
		expect(handle?.registered).toBe(false);
		expect(new Set(await listedNames()).size).toBeGreaterThanOrEqual(
			before.size,
		);
	});

	it("reports an invalid callback on the handle", async () => {
		let handle: ReturnType<typeof useAxTool> | undefined;
		function Tool(): React.ReactNode {
			handle = useAxTool(
				"bad_execute",
				undefined as unknown as () => Promise<unknown>,
			);
			return null;
		}
		await mount(<Tool />);
		await settle();
		await settle();
		expect(handle?.registered).toBe(false);
		expect(handle?.error).toBeInstanceOf(TypeError);
	});

	it("reports a missing object-form execute on the handle", async () => {
		let handle: ReturnType<typeof useAxTool> | undefined;
		function Tool(): React.ReactNode {
			handle = useAxTool({
				name: "bad_object",
				description: "bad",
				execute: undefined as unknown as () => Promise<unknown>,
			});
			return null;
		}
		await mount(<Tool />);
		await settle();
		await settle();
		expect(handle?.registered).toBe(false);
		expect(handle?.error).toBeInstanceOf(TypeError);
	});
});
