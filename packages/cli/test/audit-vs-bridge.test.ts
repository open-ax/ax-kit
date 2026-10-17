// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The audit and the bridge, against the same page in the same browser session.
 *
 * The audit is a page operator's only view of their own readiness, and until
 * now nothing in this package connected its score to what the bridge actually
 * lets an agent do. A page can score well and expose nothing; a page can score
 * badly and be entirely invokable. Neither is a defect in either tool — they
 * answer different questions — but a reader who cannot tell which is which will
 * stop believing either.
 *
 * So this file runs both, on one page, in one session, and records where they
 * agree and where they do not. The assertions are deliberately asymmetric:
 *
 * - A page the bridge will not expose is a finding about the bridge, and the
 *   reason recorded here must be the bridge's own reason.
 * - A page the bridge exposes but the audit penalises is a cosmetic penalty.
 *   Nothing is blocked, and the report says so.
 * - A tool the audit approves of and the bridge refuses is the interesting
 *   direction, because the audit's job is to predict what an agent can do.
 *   Where it cannot, that is an audit defect and it is named as one here.
 *
 * Everything is real: a real Chromium with the shipped extension loaded, a real
 * loopback transport, and a served page running the shipped core. Nothing is
 * stubbed, so a disagreement this file reports is a disagreement between two
 * shipped artefacts.
 *
 * No sleeps. Readiness is the browser's own commit signal, then the worker's
 * own answer to a real `tools/list`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Transport } from "@ax-kit/daemon";
import { PageBridge, startTransport } from "@ax-kit/daemon";
import type { BrowserContext, Page, Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectSettled } from "../src/driver.js";
import type { AuditContextInput } from "../src/scoring.js";
import { scoreAudit } from "../src/scoring.js";
import type { FixtureServer } from "./fixtures.js";
import { serveFixtures } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const UNPACKED = resolve(here, "../../extension/dist/unpacked");

let server: FixtureServer;
let context: BrowserContext;
let worker: Worker;
let transport: Transport;
let bridge: PageBridge;
let userDataDir: string;
let discoveryDir: string;

/**
 * Open one fixture and wait until it has finished setting itself up.
 *
 * The fixture's own completion marker is the readiness signal, so a fixture that
 * throws reports its error instead of being audited half-built.
 */
