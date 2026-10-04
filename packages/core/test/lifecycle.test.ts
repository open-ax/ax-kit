// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { ToolActivatedEvent, ToolCancelEvent } from "../src/events.js";
import type { ModelContext } from "../src/index.js";
import { installModelContext } from "../src/index.js";
import { handleDocumentUnload } from "../src/registry.js";

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

function denyTools(win: Window): void {
	Object.defineProperty(win.document, "permissionsPolicy", {
		value: { allowsFeature: () => false },
		configurable: true,
	});
}

function policyWith(
	allowsFeature: () => boolean,
	features: () => string[],
): unknown {
	return { allowsFeature, features };
}

// happy-dom's Document predates parts of lib.dom: bridge once, documented.
function docOf(win: { readonly document: unknown }): Document {
	return win.document as Document;
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

describe("event shapes", () => {
	it("toolchange is a plain event without payload", async () => {
		const mc = context();
		const seen: Event[] = [];
		mc.addEventListener("toolchange", (event) => {
			seen.push(event);
		});
		await mc.registerTool({
			name: "life_change",
			description: "change",
			execute: async () => null,
		});
		await settleTasks();
		expect(seen.length).toBe(1);
		expect(seen[0]).toBeInstanceOf(Event);
		expect(seen[0]).not.toBeInstanceOf(ToolActivatedEvent);
		expect("toolName" in seen[0]).toBe(false);
	});

	it("queues change notification instead of firing synchronously", async () => {
		const mc = context();
		let count = 0;
		mc.addEventListener("toolchange", () => {
			count += 1;
		});
		const pending = mc.registerTool({
			name: "life_queued",
			description: "queued",
			execute: async () => null,
		});
		// A synchronous dispatch would already have fired here.
		expect(count).toBe(0);
		await pending;
		await settleTasks();
		expect(count).toBe(1);
	});

	it("activation and cancellation events carry only the tool name", () => {
		const activated = new ToolActivatedEvent("toolactivated", {
			toolName: "t",
		});
		expect(activated.toolName).toBe("t");
		expect(activated.cancelable).toBe(false);
		expect(activated.bubbles).toBe(false);

		const forced = new ToolActivatedEvent("toolactivated", {
			toolName: "t",
			cancelable: true,
		} as EventInit);
		expect(forced.cancelable).toBe(false);

		const cancelled = new ToolCancelEvent("toolcancel");
		expect(cancelled.toolName).toBe("");
		expect(cancelled.cancelable).toBe(false);
	});

	it("handler attributes install, replace, and clear listeners", async () => {
		const mc = context();
		let first = 0;
		let second = 0;
		mc.ontoolchange = () => {
			first += 1;
		};
		await mc.registerTool({
			name: "life_handler",
			description: "handler",
			execute: async () => null,
		});
		await settleTasks();
		expect(first).toBe(1);
		mc.ontoolchange = () => {
			second += 1;
		};
		expect(mc.ontoolchange).not.toBeNull();
		mc.ontoolchange = null;
		expect(mc.ontoolchange).toBeNull();
		// Non-callables collapse to null instead of throwing.
		mc.ontoolchange = 42 as unknown as (event: Event) => void;
		expect(mc.ontoolchange).toBeNull();
		expect(second).toBe(0);
		expect(first).toBe(1);
	});

	it("handler attributes leave explicit listeners alone", async () => {
		const mc = context();
		const order: string[] = [];
		const explicit = (): void => {
			order.push("explicit");
		};
		mc.addEventListener("toolchange", explicit);
		mc.ontoolchange = () => {
			order.push("handler");
		};
		const changed = async (name: string): Promise<void> => {
			await mc.registerTool({
				name,
				description: "handler",
				execute: async () => null,
			});
			await settleTasks();
		};
		await changed("life_order_one");
		expect(order.length).toBe(2);
		const slot = order.indexOf("handler");
		expect(slot).toBeGreaterThanOrEqual(0);
		mc.ontoolchange = () => {
			order.push("handler2");
		};
		await changed("life_order_two");
		expect(order.length).toBe(4);
		// The replacement reuses the wrapper's slot within each dispatch.
		expect(order[slot]).toBe("handler");
		expect(order[slot + 2]).toBe("handler2");
		mc.ontoolchange = null;
		await changed("life_order_three");
		mc.removeEventListener("toolchange", explicit);
		expect(order.length).toBe(5);
		// Clearing the handler never removes the explicit listener.
		expect(order[4]).toBe("explicit");
	});

	it("a shared handler and listener function fires twice", async () => {
		const mc = context();
		let calls = 0;
		const shared = (): void => {
			calls += 1;
		};
		mc.addEventListener("toolchange", shared);
		mc.ontoolchange = shared;
		await mc.registerTool({
			name: "life_shared",
			description: "handler",
			execute: async () => null,
		});
		// Direct registration would deduplicate the two into one call.
		await settleTasks();
		expect(calls).toBe(2);
		mc.ontoolchange = null;
		await mc.registerTool({
			name: "life_shared_two",
			description: "handler",
			execute: async () => null,
		});
		// Clearing the handler must not remove the explicit listener.
		await settleTasks();
		expect(calls).toBe(3);
		mc.removeEventListener("toolchange", shared);
		mc.ontoolchange = null;
	});
});

describe("secure context and policy gates", () => {
	it("stays inert on plaintext origins", () => {
		const win = new Window({ url: "http://example.com/" });
		try {
			expect(installModelContext(docOf(win))).toBeUndefined();
			expect(
				(win.document as unknown as Record<string, unknown>)["modelContext"],
			).toBeUndefined();
		} finally {
			void win.happyDOM?.close();
		}
	});

	it("installs on trustworthy origins", () => {
		const win = new Window({ url: "https://example.com/" });
		try {
			expect(installModelContext(docOf(win))).toBeDefined();
		} finally {
			void win.happyDOM?.close();
		}
	});

	it("honors an observable policy denial on install and calls", async () => {
		const win = new Window({ url: "https://example.com/" });
		try {
			denyTools(win);
			expect(installModelContext(docOf(win))).toBeUndefined();
			// The denial is scoped to that document: this one still works.
			const mc = context();
			await mc.registerTool({
				name: "life_policy_isolated",
				description: "policy",
				execute: async () => null,
			});
			expect(
				(await mc.getTools()).some(
					(item) => item.name === "life_policy_isolated",
				),
			).toBe(true);
		} finally {
			void win.happyDOM?.close();
		}
	});

	it("treats an unknown policy feature as allowed, not denied", async () => {
		const win = new Window({ url: "https://example.com/" });
		try {
			Object.defineProperty(win.document, "permissionsPolicy", {
				value: policyWith(
					() => false,
					() => ["camera"],
				),
				configurable: true,
			});
			const mc = installModelContext(docOf(win));
			if (mc === undefined) {
				throw new Error("expected an installed context");
			}
			await mc.registerTool({
				name: "life_policy_unknown",
				description: "policy",
				execute: async () => null,
			});
			expect(
				(await mc.getTools()).some(
					(item) => item.name === "life_policy_unknown",
				),
			).toBe(true);
		} finally {
			void win.happyDOM?.close();
		}
	});

	it("denies a recognized policy feature reported as disallowed", async () => {
		const win = new Window({ url: "https://example.com/" });
		try {
			Object.defineProperty(win.document, "permissionsPolicy", {
				value: policyWith(
					() => false,
					() => ["camera", "tools"],
				),
				configurable: true,
			});
			expect(installModelContext(docOf(win))).toBeUndefined();
		} finally {
			void win.happyDOM?.close();
		}
	});

	it("rejects every method on inactive documents", async () => {
		const detached = document.implementation.createHTMLDocument("detached");
		const mc = installModelContext(detached);
		if (mc === undefined) {
			throw new Error("expected an installed context");
		}
		expect(
			errorName(
				await errorOf(
					mc.registerTool({
						name: "x",
						description: "x",
						execute: async () => null,
					}),
				),
			),
		).toBe("InvalidStateError");
		expect(errorName(await errorOf(mc.getTools()))).toBe("InvalidStateError");
		expect(
			errorName(
				await errorOf(
					mc.executeTool(
						{
							name: "x",
							title: "",
							description: "x",
							window: window,
							origin: "https://example.com",
						},
						{},
					),
				),
			),
		).toBe("InvalidStateError");
	});
});

describe("agent cluster keying", () => {
	// The 2 October 2026 draft removed the origin-keyed agent cluster
	// precondition from registerTool, getTools and executeTool. A document
	// whose document.domain has drifted is therefore an ordinary document.
	it("registers, discovers and invokes a tool after document.domain drift", async () => {
		const win = new Window({ url: "https://www.example.com/" });
		try {
			const mc = installModelContext(docOf(win));
			if (mc === undefined) {
				throw new Error("expected an installed context");
			}
			// happy-dom exposes domain as getter-only: shadow it with an own
			// property to simulate a drifted document at the exact signal the
			// removed gate used to read. Real setter behaviour belongs to the
			// browser.
			Object.defineProperty(win.document, "domain", {
				value: "example.com",
				configurable: true,
			});

			await mc.registerTool({
				name: "drifted",
				description: "drifted",
				execute: async () => ({ ok: true }),
			});

			const tools = await mc.getTools();
			expect(tools.map((tool) => tool.name)).toEqual(["drifted"]);

			const tool = tools[0];
			if (tool === undefined) {
				throw new Error("expected the registered tool to be listed");
			}
			const result = await mc.executeTool(tool, {});
			expect(JSON.parse(result)).toEqual({ ok: true });
		} finally {
			void win.happyDOM?.close();
		}
	});
});

describe("install hardening", () => {
	it("ignores a pre-existing fake instead of trusting it", () => {
		const win = new Window({ url: "https://example.com/" });
		try {
			const doc = docOf(win);
			(doc as unknown as Record<string, unknown>).modelContext = {
				registerTool: async () => {
					throw new Error("fake");
				},
			};
			const mc = installModelContext(doc);
			if (mc === undefined) {
				throw new Error("expected an installed context");
			}
			expect(typeof mc.registerTool).toBe("function");
			expect((doc as unknown as Record<string, unknown>).modelContext).toBe(mc);
		} finally {
			void win.happyDOM?.close();
		}
	});
});

describe("trustworthy origins", () => {
	it("requires a full IPv4 loopback literal", async () => {
		const mc = context();
		for (const bad of [
			"http://127.0.0.1.evil.com",
			"http://127.evil",
			"http://127.0.0.300",
		]) {
			expect(
				errorName(
					await errorOf(
						mc.registerTool(
							{
								name: "loopback_bad",
								description: "bad",
								execute: async () => null,
							},
							{ exposedTo: [bad] },
						),
					),
				),
			).toBe("SecurityError");
		}
		await mc.registerTool(
			{
				name: "loopback_ok",
				description: "ok",
				execute: async () => null,
			},
			{ exposedTo: ["http://127.0.0.1:8080/"] },
		);
		expect(
			(await mc.getTools()).some((item) => item.name === "loopback_ok"),
		).toBe(true);
	});

	it("rejects non-string origin entries with TypeError", async () => {
		const mc = context();
		expect(
			errorName(
				await errorOf(
					mc.registerTool(
						{
							name: "loopback_type",
							description: "type",
							execute: async () => null,
						},
						{ exposedTo: [42 as unknown as string] },
					),
				),
			),
		).toBe("TypeError");
	});
});

describe("unloading cleanup", () => {
	// Cross-document unload branches (target destroyed completing false,
	// caller destroyed cancelling) need two real origins and run against real
	// Chromium in browser mode. Here: same-document unload removes silently
	// without settling, and leaves the registry intact.
	it("removes silently without settling or clearing tools", async () => {
		const mc = context();
		await mc.registerTool({
			name: "life_unload_idle",
			description: "unload",
			execute: (_input, options) =>
				new Promise<unknown>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => {
						reject(options.signal.reason);
					});
				}),
		});
		const tool = (await mc.getTools()).find(
			(item) => item.name === "life_unload_idle",
		);
		if (tool === undefined) {
			throw new Error("tool is not listed");
		}
		const controller = new AbortController();
		const pending = mc.executeTool(tool, {}, { signal: controller.signal });
		handleDocumentUnload(document);
		expect(
			(await mc.getTools()).some((item) => item.name === "life_unload_idle"),
		).toBe(true);
		controller.abort();
		expect(errorName(await errorOf(pending))).toBe("AbortError");
	});
});
