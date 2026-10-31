// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, CDPSession, Page } from "playwright";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The service worker terminated while a call is in flight.
 *
 * This is the one property the whole bridge is built on: a worker's lifetime
 * does not bound a call's lifetime. Everything else in the package takes that on
 * trust, so it is asserted here against a browser that really stops the worker.
 *
 * **The kill is real, and it is proved from the outside.** Not "the worker went
 * away": `ServiceWorker.stopWorker` is sent over the debugger protocol and the
 * test then waits for Chromium itself to report `runningStatus: "stopped"` for
 * this extension's worker. A backgrounded worker never reports that. The API
 * was read out of the installed Playwright's own protocol types rather than from
 * memory, and the version that ships here reaches it on a *page* session — the
 * browser-level session has no `ServiceWorker` domain, which cost one probe to
 * discover.
 *
 * **Three placements, not one.** The page gates the call at three points and
 * the worker is stopped at each. One well-timed kill can pass by luck; three
 * cannot, and the three are the three places the answer could plausibly go
 * wrong — before anything has executed, while the tool is running, and after
 * the page holds a value the worker has not been told.
 *
 * **The gates are the page's own, and there is no sleep anywhere.** The page
 * arms one point, the call runs to it and stops there, and the test kills the
 * worker from that observation. Timing is established by an event, never waited
 * on.
 *
 * **What this process holds, and what it does not.** The test process plays the
 * daemon: it holds the envelope the client issued, hands it to a worker, and
 * still holds it when the worker dies. That stand-in is load-bearing and is
 * called out rather than hidden — `PageBridge.take()` shifts the envelope out of
 * its queue the moment it is dispatched, so the *real* daemon does **not** hold
 * a dispatched call and never offers it to another worker. Run against
 * `PageBridge`, this file's fourth acceptance fails; that is a finding in the
 * daemon rather than something to route around. Nothing here retries a call on
 * the client side, because a retry would be a second execution of work that may
 * already have run.
 *
 * **Why the worker is driven over `chrome.runtime.sendMessage` and not through
 * the relay.** Attaching the real `serveRelay` loop needs a registered native
 * messaging host, which on Windows is a registry key. That key is
 * `com.openax.axkit` — the same one `chain-native-host.test.ts` in the daemon
 * writes and deletes — so two suites registering it concurrently would unregister
 * each other's host and fail for a reason that has nothing to do with the code.
 * `chrome.runtime.sendMessage` is the other real channel into the worker, the
 * panel's own, and it reaches the same `handle` the relay reaches: the Trusted
 * tier is exercised and the native rendezvous is not.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = resolve(here, "../../core/dist/index.mjs");
const UNPACKED = resolve(here, "../dist/unpacked");

/**
 * The three points a call can be interrupted at.
 *
 * Named for where the worker is, not for where the page is. `before-execute` is
 * a worker holding a request it has not acted on; `during-execute` is the tool
 * running; `after-execute` is a value that exists inside the page and has not
 * reached the worker, which is the window a naive "did it run?" check would
 * call a success.
 *
 * The third point is also why no client retry is the fix. A tool interrupted
 * after its page-side effect has already happened may run twice on recovery,
 * and nothing at this seam can tell the two apart. What the extension can do —
 * and what is asserted — is refuse to claim a result it never received.
 */
const POINTS = ["before-execute", "during-execute", "after-execute"] as const;

type Point = (typeof POINTS)[number];

const PAGE = `
const mc = globalThis.__install(document);
let armed = null;
const releases = new Map();
globalThis.__stage = "";
globalThis.__arm = (point) => { armed = point; };
globalThis.__releaseAll = () => {
  for (const [, open] of [...releases]) { open(); }
  releases.clear();
};
/**
 * Suspend at one named point, once. Returns null everywhere else, so the
 * wrappers stay transparent rather than re-ordering the page's own work.
 */
function hold(point) {
  if (armed !== point) { return null; }
  armed = null;
  globalThis.__stage = point;
  return new Promise((resolve) => { releases.set(point, resolve); });
}
const nativeGetTools = mc.getTools.bind(mc);
mc.getTools = async () => {
  const gate = hold("before-execute");
  if (gate !== null) { await gate; }
  return await nativeGetTools();
};
const nativeExecuteTool = mc.executeTool.bind(mc);
mc.executeTool = async (tool, args) => {
  const out = await nativeExecuteTool(tool, args);
  const gate = hold("after-execute");
  if (gate !== null) { await gate; }
  return out;
};
await mc.registerTool({
  name: "viewCart",
  description: "Show the cart.",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    const gate = hold("during-execute");
    if (gate !== null) { await gate; }
    return { items: 3 };
  },
});
await mc.registerTool({
  name: "payNow",
  description: "Charge the saved card for the cart.",
  inputSchema: { type: "object", properties: { amount: { type: "number" } } },
  annotations: { consequentialHint: true },
  execute: async (args) => {
    const gate = hold("during-execute");
    if (gate !== null) { await gate; }
    return { paid: args.amount };
  },
});
globalThis.__ready = true;
`;