async function openFixture(name: string): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${server.origin}/${name}`);
	await page.waitForFunction(
		(expected: unknown) => {
			const scope = globalThis as unknown as Record<string, unknown>;
			return (
				scope["__fixture"] === expected || scope["__fixtureError"] !== undefined
			);
		},
		name,
		{ timeout: 30_000 },
	);
	const failure = await page.evaluate(
		() =>
			(globalThis as unknown as Record<string, unknown>)["__fixtureError"] ??
			null,
	);
	if (typeof failure === "string") {
		throw new Error(`fixture ${name} failed: ${failure}`);
	}
	return page;
}

/**
 * The tab id for a page, read from the browser rather than composed.
 *
 * The worker has no notion of "the page we just opened" other than the tab's
 * own URL, and a tab id guessed from an ordering would address whatever happened
 * to be created first.
 */
async function tabIdFor(page: Page): Promise<number> {
	const tabId = await worker.evaluate(async (target: unknown) => {
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
		throw new Error(`no tab id for ${page.url()}`);
	}
	return tabId;
}

/**
 * Drive the pull/result loop from inside the worker.
 *
 * Written inline because it has to exist in the worker's context, where
 * `__axHandle` lives: the platform serializes the function, so a captured
 * handler would arrive undefined. Deliberately not awaited — the loop runs for
 * the life of the worker, and readiness is observed by the first bridge call
 * completing rather than by a delay.
 */
function startWorkerBridge(): void {
	void worker
		.evaluate(
			async (endpoint: unknown) => {
				const scope = globalThis as unknown as Record<string, unknown>;
				const handle = scope["__axHandle"] as (
					request: unknown,
				) => Promise<unknown>;
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

beforeAll(async () => {
	server = await serveFixtures();
	userDataDir = await mkdtemp(join(tmpdir(), "ax-avb-prof-"));
	discoveryDir = await mkdtemp(join(tmpdir(), "ax-avb-disc-"));

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
		// A page gives the worker a reason to start, and it has to navigate to
		// have a tab to address.
		const starter = await context.newPage();
		await starter.goto(`${server.origin}/empty`);
		worker = await event;
		await starter.close();
	}

	bridge = new PageBridge();
	transport = await startTransport({ discoveryDir, bridge });
	startWorkerBridge();
	// Readiness is a real round trip: if the loop never ran, this times out and
	// says so rather than passing on a proxy.
	await bridge.listTools(await tabIdFor(await openFixture("empty")));
}, 180_000);

afterAll(async () => {
	await transport?.close();
	await context?.close();
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
	await rm(discoveryDir, { recursive: true, force: true }).catch(() => {});
	await server?.close();
});

/**
 * One page, as the audit saw it, with the score it produced and the details
 * behind it. The `detail` lookup is here because several of the disagreements
 * below are about *words*: two tools can agree on a verdict and still tell the
 * reader different reasons for it.
 */
interface AuditView {
	readonly context: AuditContextInput;
	readonly findings: ReturnType<typeof scoreAudit>;
	readonly detail: (check: string) => string | undefined;
	readonly failing: string[];
}

/** What the audit saw of one page, and what it made of it. */
async function auditOf(page: Page): Promise<AuditView> {
	const context = await collectSettled(page);
	const findings = scoreAudit(context);
	const detail = (check: string): string | undefined =>
		findings.find((entry) => entry.check === check)?.detail;
	return {
		context,
		findings,
		detail,
		failing: findings
			.filter((entry) => !entry.pass)
			.map((entry) => `${entry.check}:${entry.tool ?? "site"}`),
	};
}

/** What the bridge will let an agent see on one page, and why not. */
async function exposedBy(
	tabId: number,
): Promise<{ names: string[]; refusal: string | null }> {
	try {
		const listed = await bridge.listTools(tabId);
		return {
			names: listed
				.map((entry) => entry["name"])
				.filter((name): name is string => typeof name === "string"),
			refusal: null,
		};
	} catch (error: unknown) {
		return {
			names: [],
			refusal: error instanceof Error ? error.message : String(error),
		};
	}
}

describe("audit and bridge against the same page", () => {
	it("reads the same tools from the one page both tools looked at", async () => {
		// Acceptance 1. The audit collects in the page; the bridge injects into
		// the page. One session, one document, one tool set — so any difference
		// below is a difference between the two tools' questions, not between two
		// pages.
		const page = await openFixture("clean");
		const tabId = await tabIdFor(page);

		const audited = await auditOf(page);
		const exposed = await exposedBy(tabId);

		expect(audited.context.tools.map((tool) => tool.name).sort()).toEqual([
			"placeOrder",
			"viewCart",
		]);
		expect(exposed.names.sort()).toEqual(["placeOrder", "viewCart"]);
		expect(exposed.refusal).toBeNull();

		// Same origin, seen independently: the audit read the document's own
		// `location`, and the bridge read the frame's origin inside the page.
		const listed = await bridge.listTools(tabId);
		const cart = listed.find((entry) => entry["name"] === "viewCart");
		expect(cart?.["frameOrigin"]).toBe(server.origin);
	}, 60_000);

	it("agrees that an annotated page is invokable, and says which call asks", async () => {
		// The baseline both tools agree on, and the one place they differ
		// honestly: the audit passes every check, and the bridge still refuses
		// to spend money without a person.
		const page = await openFixture("clean");
		const tabId = await tabIdFor(page);

		const audited = await auditOf(page);
		expect(audited.failing).toEqual([]);

		const plain = await bridge.callTool(
			"viewCart",
			{ detailed: true },
			tabId,
			server.origin,
		);
		expect(JSON.parse(plain as string)).toEqual({ items: 2 });

		const consequential = await bridge.callTool(
			"placeOrder",
			{},
			tabId,
			server.origin,
		);
		const approval = consequential as {
			requiresConfirmation?: unknown;
			toolName?: unknown;
		};
		expect(approval.requiresConfirmation).toBe(true);
		expect(approval.toolName).toBe("placeOrder");
	}, 60_000);

	it("scores a page the bridge will not expose, with the bridge's own reason", async () => {
		// Acceptance 2. The impostor context is shaped so the audit reads two
		// tools from it and the bridge cannot describe either: the entries carry
		// no `origin`, and the worker's boundary check refuses the whole listing.
		// The audit's score is therefore about two tools the bridge never
		// published.
		const page = await openFixture("forged");
		const tabId = await tabIdFor(page);

		const audited = await auditOf(page);
		const exposed = await exposedBy(tabId);

		expect(exposed.names).toEqual([]);
		expect(exposed.refusal).toMatch(/bad origin/);
		// The audit scored it anyway, and every score it produced is about a tool
		// no agent can see.
		expect(audited.context.tools.map((tool) => tool.name)).toEqual([
			"totallySafe",
			"wildClaim",
		]);
		expect(audited.failing).toContain("typed:totallySafe");
		expect(audited.failing).toContain("exposure:wildClaim");
		// The reason the bridge gave names a field the audit never reads.
		expect(exposed.refusal).not.toBe(
			audited.failing.find((entry) => entry.startsWith("exposure:wildClaim")),
		);
	}, 60_000);

	it("cannot tell a page that exposes nothing from a page that exposes no context", async () => {
		// The second half of acceptance 2. `noContext` never installs a
		// context; `empty` installs one and registers nothing. The bridge tells
		// them apart — it looks for `document.modelContext` — and the audit
		// does not, because both arrive as the same empty snapshot.
		const bare = await openFixture("noContext");
		const installed = await openFixture("empty");

		const bareAudit = await auditOf(bare);
		const installedAudit = await auditOf(installed);

		expect(bareAudit.context.tools).toEqual([]);
		expect(installedAudit.context.tools).toEqual([]);
		expect(bareAudit.detail("consequential-coverage")).toBe(
			installedAudit.detail("consequential-coverage"),
		);

		const bareExposed = await exposedBy(await tabIdFor(bare));
		const installedExposed = await exposedBy(await tabIdFor(installed));
		expect(bareExposed.names).toEqual([]);
		expect(installedExposed.names).toEqual([]);
		// Both expose nothing, and for the same reason to the bridge: there is
		// no tool in the listing. The audit cannot tell them apart, and this is
		// the record of that.
		expect(bareExposed.refusal).toBeNull();
		expect(installedExposed.refusal).toBeNull();
	}, 60_000);

	it("names every audit penalty the bridge does not enforce", async () => {
		// Acceptance 3. Three fixture classes, each failing an audit check, each
		// still listed by the bridge. The set is the record: a reader who sees
		// a non-zero exit code needs to know which of these are cosmetic.
		const cosmetic: ReadonlyArray<{
			readonly fixture: string;
			readonly tool: string;
			readonly auditCheck: string;
		}> = [
			// No input schema. The bridge derives `declaredKeys` from the
			// schema's properties; a tool without one declares none and so
			// receives no arguments. It is still listed and still runs.
			{ fixture: "untyped", tool: "bareTool", auditCheck: "typed" },
			// A 41-character name and a 600-character description. The bridge's
			// boundary check requires a non-empty description and says nothing
			// about its length.
			{
				fixture: "overlong",
				tool: "aVeryLongToolNameThatExceedsTheBudget",
				auditCheck: "naming-budget",
			},
			// read-only and consequential together. The bridge reads
			// `consequentialHint` and takes the confirmation path, so the
			// inverted pair is more protective than the page asked for.
			{
				fixture: "inverted",
				tool: "refundOrder",
				auditCheck: "read-only-sanity",
			},
		];

		for (const entry of cosmetic) {
			const page = await openFixture(entry.fixture);
			const tabId = await tabIdFor(page);
			const audited = await auditOf(page);
			const exposed = await exposedBy(tabId);

			// The penalty exists.
			expect(
				audited.failing.some((fail) => fail.startsWith(`${entry.auditCheck}:`)),
				`${entry.fixture}: expected ${entry.auditCheck} to fail, saw ${JSON.stringify(audited.failing)}`,
			).toBe(true);
			// And the bridge exposes it anyway, so the penalty blocks nothing.
			expect(exposed.names).toContain(entry.tool);
			expect(exposed.refusal).toBeNull();
		}
	}, 120_000);

	it("passes an exposure check the shipped core never gave it the data for", async () => {
		// An audit defect, found by running both tools rather than by reading
		// either. `overBroad` registers one tool with four trusted origins in
		// `exposedTo`. The shipped core stores that set and does not report it:
		// the registered-tool listing has no `exposedOrigins` field, so the
		// collector reads nothing, sees an empty list, and the audit grades an
		// absence of information as a narrow exposure.
		//
		// This is the one place in the audit where a verdict is reported for
		// something it did not read, so it is recorded rather than smoothed
		// over. It is not fixed here: the fix belongs in the core's listing or
		// in this check's honest wording, and both are outside the audit's lane
		// to decide.
		const page = await openFixture("overBroad");
		const tabId = await tabIdFor(page);

		const audited = await auditOf(page);
		const exposed = await exposedBy(tabId);

		expect(audited.context.tools).toHaveLength(1);
		expect(audited.context.tools[0]?.name).toBe("wideTool");
		expect(audited.context.tools[0]?.exposedOrigins).toEqual([]);
		expect(audited.detail("exposure")).toBe("exposure narrow");
		expect(audited.failing).not.toContain("exposure:wideTool");
		// The bridge lists the tool regardless, which is what makes the false
		// pass harmless in one direction and misleading in the other: a page
		// told "exposure narrow" was told nothing.
		expect(exposed.names).toEqual(["wideTool"]);
	}, 60_000);

	it("treats a tool the audit approves of and the bridge will not run as an audit defect", async () => {
		// Acceptance 4, and the direction that matters. `noConsequential`
		// registers a tool that deletes every record and annotates nothing. The
		// audit's only complaint is `consequential-coverage`, which is a page
		// score. The bridge's answer is about a specific invocation: it runs the
		// deletion, immediately, with nobody asked.
		const page = await openFixture("noConsequential");
		const tabId = await tabIdFor(page);

		const audited = await auditOf(page);
		const exposed = await exposedBy(tabId);

		// The audit is happy with the tool itself: every per-tool check passes.
		const perTool = audited.findings.filter((entry) => entry.tool !== null);
		expect(perTool.filter((entry) => !entry.pass)).toEqual([]);
		expect(audited.failing).toEqual(["consequential-coverage:site"]);

		// The bridge exposes it and executes it, answering with the tool's own
		// result rather than with a question for a person.
		expect(exposed.names).toEqual(["deleteEverything"]);
		const result = await bridge.callTool(
			"deleteEverything",
			{},
			tabId,
			server.origin,
		);
		// The fixture's `execute` returns `null`, so a completed call comes back
		// as the string `"null"`. A consequential tool would have answered with
		// `requiresConfirmation` instead and run nothing.
		expect(result).toBe("null");

		// That is the defect, stated as an assertion: nothing the audit failed
		// would have told the page operator that this call runs unattended. The
		// audit's job is to predict what an agent can do, and here it does not.
		expect(audited.failing).not.toContain("typed:deleteEverything");
	}, 60_000);

	it("keeps its lane: the bridge's answers never enter the audit's score", async () => {
		// Acceptance 7. The comparison exists to explain the score, not to widen
		// the score. A page the bridge refuses is still scored on its own
		// declarations, and the audit still refuses to call itself a site verdict.
		const page = await openFixture("clean");
		const tabId = await tabIdFor(page);

		const before = await auditOf(page);
		// Ask the bridge something the audit has no opinion about at all.
		await bridge
			.callTool("noSuchTool", {}, tabId, server.origin)
			.catch(() => {});
		const after = await auditOf(page);

		expect(after.findings).toEqual(before.findings);
		expect(after.failing).toEqual([]);
	}, 60_000);
});
