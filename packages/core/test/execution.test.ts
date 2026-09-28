// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ToolActivatedEvent, ToolCancelEvent } from "../src/events.js";
import type {
	ModelContext,
	RegisteredTool,
	ToolExecuteCallbackOptions,
} from "../src/index.js";
import { installModelContext } from "../src/index.js";

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
	const installed = (document as unknown as Record<string, unknown>)
		.modelContext as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

async function listedBy(
	mc: ModelContext,
	name: string,
): Promise<RegisteredTool> {
	const found = (await mc.getTools()).find((item) => item.name === name);
	if (found === undefined) {
		throw new Error(`tool ${name} is not listed`);
	}
	return found;
}

function windowOf(doc: Document): Window {
	const view = doc.defaultView;
	if (view === null) {
		throw new Error("document has no window");
	}
	return view;
}

// A caller-owned signal that counts listener attachment, so tests can prove
// the implementation detaches what it attaches.
function tappedSignal(): {
	signal: AbortSignal;
	abort: () => void;
	added: () => number;
	removed: () => number;
} {
	const controller = new AbortController();
	const signal = controller.signal;
	let added = 0;
	let removed = 0;
	const rawAdd = signal.addEventListener.bind(signal);
	const rawRemove = signal.removeEventListener.bind(signal);
	signal.addEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions | boolean,
	): void => {
		added += 1;
		rawAdd(type, listener, options);
	};
	signal.removeEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: EventListenerOptions | boolean,
	): void => {
		removed += 1;
		rawRemove(type, listener, options);
	};
	return {
		signal,
		abort: () => controller.abort(),
		added: () => added,
		removed: () => removed,
	};
}

describe("executeTool resolution", () => {
	it("resolves to the JSON string of the callback value", async () => {
		const mc = context();
		let seenArgs: unknown;
		let seenOptions: ToolExecuteCallbackOptions | undefined;
		await mc.registerTool({
			name: "exec_echo",
			description: "echo",
			execute: async (inputObject, options) => {
				seenArgs = inputObject;
				seenOptions = options;
				return { echoed: inputObject };
			},
		});
		const tool = await listedBy(mc, "exec_echo");
		const result = await mc.executeTool(tool, { q: "x" });
		expect(result).toBe(JSON.stringify({ echoed: { q: "x" } }));
		expect(seenArgs).toEqual({ q: "x" });
		expect(seenOptions?.signal instanceof AbortSignal).toBe(true);
		expect(seenOptions?.signal.aborted).toBe(false);
	});

	it("defaults omitted arguments to {} and rejects non-objects", async () => {
		const mc = context();
		let seen: unknown = "unset";
		await mc.registerTool({
			name: "exec_args",
			description: "args",
			execute: async (inputObject) => {
				seen = inputObject;
				return null;
			},
		});
		const tool = await listedBy(mc, "exec_args");
		// Omitted arguments default to {}. Upstream:
		// webmcp/imperative/object-arguments.https.html.
		expect(await mc.executeTool(tool)).toBe("null");
		expect(seen).toEqual({});
		expect(errorName(await errorOf(mc.executeTool(tool, "nope")))).toBe(
			"TypeError",
		);
		expect(errorName(await errorOf(mc.executeTool(tool, null)))).toBe(
			"TypeError",
		);
	});

	it("rejects circular arguments with the serializer error", async () => {
		const mc = context();
		const tool = await listedBy(mc, "exec_args");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(errorName(await errorOf(mc.executeTool(tool, circular)))).toBe(
			"TypeError",
		);
	});

	it("rejects callback failures and unserializable results", async () => {
		const mc = context();
		await mc.registerTool({
			name: "exec_throws",
			description: "throws",
			execute: async () => {
				throw new Error("boom");
			},
		});
		await mc.registerTool({
			name: "exec_bigint",
			description: "bigint",
			execute: async () => BigInt(1),
		});
		expect(
			errorName(
				await errorOf(mc.executeTool(await listedBy(mc, "exec_throws"), {})),
			),
		).toBe("UnknownError");
		expect(
			errorName(
				await errorOf(mc.executeTool(await listedBy(mc, "exec_bigint"), {})),
			),
		).toBe("UnknownError");
	});
});