let server: Server;
let origin: string;
let context: BrowserContext;
let userDataDir: string;
let page: Page;
let cdp: CDPSession;
let driver: Page;
let tabId = -1;
let extensionId = "";

/**
 * This worker's running status, as the browser reports it.
 *
 * Read from the debugger protocol's own event rather than inferred from whether
 * an evaluate happened to throw, because a handle that outlives a restart looks
 * exactly like one that never died. `stopped` is the proof of termination, and
 * it is also what makes the next reply a new realm's: a stopped worker cannot
 * answer anything.
 */
let versionId: string | null = null;
let latestStatus: string | null = null;
const statusHistory: string[] = [];
const statusWaiters: Array<{
	readonly want: string;
	readonly done: (status: string) => void;
}> = [];

/**
 * Wait for the browser to report this status.
 *
 * No timeout of its own. The test's own budget is the bound, and a wait that
 * never resolves has to fail loudly rather than be rescued by a delay.
 */
function waitForStatus(want: string): Promise<string> {
	if (latestStatus === want) {
		return Promise.resolve(want);
	}
	return new Promise<string>((done) => {
		statusWaiters.push({ want, done });
	});
}

/**
 * One call the client issued, and everything known about what happened to it.
 *
 * The id never changes, which is how the assertions can tell a re-pull of the
 * same work from a fresh call: a retry would carry a new id, and a retry is
 * exactly what must not happen here.
 */
interface HeldWork {
	readonly id: number;
	readonly request: Record<string, unknown>;
	/** The worker that handed back a reply, or null while nobody has. */
	completedBy: string | null;
	/** Every reply received, in order. */
	readonly results: Array<{ readonly by: string; readonly reply: unknown }>;
}

/**
 * One delivery's outcome.
 *
 * `ok` is the platform's answer, not this test's: when the worker dies holding
 * an open response the message channel closes and the send rejects. Turning
 * that into a value is the point, because the *caller* is what is under test —
 * a call that cannot be answered must be a refusal, never a tool result.
 */
interface Delivery {
	readonly ok: boolean;
	readonly reply?: unknown;
	readonly refusal?: string;
}

let nextCallId = 1;
let held: HeldWork | null = null;
let clientCalls = 0;

