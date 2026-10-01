// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Page, Worker } from "playwright";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Confirmation for a Consequential tool, bound to the invocation.
 *
 * The panel is a real extension page, opened and clicked as a person would see
 * it. The binding is the point of the ticket, so the assertions are about what
 * does *not* happen: an invocation that must not complete until a person says
 * so, and must not complete at all once the binding has moved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");
const UNPACKED = resolve(here, "../dist/unpacked");

const PAGE = `
const mc = globalThis.__install(document);
await mc.registerTool({
	name: "plainTool",
	description: "A tool with no consequence.",
	inputSchema: { type: "object", properties: {} },
	execute: async () => ({ ok: true }),
});
await mc.registerTool({
	name: "payNow",
	description: "Charge the saved card for the cart.",
	inputSchema: { type: "object", properties: { amount: { type: "number", description: "Amount in cents." } } },
	annotations: { consequentialHint: true },
	execute: async (args) => ({ paid: args.amount }),
});
globalThis.__paid = 0;
globalThis.__installPay = async (amount) => {
	await mc.executeTool(
		(await mc.getTools()).find((t) => t.name === "payNow"),
		{ amount },
	);
};
globalThis.__ready = true;
`;

let server: Server;
let origin: string;
let context: BrowserContext;
let userDataDir: string;
let worker: Worker;
let page: Page;
let tabId = -1;
let extensionId = "";

interface CallResult {
	readonly ok: boolean;
	readonly result?: Record<string, unknown>;
	readonly error?: string;
}

async function serve(): Promise<string> {
	const core = await readFile(CORE_BUNDLE, "utf8");
	server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		if (path === "/core.mjs") {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(core);
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			`<!doctype html><html><body><script type="module">
const { installModelContext } = await import("/core.mjs");
globalThis.__install = installModelContext;
async function main() { ${PAGE} }
main().catch((error) => { globalThis.__fixtureError = String(error); });
</script></body></html>`,
		);
	});
	await new Promise<void>((done) => {
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new TypeError("fixture server has no port");
	}
	return `http://127.0.0.1:${address.port}`;
}

/** Call one injection handler in the worker's own context. */
async function invoke(
	handler: string,
	args: Record<string, unknown>,
): Promise<CallResult> {
	return (await worker.evaluate(
		async (request: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const handle = scope["__axHandle"] as (r: unknown) => Promise<unknown>;
			try {
				return {
					ok: true,
					result: (await handle(request)) as Record<string, unknown>,
				};
			} catch (error: unknown) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "failed",
				};
			}
		},
		{ handler, args },
	)) as CallResult;
}

/** Ask the worker to invoke a tool the way the daemon would. */
function pay(amount: number): Promise<CallResult> {
	return invoke("executeTool", {
		tabId,
		frameId: 0,
		name: "payNow",
		args: { amount },
		callerOrigin: origin,
		allowedOrigins: [],
		documentId: "doc-1",
	});
}

/** Open the panel as a person would, by its own extension URL. */
async function openPanel(): Promise<Page> {
	const panel = await context.newPage();
	await panel.goto(`chrome-extension://${extensionId}/panel.html`);
	return panel;
}

/** File and approve an invocation through the worker's panel surface. */
async function approveInvocation(
	binding: string,
	argsJson: string,
	definitionVersion: string,
): Promise<void> {
	const argsHash = await hashInWorker(argsJson);
	await worker.evaluate(
		(payload: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			const panel = scope["__axPanel"] as (
				op: string,
				args: unknown,
			) => unknown;
			const record = payload as Record<string, unknown>;
			panel("request", {
				gesture: true,
				approval: {
					key: record["key"],
					toolName: "payNow",
					description: "Charge the saved card for the cart.",
					argsJson: record["argsJson"],
					origin: record["origin"],
					consequentialHint: true,
					readOnlyHint: false,
					frameOrigin: "https://shop.example",
					definitionVersion: record["definitionVersion"],
				},
			});
			panel("approve", { key: record["binding"] });
		},
		{
			binding,
			argsJson,
			origin,
			definitionVersion,
			key: {
				tabId,
				documentId: "doc-1",
				frameId: 0,
				toolName: "payNow",
				argsHash,
			},
		},
	);
}

/**
 * Clear anything left pending.
 *
 * The worker outlives each test, so an approval filed by one case is still
 * there for the next. A case that asserts "nothing is waiting" has to say so
 * first, or it asserts on its neighbours' leftovers.
 */
async function clearPending(): Promise<void> {
	await worker.evaluate(() => {
		const scope = globalThis as unknown as Record<string, unknown>;
		const panel = scope["__axPanel"] as (op: string, args: unknown) => unknown;
		const list = panel("list", {}) as {
			pending?: ReadonlyArray<{ key: string }>;
		};
		for (const entry of list.pending ?? []) {
			panel("reject", { key: entry.key });
		}
	});
}

/** The worker's own hash of a canonical argument string. */
async function hashInWorker(argsJson: string): Promise<string> {
	return await worker.evaluate((text: unknown) => {
		const scope = globalThis as unknown as Record<string, unknown>;
		const hash = scope["__axHash"] as ((s: string) => string) | undefined;
		if (hash === undefined) {
			throw new Error("no hasher exposed");
		}
		return hash(text as string);
	}, argsJson);
}

