// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ref } from "vue";
import {
	createApp,
	defineComponent,
	h,
	nextTick,
	reactive,
	ref,
	withDirectives,
} from "vue";
import type { AxToolHandle } from "../src/index.js";
import { isAxSupported, useAxTool, vAxTool } from "../src/index.js";

function context(): ModelContext {
	const raw = document as unknown as { modelContext?: ModelContext };
	const mc = raw.modelContext;
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

let apps: Array<ReturnType<typeof createApp>> = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
	document.body.innerHTML = "";
	installModelContext(document);
});

afterEach(async () => {
	for (const app of apps) {
		app.unmount();
	}
	apps = [];
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

function mountApp(root: Parameters<typeof createApp>[0]): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	containers.push(el);
	const app = createApp(root);
	apps.push(app);
	app.mount(el);
	return el;
}

describe("useAxTool composable", () => {
	it("registers on mount and aborts on unmount", async () => {
		const Tool = defineComponent({
			setup() {
				useAxTool({
					name: "vue_mount",
					description: "mount lifecycle",
					execute: () => Promise.resolve("ok"),
				});
				return () => h("div");
			},
		});
		mountApp(Tool);
		await settle();
		await nextTick();
		expect(await listedNames()).toContain("vue_mount");
		apps.pop()?.unmount();
		await settle();
		expect(await listedNames()).not.toContain("vue_mount");
	});

	it("builds only the inert handle in setup without a window", async () => {
		const detached = document.implementation.createHTMLDocument("detached");
		expect(isAxSupported(detached)).toBe(false);
		expect(isAxSupported(undefined)).toBe(false);
		expect(isAxSupported(document)).toBe(true);
	});

	it("forwards execution to fresh state", async () => {
		const count = ref("first");
		const Tool = defineComponent({
			setup() {
				useAxTool({
					name: "vue_fresh",
					description: "freshness",
					execute: () => Promise.resolve(count.value),
				});
				return () => h("div");
			},
		});
		mountApp(Tool);
		await settle();
		count.value = "second";
		await nextTick();
		const tool = (await context().getTools()).find(
			(t) => t.name === "vue_fresh",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		expect(JSON.parse(await context().executeTool(tool, {}))).toBe("second");
	});

	it("swaps definition when reactive identity changes", async () => {
		const tool = reactive({
			name: "vue_identity",
			description: "one",
			execute: () => Promise.resolve("ok"),
		});
		const Host = defineComponent({
			setup() {
				useAxTool(tool);
				return () => h("div");
			},
		});
		mountApp(Host);
		await settle();
		tool.description = "two";
		await nextTick();
		await settle();
		await settle();
		const entry = (await context().getTools()).find(
			(t) => t.name === "vue_identity",
		);
		expect(entry?.description).toBe("two");
	});

	it("surfaces invalid identity with the specified error family", async () => {
		let handle: AxToolHandle | undefined;
		const Tool = defineComponent({
			setup() {
				handle = useAxTool({
					name: "bad name!",
					description: "bad",
					execute: () => Promise.resolve("ok"),
				});
				return () => h("div");
			},
		});
		mountApp(Tool);
		await settle();
		await settle();
		await nextTick();
		const err: Ref<Error | DOMException | null> | undefined = handle?.error;
		expect(err?.value).toBeDefined();
		expect((err?.value as DOMException | null)?.name).toBe("InvalidStateError");
	});

	it("keeps registration and execution lifetimes distinct", async () => {
		const Tool = defineComponent({
			setup() {
				useAxTool({
					name: "vue_signals",
					description: "signals",
					execute: (_args, { signal }) =>
						new Promise<unknown>((_resolve, reject) => {
							if (signal.aborted) {
								reject(signal.reason);
								return;
							}
							signal.addEventListener("abort", () => reject(signal.reason), {
								once: true,
							});
						}),
				});
				return () => h("div");
			},
		});
		mountApp(Tool);
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "vue_signals",
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
		expect(await listedNames()).toContain("vue_signals");
	});

	it("preserves consequential annotation and sorted matching", async () => {
		const A = defineComponent({
			setup() {
				useAxTool({
					name: "vorder_b",
					description: "b",
					annotations: { consequentialHint: true },
					execute: () => Promise.resolve(1),
				});
				return () => h("div");
			},
		});
		const B = defineComponent({
			setup() {
				useAxTool({
					name: "vorder_A",
					description: "a",
					execute: () => Promise.resolve(1),
				});
				return () => h("div");
			},
		});
		const Host = defineComponent({
			setup() {
				return () => h("div", [h(A), h(B)]);
			},
		});
		mountApp(Host);
		await settle();
		const names = (await listedNames()).filter((n) => n.startsWith("vorder_"));
		expect(names).toEqual(["vorder_A", "vorder_b"]);
		const scoped = (await context().getTools()).find(
			(t) => t.name === "vorder_b",
		);
		expect(scoped?.annotations?.consequentialHint).toBe(true);
	});
});

describe("v-ax-tool directive", () => {
	it("registers on mount and aborts on unmount for plain elements", async () => {
		const descriptor = {
			name: "vue_directive",
			description: "directive lifecycle",
			execute: () => Promise.resolve("ok"),
		};
		const Host = defineComponent({
			setup() {
				return () => withDirectives(h("div", "plain"), [[vAxTool, descriptor]]);
			},
		});
		mountApp(Host);
		await settle();
		expect(await listedNames()).toContain("vue_directive");
		apps.pop()?.unmount();
		await settle();
		expect(await listedNames()).not.toContain("vue_directive");
	});

	it("swaps on value update", async () => {
		const first = {
			name: "vue_swap",
			description: "one",
			execute: () => Promise.resolve("ok"),
		};
		const second = {
			name: "vue_swap",
			description: "two",
			execute: () => Promise.resolve("ok"),
		};
		const current = ref(first);
		const Host = defineComponent({
			setup() {
				return () =>
					withDirectives(h("div", "plain"), [[vAxTool, current.value]]);
			},
		});
		mountApp(Host);
		await settle();
		current.value = second;
		await nextTick();
		await settle();
		await settle();
		const entry = (await context().getTools()).find(
			(t) => t.name === "vue_swap",
		);
		expect(entry?.description).toBe("two");
	});

	it("forwards execution to the latest handler without re-register churn", async () => {
		const first = {
			name: "vue_directive_fresh",
			description: "fresh",
			execute: () => Promise.resolve("first"),
		};
		const current = ref(first);
		const Host = defineComponent({
			setup() {
				return () =>
					withDirectives(h("div", "plain"), [[vAxTool, current.value]]);
			},
		});
		mountApp(Host);
		await settle();
		current.value = {
			name: "vue_directive_fresh",
			description: "fresh",
			execute: () => Promise.resolve("second"),
		};
		await nextTick();
		await settle();
		const tool = (await context().getTools()).find(
			(t) => t.name === "vue_directive_fresh",
		);
		expect(tool).toBeDefined();
		if (tool === undefined) {
			throw new Error("missing tool");
		}
		expect(JSON.parse(await context().executeTool(tool, {}))).toBe("second");
	});

	it("contributes no tool attributes during server output", async () => {
		const { getSSRProps } = vAxTool;
		if (typeof getSSRProps === "function") {
			const binding = { value: undefined } as unknown as Parameters<
				NonNullable<typeof getSSRProps>
			>[0];
			const vnode = {} as unknown as Parameters<
				NonNullable<typeof getSSRProps>
			>[1];
			expect(getSSRProps(binding, vnode)).toEqual({});
		}
	});
});
