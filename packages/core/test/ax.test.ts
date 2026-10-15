// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ToolChangeDiff } from "../src/ax/index.js";
import {
	executeToolResult,
	getTool,
	trackToolChanges,
	unregisterTool,
} from "../src/ax/index.js";
import type { ModelContext } from "../src/index.js";
import * as root from "../src/index.js";
import { installModelContext } from "../src/index.js";
import { unregisterRecord } from "../src/registry.js";

installModelContext(document);

function context(): ModelContext {
	const installed = (document as unknown as Record<string, unknown>)[
		"modelContext"
	] as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function errorName(error: unknown): string {
	if (error instanceof DOMException) {
		return error.name;
	}
	if (error instanceof TypeError) {
		return "TypeError";
	}
	return `unexpected:${String(error)}`;
}

// Task-source waits without timers: each round yields one MessageChannel
// turn, flushing queued change notifications ahead of the continuation.
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

async function settleTasks(): Promise<void> {
	await nextTask();
	await nextTask();
}

describe("ax entry isolation", () => {
	it("exposes no extension on the root entry or the live surface", () => {
		for (const name of [
			"unregisterTool",
			"getTool",
			"executeToolResult",
			"trackToolChanges",
		]) {
			expect(root as unknown as Record<string, unknown>).not.toHaveProperty(
				name,
			);
			expect(
				context() as unknown as Record<string, unknown>,
			).not.toHaveProperty(name);
		}
	});
});

describe("unregisterTool", () => {
	it("enforces the caller gates with the specified errors", async () => {
		const detached = document.implementation.createHTMLDocument("detached");
		installModelContext(detached);
		let thrown: unknown;
		try {
			unregisterTool("whatever", detached);
		} catch (error) {
			thrown = error;
		}
		expect(errorName(thrown)).toBe("InvalidStateError");
		expect(errorName(await errorOf(getTool("whatever", detached)))).toBe(
			"InvalidStateError",
		);
	});

	it("removes synchronously and reports whether it removed", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_remove",
			description: "remove",
			execute: async () => null,
		});
		// Drain the registration notification before listening.
		await settleTasks();
		let changes = 0;
		mc.addEventListener("toolchange", () => {
			changes += 1;
		});
		expect(unregisterTool("ax_remove")).toBe(true);
		expect(unregisterTool("ax_remove")).toBe(false);
		expect(
			(await mc.getTools()).some((item) => item.name === "ax_remove"),
		).toBe(false);
		await settleTasks();
		expect(changes).toBe(1);
	});

	// Upstream #345, 14 October 2026. The draft removes the tool definition
	// first and then returns without notifying when the document is no longer
	// fully active, because the notification algorithm finds documents by
	// walking the node navigable and an unloaded document has none to walk.
	// Removal therefore still happens; only the notification is suppressed.
	//
	// The control case above asserts the notification *does* fire for an active
	// document, which is what makes the zero below a measurement rather than a
	// tautology.
	it("removes without notifying when the document is no longer active", async () => {
		const host = document.createElement("iframe");
		document.body.append(host);
		const framed = host.contentDocument as Document;
		const mc = installModelContext(framed);
		expect(mc).toBeDefined();
		await mc?.registerTool({
			name: "ax_inactive_unreg",
			description: "removed after the document goes inactive",
			execute: async () => null,
		});
		await settleTasks();

		let changes = 0;
		mc?.addEventListener("toolchange", () => {
			changes += 1;
		});
		// Removal is unconditional: the draft removes the definition before it
		// consults the document's state.
		host.remove();
		expect(unregisterRecord(framed, "ax_inactive_unreg")).toBe(true);
		// And the tool is gone from the map, so a second removal reports that it
		// found nothing.
		expect(unregisterRecord(framed, "ax_inactive_unreg")).toBe(false);
		await settleTasks();
		expect(changes).toBe(0);
	});
});

describe("getTool", () => {
	it("finds one tool by name", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_lookup",
			description: "lookup",
			execute: async () => null,
		});
		expect((await getTool("ax_lookup"))?.description).toBe("lookup");
		expect(await getTool("ax_missing")).toBeUndefined();
	});
});

describe("executeToolResult", () => {
	it("returns the parsed value", async () => {
		const mc = context();
		await mc.registerTool({
			name: "ax_parsed",
			description: "parsed",
			execute: async (inputObject) => ({ echoed: inputObject }),
		});
		const tool = (await mc.getTools()).find(
			(item) => item.name === "ax_parsed",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		expect(await executeToolResult(mc, tool, { q: 1 })).toEqual({
			echoed: { q: 1 },
		});
	});
});

describe("trackToolChanges", () => {
	it("reports added and removed names", async () => {
		const mc = context();
		const diffs: ToolChangeDiff[] = [];
		const stop = await trackToolChanges(mc, (diff) => {
			diffs.push(diff);
		});
		try {
			await mc.registerTool({
				name: "ax_tracked",
				description: "tracked",
				execute: async () => null,
			});
			await settleTasks();
			expect(diffs).toEqual([{ added: ["ax_tracked"], removed: [] }]);
			expect(unregisterTool("ax_tracked")).toBe(true);
			// Let the queued refresh finish ahead of this continuation.
			await settleTasks();
			expect(diffs).toEqual([
				{ added: ["ax_tracked"], removed: [] },
				{ added: [], removed: ["ax_tracked"] },
			]);
		} finally {
			stop();
		}
	});
});