/** Issue a call from the client. The one thing that creates new work. */
function issueCall(request: Record<string, unknown>): HeldWork {
	clientCalls += 1;
	const work: HeldWork = {
		id: nextCallId,
		request,
		completedBy: null,
		results: [],
	};
	held = work;
	nextCallId += 1;
	return work;
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

/**
 * Open an extension page and use it as the caller's side of the channel.
 *
 * A fresh page rather than the one the last delivery used, so nothing cached in
 * a page from the dead realm can answer for the new one. Loading it is also
 * what brings the worker back: the panel asks it for the pending approvals as
 * soon as it runs.
 */
async function openDriver(): Promise<Page> {
	const opened = await context.newPage();
	await opened.goto(`chrome-extension://${extensionId}/panel.html`);
	return opened;
}

async function revive(): Promise<void> {
	await driver.close().catch(() => {});
	driver = await openDriver();
}

/** Send one request to whichever worker the browser has running. */
async function ask(message: Record<string, unknown>): Promise<Delivery> {
	try {
		const reply: unknown = await driver.evaluate(
			(m: unknown) => chrome.runtime.sendMessage(m),
			message,
		);
		return { ok: true, reply };
	} catch (error: unknown) {
		return {
			ok: false,
			refusal:
				error instanceof Error ? error.message : "the message channel closed",
		};
	}
}

/**
 * Hand held work to a worker.
 *
 * The envelope handed over is the one the client issued, unchanged. Recording
 * who answered is how a recovery is told apart from a retry: a second call
 * would arrive with a different id and would be a second execution.
 */
async function deliver(work: HeldWork, label: string): Promise<Delivery> {
	const outcome = await ask(work.request);
	if (outcome.ok) {
		work.results.push({ by: label, reply: outcome.reply });
		work.completedBy = label;
	}
	return outcome;
}

/** Arm one interruption point on the page, releasing anything still held. */
async function arm(point: Point): Promise<void> {
	await page.evaluate((want: string) => {
		const scope = globalThis as unknown as {
			__arm: (value: string) => void;
			__releaseAll: () => void;
			__stage: string;
		};
		scope.__releaseAll();
		scope.__stage = "";
		scope.__arm(want);
	}, point);
}

async function release(): Promise<void> {
	await page.evaluate(() => {
		const scope = globalThis as unknown as { __releaseAll: () => void };
		scope.__releaseAll();
	});
}

/** Wait for the page to reach the armed point. The observation, not a delay. */
async function reached(point: Point): Promise<void> {
	await page.waitForFunction(
		(want: string) => {
			const scope = globalThis as unknown as { __stage: string };
			return scope.__stage === want;
		},
		point,
		{ timeout: 90_000 },
	);
}

/**
 * Stop the worker and wait for the browser to say it is stopped.
 *
 * Only `stopped` is waited for here. Coming back is the browser's decision, not
 * this test's, and it will not happen until something needs the worker again —
 * so waiting for it before anything asks would be waiting on a corpse.
 */
async function stopTheWorker(): Promise<void> {
	if (versionId === null) {
		throw new Error("the browser never reported this extension's worker");
	}
	await cdp.send("ServiceWorker.stopWorker", { versionId });
	await waitForStatus("stopped");
}

/** One pending approval, read out of a reply the browser delivered. */
function pendingFrom(reply: unknown): ReadonlyArray<Record<string, unknown>> {
	if (typeof reply !== "object" || reply === null) {
		return [];
	}
	const outer = reply as Record<string, unknown>;
	if (outer.ok !== true) {
		return [];
	}
	const result = outer.result;
	if (typeof result !== "object" || result === null) {
		return [];
	}
	const pending = (result as Record<string, unknown>).pending;
	if (!Array.isArray(pending)) {
		return [];
	}
	const found: Array<Record<string, unknown>> = [];
	for (const entry of pending) {
		if (typeof entry === "object" && entry !== null) {
			found.push(entry as Record<string, unknown>);
		}
	}
	return found;
}

/** The confirmation body a filed call hands back, or an empty record. */
function confirmationOf(reply: unknown): Record<string, unknown> {
	if (typeof reply !== "object" || reply === null) {
		return {};
	}
	const outer = reply as Record<string, unknown>;
	if (outer.ok !== true) {
		return {};
	}
	const result = outer.result;
	return typeof result === "object" && result !== null
		? (result as Record<string, unknown>)
		: {};
}

/** Answer a filed confirmation the way the panel's own Approve button does. */
async function approve(binding: string): Promise<void> {
	const listed = await ask({ panel: "list", args: {} });
	expect(listed.ok).toBe(true);
	const entry = pendingFrom(listed.reply).find(
		(candidate) => candidate.key === binding,
	);
	const version = entry?.definitionVersion;
	expect(typeof version, "the pending card a person would be reading").toBe(
		"string",
	);
	const approved = await ask({
		panel: "approve",
		args: { key: binding, definitionVersion: version },
	});
	expect(approved.ok).toBe(true);
}

function executeToolArgs(name: string, args: Record<string, unknown>) {
	return { tabId, frameId: 0, name, args, callerOrigin: origin };
}

beforeAll(async () => {
	origin = await serve();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-death-"));
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
		await started[0].evaluate(() => undefined);
	} else {
		const event = context.waitForEvent("serviceworker", { timeout: 60_000 });
		const first = await context.newPage();
		await first.goto(`${origin}/bare`);
		await event;
		await first.close();
	}

	page = await context.newPage();
	await page.goto(`${origin}/shop`);
	await page.waitForFunction(
		() => (globalThis as unknown as Record<string, unknown>).__ready === true,
		undefined,
		{ timeout: 60_000 },
	);

	const worker = context.serviceWorkers()[0];
	if (worker === undefined) {
		throw new Error("the extension did not start a worker");
	}
	extensionId = new URL(worker.url()).host;
	const id = await worker.evaluate(async (target: unknown) => {
		const tabs = await chrome.tabs.query({});
		const found = tabs.find((tab) => tab.url === (target as string));
		return found?.id ?? -1;
	}, page.url());
	if (typeof id !== "number" || id < 0) {
		throw new Error("no tab id for the fixture page");
	}
	tabId = id;

	// The protocol handle that can actually stop this worker. Chromium exposes
	// the ServiceWorker domain on a page session, not on the browser session.
	cdp = await context.newCDPSession(page);
	cdp.on("ServiceWorker.workerVersionUpdated", (payload) => {
		for (const version of payload.versions) {
			if (!version.scriptURL.includes("/sw.js")) {
				continue;
			}
			versionId = version.versionId;
			latestStatus = version.runningStatus;
			statusHistory.push(version.runningStatus);
			for (let i = statusWaiters.length - 1; i >= 0; i -= 1) {
				const waiter = statusWaiters[i];
				if (waiter.want === version.runningStatus) {
					statusWaiters.splice(i, 1);
					waiter.done(version.runningStatus);
				}
			}
		}
	});
	await cdp.send("ServiceWorker.enable");
	await waitForStatus("running");

	driver = await openDriver();
}, 240_000);

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

