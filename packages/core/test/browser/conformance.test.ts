// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// Real-Chromium conformance: everything touching the live global,
// EventTarget semantics, signal races, taxonomy, origin logic, and frame
// isolation. Pure logic stays in the fast layer. No sleeps anywhere.

import { describe, expect, it } from "vitest";
import { ToolActivatedEvent } from "../../src/events.js";
import type { ModelContext, RegisteredTool } from "../../src/index.js";
import { installModelContext } from "../../src/index.js";

installModelContext(document);

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

function context(): ModelContext {
	const installed = (document as unknown as Record<string, unknown>)[
		"modelContext"
	] as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

function childDocument(): Document {
	const frame = document.createElement("iframe");
	document.body.appendChild(frame);
	const child = frame.contentDocument;
	if (child === null) {
		frame.remove();
		throw new Error("iframe has no document");
	}
	return child;
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

describe("browser global", () => {
	it("runs in a secure context with one hardened instance", () => {
		expect(window.isSecureContext).toBe(true);
		expect(context()).toBe(
			(document as unknown as Record<string, unknown>)[
				"modelContext"
			] as ModelContext,
		);
		const descriptor = Object.getOwnPropertyDescriptor(
			document,
			"modelContext",
		);
		expect(descriptor?.writable).toBe(false);
		expect(descriptor?.configurable).toBe(false);
	});

	it("exposes no stale-shape alias", () => {
		const scope = globalThis as unknown as Record<string, unknown>;
		expect(scope["modelContext"]).toBeUndefined();
		expect(
			(window as unknown as Record<string, unknown>)["modelContext"],
		).toBeUndefined();
		expect(
			(navigator as unknown as Record<string, unknown>)["modelContext"],
		).toBeUndefined();
	});
});

describe("browser registration and execution", () => {
	it("round-trips through the live surface", async () => {
		const mc = context();
		await mc.registerTool({
			name: "browser_echo",
			description: "echo",
			inputSchema: {
				type: "object",
				properties: { q: { type: "string" } },
				required: ["q"],
			},
			execute: async (inputObject) => inputObject,
		});
		const tool = (await mc.getTools()).find(
			(item) => item.name === "browser_echo",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		expect(tool.origin).toBe(document.location.origin);
		expect(tool.window).toBe(window);
		expect(await mc.executeTool(tool, { q: "x" })).toBe(
			JSON.stringify({ q: "x" }),
		);
	});

	it("defaults an omitted argument to {}", async () => {
		const mc = context();
		const tool = (await mc.getTools()).find(
			(item) => item.name === "browser_echo",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		// Upstream: webmcp/imperative/object-arguments.https.html.
		const seen: unknown[] = [];
		await mc.registerTool({
			name: "browser_omitted",
			description: "omitted",
			execute: async (inputObject) => {
				seen.push(inputObject);
				return null;
			},
		});
		const omitted = (await mc.getTools()).find(
			(item) => item.name === "browser_omitted",
		);
		if (omitted === undefined) {
			throw new Error("tool is not listed");
		}
		expect(await mc.executeTool(omitted)).toBe("null");
		expect(seen).toEqual([{}]);
	});
});

describe("browser frames", () => {
	it("shares visibility across same-origin frames without shadowing", async () => {
		const mc = context();
		const child = childDocument();
		try {
			const childContext = installModelContext(child);
			if (childContext === undefined) {
				throw new Error("expected an installed context");
			}
			await mc.registerTool({
				name: "browser_shared",
				description: "from-parent",
				execute: async () => "parent",
			});
			await childContext.registerTool({
				name: "browser_shared",
				description: "from-child",
				execute: async () => "child",
			});
			const parentSeen = (await mc.getTools()).filter(
				(item) => item.name === "browser_shared",
			);
			expect(parentSeen.map((item) => item.description).sort()).toEqual([
				"from-child",
				"from-parent",
			]);
			const childSeen = (await childContext.getTools()).filter(
				(item) => item.name === "browser_shared",
			);
			expect(childSeen.length).toBe(2);
			const childTool = childSeen.find(
				(item) => item.description === "from-child",
			);
			if (childTool === undefined) {
				throw new Error("child tool is not listed");
			}
			expect(childTool.window).toBe(child.defaultView);
			// Each side executes its own record: no cross shadowing.
			const parentTool = parentSeen.find(
				(item) => item.description === "from-parent",
			);
			if (parentTool === undefined) {
				throw new Error("parent tool is not listed");
			}
			expect(await mc.executeTool(parentTool, {})).toBe(
				JSON.stringify("parent"),
			);
			expect(await childContext.executeTool(childTool, {})).toBe(
				JSON.stringify("child"),
			);
		} finally {
			child.defaultView?.frameElement?.remove();
		}
	});

	it("executes across the hierarchy in both directions", async () => {
		const mc = context();
		const child = childDocument();
		try {
			const childContext = installModelContext(child);
			if (childContext === undefined) {
				throw new Error("expected an installed context");
			}
			await childContext.registerTool({
				name: "browser_down",
				description: "down",
				execute: async () => "down-result",
			});
			const fromParent = (await mc.getTools()).find(
				(item) => item.name === "browser_down",
			);
			if (fromParent === undefined) {
				throw new Error("child tool is not visible to the parent");
			}
			expect(await mc.executeTool(fromParent, {})).toBe(
				JSON.stringify("down-result"),
			);
			await mc.registerTool({
				name: "browser_up",
				description: "up",
				execute: async () => "up-result",
			});
			const fromChild = (await childContext.getTools()).find(
				(item) => item.name === "browser_up",
			);
			if (fromChild === undefined) {
				throw new Error("parent tool is not visible to the child");
			}
			expect(await childContext.executeTool(fromChild, {})).toBe(
				JSON.stringify("up-result"),
			);
		} finally {
			child.defaultView?.frameElement?.remove();
		}
	});

	it("propagates change notifications to descendants", async () => {
		const mc = context();
		const child = childDocument();
		try {
			const childContext = installModelContext(child);
			if (childContext === undefined) {
				throw new Error("expected an installed context");
			}
			const seen: string[] = [];
			childContext.addEventListener("toolchange", () => {
				seen.push("child");
			});
			await mc.registerTool({
				name: "browser_notify",
				description: "notify",
				execute: async () => null,
			});
			await settleTasks();
			expect(seen).toEqual(["child"]);
		} finally {
			child.defaultView?.frameElement?.remove();
		}
	});

	it("rejects execution when the target loses eligibility", async () => {
		const mc = context();
		const child = childDocument();
		try {
			const childContext = installModelContext(child);
			if (childContext === undefined) {
				throw new Error("expected an installed context");
			}
			await childContext.registerTool({
				name: "browser_target_gate",
				description: "target",
				execute: async () => "unreachable",
			});
			const tool = (await mc.getTools()).find(
				(item) => item.name === "browser_target_gate",
			);
			if (tool === undefined) {
				throw new Error("tool is not listed");
			}
			Object.defineProperty(child, "permissionsPolicy", {
				value: { allowsFeature: () => false, features: () => ["tools"] },
				configurable: true,
			});
			expect(errorName(await errorOf(mc.executeTool(tool, {})))).toBe(
				"UnknownError",
			);
		} finally {
			child.defaultView?.frameElement?.remove();
		}
	});

	it("aborts the callback when only the target unloads", async () => {
		const mc = context();
		const child = childDocument();
		try {
			const childContext = installModelContext(child);
			if (childContext === undefined) {
				throw new Error("expected an installed context");
			}
			let aborted = false;
			await childContext.registerTool({
				name: "browser_unload_target",
				description: "target",
				execute: (_input, options) =>
					new Promise<unknown>((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(options.signal.reason);
							},
							{ once: true },
						);
					}),
			});
			const tool = (await mc.getTools()).find(
				(item) => item.name === "browser_unload_target",
			);
			if (tool === undefined) {
				throw new Error("tool is not listed");
			}
			const pending = mc.executeTool(tool, {});
			child.defaultView?.frameElement?.remove();
			expect(errorName(await errorOf(pending))).toBe("UnknownError");
			expect(aborted).toBe(true);
		} finally {
			child.defaultView?.frameElement?.remove();
		}
	});
});

describe("browser events", () => {
	it("fires real activation events carrying only the name", async () => {
		const mc = context();
		const activated: Event[] = [];
		mc.addEventListener("toolactivated", (event) => {
			activated.push(event);
		});
		await mc.registerTool({
			name: "browser_event",
			description: "event",
			execute: async () => null,
		});
		const tool: RegisteredTool | undefined = (await mc.getTools()).find(
			(item) => item.name === "browser_event",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		await mc.executeTool(tool, {});
		expect(activated.length).toBe(1);
		expect(activated[0]).toBeInstanceOf(ToolActivatedEvent);
		expect(activated[0]).toBeInstanceOf(Event);
		expect((activated[0] as ToolActivatedEvent).toolName).toBe("browser_event");
		expect(activated[0].cancelable).toBe(false);
	});
});