describe("executeTool routing", () => {
	it("rejects missing tools with UnknownError", async () => {
		const mc = context();
		const ghost: RegisteredTool = {
			name: "exec_ghost",
			title: "",
			description: "ghost",
			window: windowOf(document),
			origin: document.location.origin,
		};
		expect(errorName(await errorOf(mc.executeTool(ghost, {})))).toBe(
			"UnknownError",
		);
	});

	it("rejects origin mismatches with UnknownError", async () => {
		const mc = context();
		await mc.registerTool({
			name: "exec_mismatch",
			description: "mismatch",
			execute: async () => null,
		});
		const tool = await listedBy(mc, "exec_mismatch");
		const tampered: RegisteredTool = {
			...tool,
			origin: "https://example.com",
		};
		expect(errorName(await errorOf(mc.executeTool(tampered, {})))).toBe(
			"UnknownError",
		);
	});

	it("rejects cross-hierarchy targets with UnknownError", async () => {
		const mc = context();
		const detached = document.implementation.createHTMLDocument("detached");
		const tool = await listedBy(mc, "exec_mismatch");
		// A bare { document } stand-in for a cross-hierarchy WindowProxy,
		// which happy-dom cannot provide with a distinct top document.
		const foreignWindow = { document: detached } as unknown as Window;
		const foreign: RegisteredTool = {
			...tool,
			window: foreignWindow,
		};
		expect(errorName(await errorOf(mc.executeTool(foreign, {})))).toBe(
			"UnknownError",
		);
	});

	it("rejects opaque origins with NotSupportedError", async () => {
		const mc = context();
		const tool = await listedBy(mc, "exec_mismatch");
		const opaque: RegisteredTool = { ...tool, origin: "null" };
		expect(errorName(await errorOf(mc.executeTool(opaque, {})))).toBe(
			"NotSupportedError",
		);
	});
});

describe("executeTool schema race", () => {
	it("re-validates against the current definition", async () => {
		const mc = context();
		const controller = new AbortController();
		await mc.registerTool(
			{
				name: "exec_race",
				description: "race",
				inputSchema: { type: "object", properties: { a: { type: "string" } } },
				execute: async (inputObject) => inputObject,
			},
			{ signal: controller.signal },
		);
		const stale = await listedBy(mc, "exec_race");
		controller.abort();
		await mc.registerTool({
			name: "exec_race",
			description: "race",
			inputSchema: { type: "object", properties: { a: { type: "number" } } },
			execute: async (inputObject) => inputObject,
		});
		expect(errorName(await errorOf(mc.executeTool(stale, { a: "x" })))).toBe(
			"UnknownError",
		);
		const fresh = await listedBy(mc, "exec_race");
		expect(await mc.executeTool(fresh, { a: 1 })).toBe(
			JSON.stringify({ a: 1 }),
		);
	});
});

describe("executeTool signal", () => {
	it("aborting one call rejects it without unregistering", async () => {
		const mc = context();
		const activated: string[] = [];
		const cancelled: string[] = [];
		mc.addEventListener("toolactivated", (event) => {
			if (event instanceof ToolActivatedEvent) {
				activated.push(event.toolName);
			}
		});
		mc.addEventListener("toolcancel", (event) => {
			if (event instanceof ToolCancelEvent) {
				cancelled.push(event.toolName);
			}
		});
		await mc.registerTool({
			name: "exec_slow",
			description: "slow",
			execute: (_inputObject, options) =>
				new Promise<unknown>((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => {
							reject(options.signal.reason);
						},
						{ once: true },
					);
				}),
		});
		const tool = await listedBy(mc, "exec_slow");
		const controller = new AbortController();
		const pending = mc.executeTool(tool, {}, { signal: controller.signal });
		controller.abort();
		expect(errorName(await errorOf(pending))).toBe("AbortError");
		expect(
			(await mc.getTools()).some((item) => item.name === "exec_slow"),
		).toBe(true);
		expect(activated).toContain("exec_slow");
		expect(cancelled).toContain("exec_slow");
	});

	it("pre-aborted execution signals reject with the reason", async () => {
		const mc = context();
		const tool = await listedBy(mc, "exec_slow");
		const controller = new AbortController();
		controller.abort();
		expect(
			errorName(
				await errorOf(mc.executeTool(tool, {}, { signal: controller.signal })),
			),
		).toBe("AbortError");
	});

	it("unregistering does not settle an in-flight call", async () => {
		const mc = context();
		const controller = new AbortController();
		await mc.registerTool(
			{
				name: "exec_inflight",
				description: "inflight",
				execute: async (inputObject) => inputObject,
			},
			{ signal: controller.signal },
		);
		const tool = await listedBy(mc, "exec_inflight");
		const pending = mc.executeTool(tool, { a: 1 });
		controller.abort();
		expect(await pending).toBe(JSON.stringify({ a: 1 }));
		expect(
			(await mc.getTools()).some((item) => item.name === "exec_inflight"),
		).toBe(false);
	});

	it("detaches the execution listener when the call settles", async () => {
		const mc = context();
		await mc.registerTool({
			name: "exec_cleanup",
			description: "cleanup",
			execute: async (inputObject) => inputObject,
		});
		const tool = await listedBy(mc, "exec_cleanup");
		const tap = tappedSignal();
		expect(await mc.executeTool(tool, { a: 1 }, { signal: tap.signal })).toBe(
			JSON.stringify({ a: 1 }),
		);
		expect(tap.added()).toBe(1);
		expect(tap.removed()).toBe(1);
		// A long-lived signal reused across calls must not accumulate.
		const shared = tappedSignal();
		for (let index = 0; index < 3; index += 1) {
			await mc.executeTool(tool, { a: index }, { signal: shared.signal });
		}
		expect(shared.added()).toBe(3);
		expect(shared.removed()).toBe(3);
	});
});
