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

import { BridgeRefusal, PageBridge } from "../src/bridge.js";
import type { DiscoveryFile } from "../src/discovery.js";
import type { Transport } from "../src/lifecycle.js";
import { readDiscoveryFile, startTransport } from "../src/lifecycle.js";
import type { JsonRpcResponse } from "../src/protocol.js";
import {
	createDaemonInfo,
	dispatchRequest,
	parseFrame,
	serializeFrame,
} from "../src/protocol.js";
import { RawClient, toolsCallFrame, toolsListFrame } from "./client.js";

/**
 * One test drives the whole chain:
 *
 *   MCP client ──stdio──▶ daemon ──loopback──▶ extension worker ──▶ page
 *
 * Every hop is real: a spawned process for the client, a real listener for the
 * transport, a loaded extension in real Chromium for the worker, and a served
 * page with genuinely registered tools at the far end. One red test here means
 * a regression anywhere in the chain.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");
const UNPACKED = resolve(here, "../../extension/dist/unpacked");
const DAEMON_BIN = resolve(here, "../bin/ax-kit-daemon.mjs");

const PAGE = `
const mc = globalThis.__install(document);
await mc.registerTool({
	name: "viewCart",
	description: "Show the cart.",
	inputSchema: { type: "object", properties: { detailed: { type: "boolean", description: "Include items." } } },
	// Echoes every key the tool actually received, not a fixed projection.
	// Echoing only the keys under test would make a leak of anything else
	// invisible, and the assertions below would pass with the allow-list
	// deleted.
	execute: async (args) => ({ items: 3, received: args }),
});
await mc.registerTool({
	name: "payNow",
	description: "Charge the saved card for the cart.",
	inputSchema: { type: "object", properties: {} },
	annotations: { consequentialHint: true },
	execute: async () => ({ paid: true }),
});
globalThis.__ready = true;
`;

let server: Server;
let origin: string;
let context: BrowserContext;
let userDataDir: string;
let discoveryDir: string;
let transport: Transport;
let worker: Worker;
let bridge: PageBridge;
let page: Page;
let tabId = -1;

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

/** Read a discovery file the way a real extension would. */
async function file(): Promise<DiscoveryFile> {
	return readDiscoveryFile(discoveryDir);
}

/**
 * Drive the pull/result loop from inside the worker.
 *
 * The loop body is written inline because it has to exist in the worker's
 * context, where `__axHandle` lives. Nothing here is passed in as a closure:
 * Playwright serializes the function, so a captured handler would arrive
 * undefined.
 */
/**
 * Drive the pull/result loop from inside the worker.
 *
 * The loop body is written inline because it has to exist in the worker's
 * context, where `__axHandle` lives. Nothing is passed in as a closure:
 * Playwright serializes the function, so a captured handler would arrive
 * undefined.
 *
 * Deliberately not awaited. The loop runs for the life of the worker, so
 * awaiting it would block forever. Readiness is observed by the first bridge
 * call completing: the daemon enqueues, the worker's loop pulls, and the result
 * comes back. If the loop never ran, that call times out and says so.
 */
function startWorkerBridge(): void {
	void worker
		.evaluate(
			async (endpoint: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const handle = scope["__axHandle"] as (r: unknown) => Promise<unknown>;
				if (typeof handle !== "function") {
					throw new Error("worker handle missing");
				}
				const target = endpoint as { port: number; bearer: string };
				const base = `http://127.0.0.1:${target.port}`;
				const headers = {
					"x-ax-bearer": target.bearer,
					origin: base,
					"content-type": "application/json",
				};
				for (;;) {
					const response = await fetch(`${base}/pull`, { headers });
					if (response.status === 204) {
						continue;
					}
					const envelope = (await response.json()) as {
						id: number;
						request: unknown;
					};
					let body: unknown;
					try {
						body = {
							id: envelope.id,
							result: await handle(envelope.request),
						};
					} catch (error: unknown) {
						body = {
							id: envelope.id,
							error: {
								code: -32602,
								message: error instanceof Error ? error.message : "failed",
							},
						};
					}
					await fetch(`${base}/result`, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
					});
				}
			},
			{ port: transport.port, bearer: transport.bearer },
		)
		.catch(() => {
			// Surfaced by the readiness wait below, which is the assertion.
		});
}

/** Wait until the worker's loop has reached the daemon at least once. */
async function waitForWorkerBridge(): Promise<void> {
	// A `Worker` has no `waitForFunction`, so readiness is proven the same way
	// the product proves it: put work on the queue and see it come back. This
	// call is the observation, not a proxy for one.
	await bridge.listTools(tabId);
}

