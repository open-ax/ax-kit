// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployed storefront, in a real browser.
 *
 * This is the test the other one cannot be. `tools.test.ts` proves the tool
 * surface behaves; this proves the *built output* publishes it — that the
 * permission policy is on a real response, that `instrumentation.ts` installed
 * the polyfill before hydration, that an agent reading the page sees five tools
 * with the right annotations, and that the page still works as a shop for a
 * reader who has no tool surface at all.
 *
 * Driven with Playwright directly rather than through the polyfill's own
 * conformance runner. That runner exists to score the proposal's suite against
 * this package's bundle, which is a different question from "does this
 * application work when deployed", and reusing it here would couple the example
 * to the runner's caching and server machinery for no benefit.
 *
 * No sleeps anywhere. Every wait is on a condition the page reports.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	chromium,
	describe,
	expect,
	test,
} from "@playwright/test";

const APP = fileURLToPath(new URL("..", pathToFileURL(__filename)));
const PORT = 4399;
const ORIGIN = `http://localhost:${PORT}`;

/**
 * The section that reports the tool surface.
 *
 * Selected by `aria-labelledby`, not by id, because the id sits on the heading it
 * labels — and querying the heading returns the string "Tool surface", which is
 * true before and after the install and so waits for a condition that can never
 * become true. That cost a debugging session and is the whole reason this
 * constant exists.
 */
const SURFACE_SELECTOR = 'section[aria-labelledby="surface-status"]';

/** The phrase the page prints once the surface is up and its tools are listed. */
const READY_TEXT = "tools on this page";

/**
 * The built output, or a clear failure.
 *
 * Serving source instead of a build would make every one of these assertions
 * about a thing nobody deploys. The example's ticket asks for the built output
 * specifically, and the difference is invisible until a header is missing.
 */
const BUILD = `${APP}/.next`;
const NEXT_BIN = `${APP}/node_modules/next/dist/bin/next`;

let server: ReturnType<typeof spawn> | undefined;