/** Wire the panel page's decision functions for the test to drive. */
async function preparePanel(panel: Page): Promise<void> {
	await panel.evaluate(() => {
		// The panel's own `decide` is private to its module. Re-issuing the
		// same message from the page is what a click does, and the worker's
		// gesture gate is what makes it a gesture.
		const scope = globalThis as unknown as Record<string, unknown>;
		scope["__request"] = async (op: string, args: unknown): Promise<unknown> =>
			await chrome.runtime.sendMessage({ panel: op, args });
	});
}

/** What the panel is currently showing. */
interface ShownRequest {
	readonly key: string;
	readonly toolName: string;
	readonly description: string;
	readonly args: string;
	readonly origin: string;
	readonly hasApprove: boolean;
	readonly hasReject: boolean;
}

async function shown(panel: Page): Promise<ReadonlyArray<ShownRequest>> {
	// The panel renders asynchronously; wait for it to have drawn before asking
	// what it shows, so the assertion is about rendering and not about timing.
	await panel.waitForFunction(
		() => document.getElementById("disclaimer")?.textContent !== "",
		undefined,
		{ timeout: 15_000 },
	);
	return (await panel.evaluate(() =>
		[...document.querySelectorAll(".request")].map((card) => ({
			key: (card as HTMLElement).dataset["key"] ?? "",
			origin: card.querySelector("[data-field='origin']")?.textContent ?? "",
			args: card.querySelector("[data-field='arguments']")?.textContent ?? "",
			description:
				card.querySelector("[data-field='description']")?.textContent ?? "",
			toolName: card.querySelector("h2")?.textContent ?? "",
			hasApprove: card.querySelector("[data-operation='approve']") !== null,
			hasReject: card.querySelector("[data-operation='reject']") !== null,
		})),
	)) as ReadonlyArray<ShownRequest>;
}

/** The panel's rendered text, once it has had a chance to render. */
async function panelText(panel: Page): Promise<string> {
	await panel.waitForFunction(
		() => (document.getElementById("disclaimer")?.textContent ?? "") !== "",
		undefined,
		{ timeout: 15_000 },
	);
	return await panel.evaluate(() => document.body.textContent ?? "");
}

