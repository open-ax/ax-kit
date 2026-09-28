// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { ModelContext } from "@ax-kit/core";
import { installModelContext } from "@ax-kit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { useAxTool } from "../../src/index.js";

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

let apps: Array<ReturnType<typeof createApp>> = [];

beforeEach(() => {
	document.body.innerHTML = "";
	installModelContext(document);
});

afterEach(async () => {
	for (const app of apps) {
		app.unmount();
	}
	apps = [];
	const { unregisterTool } = await import("@ax-kit/core/ax");
	for (const tool of await context().getTools()) {
		unregisterTool(tool.name);
	}
	await settle();
	document.body.innerHTML = "";
});

describe("vue bindings in real chromium", () => {
	it("registers on mount and removes on unmount", async () => {
		const Tool = defineComponent({
			setup() {
				useAxTool({
					name: "browser_vue_mount",
					description: "real mount",
					execute: () => Promise.resolve("ok"),
				});
				return () => h("div");
			},
		});
		const el = document.createElement("div");
		document.body.appendChild(el);
		const app = createApp(Tool);
		apps.push(app);
		app.mount(el);
		await settle();
		expect((await context().getTools()).map((t) => t.name)).toContain(
			"browser_vue_mount",
		);
		app.unmount();
		apps.pop();
		await settle();
		expect((await context().getTools()).map((t) => t.name)).not.toContain(
			"browser_vue_mount",
		);
		el.remove();
	});
});