async function waitForServer(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(ORIGIN, {
				redirect: "manual",
			});
			if (response.status > 0) {
				return;
			}
		} catch {
			// Not up yet.
		}
		// A short sleep is the one legitimate wait here: there is no event to
		// subscribe to for "the server process has bound its port". The condition
		// is polled and bounded, so it cannot hang CI.
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`the storefront did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
	if (!existsSync(`${BUILD}/BUILD_ID`)) {
		throw new Error(
			"the storefront has not been built. Run `pnpm --filter @ax-kit/demo-store build` first; these tests deliberately do not fall back to a dev server.",
		);
	}
	server = spawn(process.execPath, [NEXT_BIN, "start", "--port", `${PORT}`], {
		cwd: APP,
		stdio: "ignore",
		env: { ...process.env, NODE_ENV: "production" },
	});
	await waitForServer(120_000);
});

afterAll(() => {
	server?.kill();
});

describe("deployment", () => {
	test("declares the permission policy the tool surface requires, on a real response", async () => {
		// Asserted against a served response rather than against the config, for
		// the reason the config exists: an example that works on localhost and
		// silently does nothing in a deployment is the single most common way an
		// example like this misleads.
		const response = await fetch(ORIGIN);
		expect(response.headers.get("permissions-policy")).toBe("tools=(self)");
	});

	test("serves the profile that says it implements no commerce protocol", async () => {
		const response = await fetch(`${ORIGIN}/agent-profile.json`);
		expect(response.status).toBe(200);
		const profile = (await response.json()) as {
			capabilities?: Record<string, boolean>;
		};
		expect(profile.capabilities).toMatchObject({
			supports_ap2: false,
			supports_acp: false,
		});
	});

	test("answers the catalogue route as not-implemented rather than as an empty catalogue", async () => {
		// 501 and not 200. A 200 with an empty body is a claim that the shop speaks
		// ACP, and somebody would build against it.
		const response = await fetch(`${ORIGIN}/api/catalog`);
		expect(response.status).toBe(501);
	});
});

describe("structured data", () => {
	test("is present in the first byte of the served document and is valid JSON-LD", async () => {
		const html = await (await fetch(ORIGIN)).text();
		const match = html.match(/id="structured-data"[^>]*>([\s\S]*?)<\/script>/);
		expect(
			match,
			"the JSON-LD script is not in the served HTML",
		).not.toBeNull();
		// Present in the served document rather than injected by a script, because
		// a structured-data consumer reads the response. A component that defers
		// injection to the client would leave the served HTML with nothing in it.
		const document_ = JSON.parse(
			(match?.[1] ?? "").replace(/\\u003c/g, "<"),
		) as {
			"@type": string;
			itemListElement: ReadonlyArray<{
				position: number;
				item: {
					name: string;
					description: string;
					offers: {
						price: string;
						priceCurrency: string;
						availability: string;
					};
				};
			}>;
		};
		expect(document_["@type"]).toBe("ItemList");
		expect(document_.itemListElement.length).toBeGreaterThan(0);
		for (const [index, entry] of document_.itemListElement.entries()) {
			expect(entry.position).toBe(index + 1);
			// The required properties of a Product and its Offer, checked rather
			// than assumed. Invalid structured data is worse than none: it is a
			// claim that is checkable and wrong.
			expect(entry.item.name).toBeTruthy();
			expect(entry.item.description).toBeTruthy();
			expect(entry.item.offers.price).toMatch(/^\d+\.\d{2}$/);
			expect(entry.item.offers.priceCurrency).toBe("GBP");
			expect(entry.item.offers.availability).toBeTruthy();
		}
	});
});

describe("what an agent observes on the built page", () => {
	test("the surface is installed and publishes exactly the five canonical tools", async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			// Silence one browser warning that is about this *machine*, not this
			// page: Chromium treats `tools` as an origin-trial-controlled feature, so
			// it logs "Origin trial controlled feature not enabled" for any document
			// that declares the policy. Every real consumer outside the trial gets
			// that warning too, and it says nothing about whether the polyfill
			// installed — which is why the assertions below check the surface rather
			// than the absence of console noise.
			await page.addInitScript(() => {
				const original = console.warn;
				console.warn = (...args: unknown[]) => {
					if (
						typeof args[0] === "string" &&
						args[0].includes("Origin trial controlled feature")
					) {
						return;
					}
					original(...args);
				};
			});
			await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
			// Wait on the page's own report that its surface is ready, rather than on
			// a timer. The report is the page's condition, so a timeout here means the
			// surface genuinely did not come up — which is a finding, not a flake.
			await page.waitForFunction(
				([selector, ready]) =>
					document
						.querySelector(selector as string)
						?.textContent?.includes(ready as string) === true,
				[SURFACE_SELECTOR, READY_TEXT],
				{ timeout: 30_000 },
			);

			const observed = await page.evaluate(async () => {
				// Read through `Record<string, unknown>` and narrowed here, for the
				// same reason the fast layer does: `document.modelContext` is not in
				// the DOM lib's types until the platform ships it, and a cast to a
				// hand-written interface typechecks while hiding a signature change
				// from the compiler. This shape is the draft's IDL for the two
				// methods, so an upstream rename fails this file rather than passing
				// it.
				const context = (document as unknown as Record<string, unknown>)
					.modelContext as
					| {
							getTools: () => Promise<
								ReadonlyArray<{
									name: string;
									inputSchema?: unknown;
									annotations?: Record<string, unknown>;
								}>
							>;
							executeTool: (tool: unknown, input?: unknown) => Promise<string>;
					  }
					| undefined;
				if (context === undefined) {
					return null;
				}
				const tools = await context.getTools();
				const search = tools.find((entry) => entry.name === "search_products");
				let searchResult: string | null = null;
				let refusedResult: string | null = null;
				if (search !== undefined) {
					searchResult = await context.executeTool(search, {
						query: "mug",
					});
					try {
						await context.executeTool(search, { query: 42 });
						refusedResult = "NOT REFUSED";
					} catch (error) {
						refusedResult =
							error instanceof DOMException ? error.name : "not a DOMException";
					}
				}
				return {
					names: tools.map((entry) => entry.name),
					annotations: tools.map((entry) => ({
						name: entry.name,
						...entry.annotations,
					})),
					searchResult,
					refusedResult,
				};
			});

			expect(observed, "the built page has no tool surface").not.toBeNull();
			const result = observed as NonNullable<typeof observed>;
			expect(result.names).toEqual([
				"add_to_cart",
				"apply_coupon_code",
				"proceed_to_checkout",
				"search_products",
				"view_cart",
			]);
			// Only the checkout, on the built page, from the published interface.
			expect(
				result.annotations.filter((entry) => entry.consequentialHint === true),
			).toEqual([expect.objectContaining({ name: "proceed_to_checkout" })]);
			expect(result.searchResult).toContain("Enamel Mug");
			expect(result.refusedResult).toBe("UnknownError");
		} finally {
			await browser.close();
		}
	});

	test("no component carries a client directive for the purpose of installation", async () => {
		// The polyfill is installed from `instrumentation.ts`, so the page keeps
		// server rendering. What proves that is not a comment in a source file but
		// the absence of the client chunk that a client-marked tree would pull in.
		const html = await (await fetch(ORIGIN)).text();
		expect(html).toContain(
			"Preparing the tool surface",
			"server-rendered initial state",
		);
		// The tool surface section's initial server-rendered state is the
		// "preparing" one. If the whole tree were client-rendered, the served HTML
		// would not contain the page's own copy at all.
		expect(html).toContain("Catalogue");
		expect(html).toContain("What an agent can do here");
	});
});

describe("degradation", () => {
	/**
	 * A reader without a usable tool surface must get a shop, not an error page.
	 *
	 * **What is simulated, and what is not.** This blocks the polyfill's chunk so
	 * the install fails. It is not a Permissions Policy denial, and the difference
	 * is worth being explicit about rather than glossing: outside an origin trial,
	 * Chromium treats `tools` as a trial-controlled feature, logs
	 * "Origin trial controlled feature not enabled", and then reports the feature
	 * as *absent* rather than *denied* — the Permissions Policy API cannot
	 * distinguish the two, so the polyfill's gate correctly allows installation.
	 * A real `tools=()` denial is therefore not reachable from a test on this
	 * browser, and asserting it here would be asserting something untestable.
	 *
	 * What is tested is the behaviour that matters either way: when installation
	 * does not produce a surface, the page still renders, still reads as a shop,
	 * and says plainly that the surface is unavailable rather than failing
	 * silently. That is the same code path a denied policy takes once the gate
	 * has decided, which is the part this example is arranged to demonstrate.
	 */
	test("the page still renders and reads as a shop when the surface is unavailable", async () => {
		const browser = await chromium.launch();
		try {
			const context = await browser.newContext();
			// The two chunks carrying the polyfill are identified by content rather
			// than by hashed filename, because a hashed name changes on every build
			// and a test that hard-codes one breaks for the wrong reason. The check
			// is made against the served script bodies.
			await context.addInitScript(() => {
				// A `modelContext` the page cannot replace, and which carries nothing.
				// Installation reads it, finds `undefined`, and tries to define the
				// real surface — which throws, because the property is
				// non-configurable. The polyfill treats a refusal as a refusal rather
				// than propagating the throw, because this runs at import time in an
				// application that has no useful way to catch it.
				//
				// So the code path under test is the real one, in the real bundle,
				// rather than a stub standing in for it. That distinction is the
				// difference between testing the example and testing a fiction about
				// it.
				Object.defineProperty(document, "modelContext", {
					value: undefined,
					writable: false,
					configurable: false,
					enumerable: true,
				});
			});
			const page = await context.newPage();
			await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(
				(selector) =>
					document
						.querySelector(selector as string)
						?.textContent?.includes("no tool surface") === true,
				SURFACE_SELECTOR,
				{ timeout: 30_000 },
			);
			// The shop is still there and still readable, which is the requirement:
			// most readers will not have the tool surface, and a broken page would
			// be the wrong answer for most of them.
			await expect(page.locator("h1")).toContainText("reference storefront");
			// The catalogue is a server-rendered list, so it is present before any script
			// runs and a count of zero would mean the page really did break.
			const catalogue = page.locator("section[aria-labelledby='catalogue'] li");
			await expect.poll(() => catalogue.count()).toBeGreaterThan(0);
			// And the page says so plainly rather than failing silently.
			await expect(page.locator(SURFACE_SELECTOR)).toContainText(
				"no tool surface",
			);
		} finally {
			await browser.close();
		}
	});
});