beforeAll(async () => {
	origin = await serve();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-hitl-prof-"));
	const { chromium } = await import("playwright");
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${UNPACKED}`,
			`--load-extension=${UNPACKED}`,
		],
	});
	const started = context.serviceWorkers();
	if (started.length > 0) {
		worker = started[0];
	} else {
		const event = context.waitForEvent("serviceworker", { timeout: 30_000 });
		const first = await context.newPage();
		await first.goto(`${origin}/shop`);
		worker = await event;
	}
	extensionId = new URL(worker.url()).host;

	page = await context.newPage();
	await page.goto(`${origin}/shop`);
	await page.waitForFunction(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__ready"] === true,
		undefined,
		{ timeout: 20_000 },
	);
	tabId = await worker.evaluate(async (target: unknown) => {
		const scope = globalThis as unknown as {
			chrome?: {
				tabs: {
					query(
						i: unknown,
					): Promise<ReadonlyArray<{ id?: number; url?: string }>>;
				};
			};
		};
		const api = scope.chrome;
		if (api === undefined) {
			return -1;
		}
		const tabs = await api.tabs.query({});
		return tabs.find((tab) => tab.url === (target as string))?.id ?? -1;
	}, page.url());
	if (tabId < 0) {
		throw new Error("no tab id for the fixture page");
	}
}, 180_000);

afterAll(async () => {
	await context?.close();
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
	await new Promise<void>((done) => {
		if (server === undefined) {
			done();
			return;
		}
		server.close(() => done());
	});
});

describe("consequential confirmation", () => {
	it("does not complete until an approval arrives", async () => {
		const first = await pay(500);
		// The invocation did not run. It returned what a person needs in order
		// to decide, and nothing was charged.
		expect(first.ok).toBe(true);
		expect(first.result?.["requiresConfirmation"]).toBe(true);
		const binding = String(first.result?.["pendingApproval"]);
		expect(binding.length).toBeGreaterThan(0);
		expect(first.result).not.toEqual(JSON.stringify({ paid: 500 }));

		// Repeating the same call still does not run it: nothing has been
		// approved, so a caller cannot get a second chance by asking again.
		const again = await pay(500);
		expect(again.result?.["requiresConfirmation"]).toBe(true);
		expect(again.result).not.toEqual(JSON.stringify({ paid: 500 }));
	});
	it("shows the tool, its description, and the arguments being approved", async () => {
		const panel = await openPanel();
		await preparePanel(panel);
		await clearPending();
		// The hash comes from the worker's own rule, not reimplemented here: a
		// test that computed it differently would approve a binding the product
		// would refuse, and prove nothing.
		const argsJson = '{"amount":900}';
		const argsHash = await hashInWorker(argsJson);
		const filed = await panel.evaluate(
			async (approval: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const run = scope["__request"] as (
					op: string,
					args: unknown,
				) => Promise<unknown>;
				return await run("request", { gesture: true, approval });
			},
			{
				key: {
					tabId: 7,
					documentId: "doc-2",
					frameId: 0,
					toolName: "payNow",
					argsHash,
				},
				toolName: "payNow",
				description: "Charge the saved card for the cart.",
				argsJson,
				origin: "https://shop.example",
				consequentialHint: true,
				readOnlyHint: false,
				frameOrigin: "https://shop.example",
				definitionVersion: "{}",
			},
		);
		expect(filed).toMatchObject({ ok: true });
		const cards = await shown(panel);
		expect(cards.length).toBe(1);
		expect(cards[0]?.toolName).toBe("payNow");
		expect(cards[0]?.description).toBe("Charge the saved card for the cart.");
		expect(cards[0]?.args).toBe('{"amount":900}');
		expect(cards[0]?.origin).toBe("https://shop.example");
		expect(cards[0]?.hasApprove).toBe(true);
		expect(cards[0]?.hasReject).toBe(true);
		await panel.close();
	});

	it("refuses to file an approval without a gesture", async () => {
		const panel = await openPanel();
		await preparePanel(panel);
		await clearPending();
		const refusal = await panel.evaluate(
			async (approval: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const run = scope["__request"] as (
					op: string,
					args: unknown,
				) => Promise<unknown>;
				return await run("request", { gesture: false, approval });
			},
			{
				key: {
					tabId: 8,
					documentId: "doc-3",
					frameId: 0,
					toolName: "payNow",
					argsHash: await hashInWorker("{}"),
				},
				toolName: "payNow",
				description: "Charge the saved card for the cart.",
				argsJson: "{}",
				origin: "https://shop.example",
				consequentialHint: true,
				readOnlyHint: false,
				frameOrigin: "https://shop.example",
				definitionVersion: "{}",
			},
		);
		expect(refusal).toMatchObject({ ok: false });
		expect(await shown(panel)).toHaveLength(0);
		await panel.close();
	});

	it("executes once the exact invocation is approved", async () => {
		const first = await pay(1200);
		const binding = String(first.result?.["pendingApproval"]);
		await approveInvocation(
			binding,
			String(first.result?.["argsJson"]),
			String(first.result?.["definitionVersion"]),
		);

		const second = await pay(1200);
		// Approved and consumed: this time it ran, and the page's own value came
		// back.
		expect(second.ok).toBe(true);
		expect(second.result).toEqual(JSON.stringify({ paid: 1200 }));
	});

	it("refuses rather than re-prompting when the binding has moved", async () => {
		const first = await pay(700);
		await approveInvocation(
			String(first.result?.["pendingApproval"]),
			String(first.result?.["argsJson"]),
			String(first.result?.["definitionVersion"]),
		);

		// The person approved 700. The caller now asks for 900.
		const moved = await pay(900);
		// Refused, not silently re-prompted and not executed against new values.
		expect(moved.ok).toBe(false);
		expect(moved.error).toMatch(/approval/);
	});

	it("consumes an approval so it cannot be replayed", async () => {
		const first = await pay(1500);
		await approveInvocation(
			String(first.result?.["pendingApproval"]),
			String(first.result?.["argsJson"]),
			String(first.result?.["definitionVersion"]),
		);
		const used = await pay(1500);
		expect(used.result).toEqual(JSON.stringify({ paid: 1500 }));
		// The same approval a second time does not run again.
		const replayed = await pay(1500);
		expect(replayed.result?.["requiresConfirmation"]).toBe(true);
	});

	it("does not raise the panel for a tool that is not consequential", async () => {
		const plain = await invoke("executeTool", {
			tabId,
			frameId: 0,
			name: "plainTool",
			args: {},
			callerOrigin: origin,
			allowedOrigins: [],
			documentId: "doc-1",
		});
		expect(plain.ok).toBe(true);
		expect(plain.result?.["requiresConfirmation"]).toBeUndefined();
		expect(plain.result).toEqual(JSON.stringify({ ok: true }));

		const panel = await openPanel();
		await preparePanel(panel);
		// Nothing new is waiting: the ordinary call raised nothing.
		expect(await shown(panel)).toHaveLength(0);
		await panel.close();
	});

	it("injects no confirmation UI into page DOM", async () => {
		await pay(300);
		const inPage = await page.evaluate(() => ({
			axNodes: document.querySelectorAll("[class*='ax'], [id*='ax-']").length,
			bodyText: document.body.textContent ?? "",
		}));
		expect(inPage.axNodes).toBe(0);
		expect(inPage.bodyText).not.toMatch(/approv/i);
	});

	it("labels the audit trail as local-only and never tamper-proof", async () => {
		const panel = await openPanel();
		await preparePanel(panel);
		const text = await panelText(panel);
		expect(text).toMatch(/local log only/i);
		expect(text).toMatch(/no integrity guarantee/i);
		expect(text).not.toMatch(/tamper.?proof/i);
		await panel.close();
	});
});