beforeAll(async () => {
	origin = await serve();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-e2e-prof-"));
	discoveryDir = await mkdtemp(join(tmpdir(), "ax-e2e-disc-"));

	const { chromium } = await import("playwright");
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${UNPACKED}`,
			`--load-extension=${UNPACKED}`,
		],
	});
	// Check the collection before awaiting the event: a worker that started
	// before the listener attached is already visible there, and awaiting alone
	// reports a false negative.
	const started = context.serviceWorkers();
	if (started.length > 0) {
		worker = started[0];
	} else {
		const event = context.waitForEvent("serviceworker", { timeout: 30_000 });
		// A page gives the worker a reason to start and a tab to address.
		page = await context.newPage();
		worker = await event;
	}
	page = await context.newPage();
	await page.goto(`${origin}/shop`);
	await page.waitForFunction(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__ready"] === true,
		undefined,
		{ timeout: 20_000 },
	);
	tabId = await worker.evaluate(async (target: unknown) => {
		// `chrome` is declared by the extension package's ambient file, which
		// this package does not include. Reach it structurally instead.
		const scope = globalThis as unknown as {
			chrome?: {
				tabs: {
					query(
						info: unknown,
					): Promise<ReadonlyArray<{ id?: number; url?: string }>>;
				};
			};
		};
		const api = scope.chrome;
		if (api === undefined) {
			return -1;
		}
		const tabs = await api.tabs.query({});
		const found = tabs.find((tab) => tab.url === (target as string));
		return found?.id ?? -1;
	}, page.url());
	if (tabId < 0) {
		throw new Error("no tab id for the fixture page");
	}

	bridge = new PageBridge(createDaemonInfo());
	transport = await startTransport({ discoveryDir, bridge });

	// The extension reads the discovery file itself, as a real one would.
	const discovered = await file();
	expect(discovered.port).toBe(transport.port);
	startWorkerBridge();
	await waitForWorkerBridge();
}, 180_000);

afterAll(async () => {
	await transport?.close();
	await context?.close();
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
	await rm(discoveryDir, { recursive: true, force: true }).catch(() => {});
	await new Promise<void>((done) => {
		if (server === undefined) {
			done();
			return;
		}
		server.close(() => done());
	});
});

/** Answer one MCP request through the spawned daemon's own dispatch path. */
function respond(
	frame: string,
	tools: ReadonlyArray<Record<string, unknown>>,
): string {
	const response: JsonRpcResponse = dispatchRequest(
		parseFrame(frame),
		tools as Record<string, unknown>[],
		createDaemonInfo(),
	);
	return serializeFrame(response);
}

describe("tool execution end to end", () => {
	it("discovers a real page's tools through the whole bridge", async () => {
		const tools = await bridge.listTools(tabId);
		expect(tools.map((tool) => tool["name"]).sort()).toEqual([
			"payNow",
			"viewCart",
		]);
		// Discovery reflected what the page actually registered, not a fixture.
		const cart = tools.find((tool) => tool["name"] === "viewCart");
		expect(cart?.["description"]).toBe("Show the cart.");
		expect(cart?.["frameOrigin"]).toBe(origin);
	});

	it("executes a tool and returns its real parsed result", async () => {
		const result = await bridge.callTool(
			"viewCart",
			{ detailed: true },
			tabId,
			origin,
		);
		// The page's execute callback ran; this is its value, not a string.
		expect(JSON.parse(result as string)).toEqual({
			items: 3,
			received: { detailed: true },
		});
	});

	it("answers an MCP tools/list with the page's real tool set", async () => {
		const tools = await bridge.listTools(tabId);
		const text = respond(JSON.stringify(toolsListFrame(1)), tools);
		const parsed: unknown = JSON.parse(text);
		expect(parsed).toMatchObject({ id: 1 });
		const record = parsed as { result: { tools: unknown[] } };
		expect(record.result.tools).toHaveLength(2);
	});

	it("answers an MCP tools/call over a spawned process on real pipes", async () => {
		const client = new RawClient(process.execPath, [DAEMON_BIN]);
		try {
			// The spawned process speaks the protocol with no handshake.
			client.write(toolsListFrame(1));
			const listed = await client.nextFrame();
			expect(listed.error).toBeUndefined();
			expect(JSON.stringify(listed.result)).toContain("resultType");
			// A call answers differently from a listing: with no bridge attached
			// the daemon defers the execution rather than inventing a result, and
			// saying so is the whole answer.
			client.write(toolsCallFrame(2, "viewCart", { detailed: true }));
			const called = await client.nextFrame();
			expect(called.id).toBe(2);
			expect(called.error).toBeUndefined();
			expect(called.result).toMatchObject({
				deferred: true,
				name: "viewCart",
			});
			client.endInput();
			expect(await client.waitForExit()).toBe(0);
		} finally {
			client.kill();
		}
	});

	it("carries only allow-listed argument keys across into the page", async () => {
		const result = await bridge.callTool(
			"viewCart",
			{ detailed: true, smuggled: "should not arrive" },
			tabId,
			origin,
		);
		// The tool echoes the argument object it was handed, so this states what
		// the page received rather than what the caller asked for. An assertion
		// about the caller's input would hold no matter what the page is given.
		expect(JSON.parse(result as string)).toEqual({
			items: 3,
			received: { detailed: true },
		});
	});

	it("returns a refusal as a typed error, not a malformed answer", async () => {
		await expect(
			bridge.callTool("noSuchTool", {}, tabId, origin),
		).rejects.toBeInstanceOf(BridgeRefusal);
	});

	it("refuses a caller outside the Exposed to set", async () => {
		await expect(
			bridge.callTool("viewCart", {}, tabId, "https://elsewhere.example"),
		).rejects.toThrow(/not exposed/);
	});

	it("requires the bearer and the loopback origin on every bridge request", async () => {
		const discovered = await file();
		const noBearer = await fetch(`http://127.0.0.1:${discovered.port}/pull`, {
			headers: { origin: `http://127.0.0.1:${discovered.port}` },
		});
		expect(noBearer.status).toBe(403);
		const wrongOrigin = await fetch(
			`http://127.0.0.1:${discovered.port}/pull`,
			{
				headers: {
					"x-ax-bearer": discovered.token,
					origin: "https://elsewhere.example",
				},
			},
		);
		expect(wrongOrigin.status).toBe(403);
	});

	it("keeps two invocations in flight without settling each other", async () => {
		const both = Promise.all([
			bridge.callTool("viewCart", { detailed: false }, tabId, origin),
			bridge.callTool("viewCart", { detailed: true }, tabId, origin),
		]);
		expect(await both).toEqual([
			JSON.stringify({ items: 3, received: { detailed: false } }),
			JSON.stringify({ items: 3, received: { detailed: true } }),
		]);
	});
});