describe("a worker terminated mid-call", () => {
	it("costs the connection and nothing else, at three points in the call", async () => {
		for (const [index, point] of POINTS.entries()) {
			await arm(point);
			const work = issueCall({
				handler: "executeTool",
				args: executeToolArgs("viewCart", {}),
			});
			// Left running on purpose: the call has to be in flight when the kill
			// lands, which is the condition under test.
			const inflight = deliver(work, `killed-${point}`);
			await reached(point);
			await stopTheWorker();
			const outcome = await inflight;

			// The call is not reported as successful. The platform closed the channel
			// and nothing crossed back that a caller could read as a tool result.
			expect(outcome.ok, `${point}: the killed worker's reply`).toBe(false);
			expect(outcome.refusal ?? "", point).toContain("message channel closed");
			expect(work.results, `${point}: replies delivered so far`).toEqual([]);
			expect(work.completedBy, point).toBeNull();
			expect(statusHistory, `${point}: the browser reported a stop`).toContain(
				"stopped",
			);

			// The page outlives the worker; let go of its gate so the next call can
			// run to its own point.
			await release();

			// The work is still held here, under the id the client gave it. This
			// process is the other side of the bridge and has not been told about a
			// new call, because none was issued.
			expect(held, `${point}: still held`).toBe(work);
			expect(clientCalls, `${point}: calls the client issued`).toBe(index + 1);
			expect(work.id, `${point}: the client's own call id`).toBe(index + 1);

			// A different realm answers. Same extension, same document, same
			// worker URL — and none of the state that made the last one what it was.
			await revive();
			const recovered = await deliver(work, `recovered-${point}`);
			await waitForStatus("running");

			expect(recovered.ok, `${point}: recovery reply`).toBe(true);
			expect(recovered.reply, `${point}: the held work, completed`).toEqual({
				ok: true,
				result: '{"items":3}',
			});
			expect(work.completedBy, point).toBe(`recovered-${point}`);
			expect(work.results.length, `${point}: exactly one reply`).toBe(1);
		}
	}, 240_000);

	it("grants no approval through the recovery", async () => {
		await arm("during-execute");

		// Ask. The worker files the confirmation itself, from its own validated
		// view of the tool.
		const asking = issueCall({
			handler: "executeTool",
			args: executeToolArgs("payNow", { amount: 100 }),
		});
		const filed = await deliver(asking, "asking");
		expect(filed.ok).toBe(true);
		const confirmation = confirmationOf(filed.reply);
		expect(confirmation.requiresConfirmation).toBe(true);
		const binding = String(confirmation.pendingApproval);
		expect(binding.length).toBeGreaterThan(0);

		// A person answers it, and the approved invocation starts running.
		await approve(binding);
		const approved = issueCall({
			handler: "executeTool",
			args: executeToolArgs("payNow", { amount: 100 }),
		});
		const inflight = deliver(approved, "approved-then-killed");
		await reached("during-execute");
		await stopTheWorker();
		const outcome = await inflight;
		expect(outcome.ok, "the approved invocation was interrupted").toBe(false);
		expect(approved.completedBy).toBeNull();
		expect(approved.results).toEqual([]);
		await release();

		// Nothing was inherited. The store that held the approval died with the
		// realm, so there is nothing for the new worker to inherit it from.
		await revive();
		const empty = await ask({ panel: "list", args: {} });
		expect(empty.ok).toBe(true);
		expect(
			pendingFrom(empty.reply),
			"approvals carried across a worker death",
		).toEqual([]);

		// The same invocation, re-delivered to the new worker, raises a fresh
		// confirmation instead of running on the approval the old one consumed.
		const recovered = await deliver(approved, "recovered-consequential");
		expect(recovered.ok).toBe(true);
		const result = confirmationOf(recovered.reply);
		expect(result.requiresConfirmation, "a fresh confirmation").toBe(true);
		expect(result.pendingApproval, "bound to the same invocation").toBe(
			binding,
		);

		// And it still takes a person: the recovered confirmation is the only
		// thing that lets it run.
		const stillWaiting = await ask({ panel: "list", args: {} });
		expect(pendingFrom(stillWaiting.reply).length).toBe(1);
		await approve(binding);
		const finished = issueCall({
			handler: "executeTool",
			args: executeToolArgs("payNow", { amount: 100 }),
		});
		const done = await deliver(finished, "after-confirmation");
		expect(done.reply).toEqual({ ok: true, result: '{"paid":100}' });
	}, 180_000);
});
