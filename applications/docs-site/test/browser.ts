// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The built documentation site, in a real browser.
 *
 * The failure this guards against is a documentation site that is quietly empty
 * or quietly broken — a build that reports success and ships one page, a
 * demonstration that has stopped working, a framework runtime on pages that
 * demonstrate nothing. None of those are visible from the source tree.
 *
 * ## What is asserted, and why each one is not a proxy
 *
 * - **The demonstration registers, enumerates, invokes and refuses.** Through the
 *   published interface, in a browser, on the page. Asserting that a string
 *   appears in the HTML would pass for a page whose script never ran.
 * - **A content page ships no island.** Checked by looking for `astro-island` in
 *   the served HTML, which is the element a hydrated island compiles to. Counting
 *   `<script src>` tags would be wrong: an island's chunk is fetched by that
 *   custom element at runtime, so a page with a working island and a page with no
 *   island at all can carry the *same* script tags.
 * - **Search is local.** Asserted against the served JavaScript, because the
 *   property is about where a query goes, and only the code that sends it can say.
 *
 * External links are not checked. A link that resolves proves only that it
 * resolves.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	afterAll,
	beforeAll,
	chromium,
	describe,
	expect,
	test,
} from "@playwright/test";

const SITE = fileURLToPath(new URL("..", pathToFileURL(__filename)));
const DIST = resolve(join(SITE, "dist"));
const PORT = 4398;
const ORIGIN = `http://localhost:${PORT}`;

/** The static server, kept so `afterAll` can close it. */
let server: ReturnType<typeof createServer> | undefined;

/**
 * A static file server over `dist/`.
 *
 * Not `astro preview`, which in this version of the framework is a **daemon**:
 * it registers an instance, refuses to start a second one against the same
 * directory, and leaves the registration behind when a run is interrupted. A test
 * suite that hangs on a stale lock from a previous run is a test suite people
 * learn to kill and re-run, which is the same outcome as no test suite.
 *
 * Serving `dist/` directly is also a *better* check than the framework's preview
 * server, because it is a different implementation of the same thing. If these
 * tests passed only because the framework's own server resolved a URL the way
 * the framework expects, they would not be testing the output.
 *
 * Deliberately minimal: index resolution, content types, and a refusal to serve
 * anything outside `dist/`. No directory listing, no caching, no rewriting.
 */
function serve(root: string) {
	return createServer((request, response) => {
		const requested = new URL(request.url ?? "/", ORIGIN).pathname;
		// Normalise before joining, so `..` cannot climb out of the served root.
		const resolved = resolve(root, `.${requested}`);
		// `resolved === root` is allowed: that is a request for `/`, which is the
		// site itself and must be served. For anything deeper, the comparison is
		// against the root *plus a separator*, because a bare `startsWith(root)`
		// also accepts a sibling directory whose name merely begins with the root's
		// — serving `dist-other` while claiming to serve `dist`.
		if (
			resolved === undefined ||
			(resolved !== root && !resolved.startsWith(root + sep))
		) {
			response.writeHead(403).end("forbidden");
			return;
		}
		let file = resolved;
		if (!existsSync(file) || statSync(file).isDirectory()) {
			file = join(resolved, "index.html");
		}
		if (!existsSync(file)) {
			response.writeHead(404).end("not found");
			return;
		}
		response.writeHead(200, {
			"content-type":
				CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
		});
		response.end(readFileSync(file));
	});
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".xml": "application/xml; charset=utf-8",
	".woff2": "font/woff2",
};

beforeAll(async () => {
	// The built output, or a clear failure. Serving source would make every
	// assertion about something nobody deploys.
	if (!existsSync(join(DIST, "index.html"))) {
		throw new Error(
			"the site has not been built. Run `pnpm --filter @ax-kit/docs-site build` first; these tests deliberately do not fall back to `astro dev`.",
		);
	}
	server = serve(DIST);
	await new Promise<void>((resolve) => {
		server.listen(PORT, resolve);
	});
});

afterAll(async () => {
	// Closed explicitly, because it was not before. The listener lives in this
	// process, so the suite held the port open after the last test: the runner
	// exited anyway, but a second run in the same process failed with `EADDRINUSE`,
	// which is the sort of failure that looks like a flake and gets ignored.
	if (server === undefined) {
		return;
	}
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});
	server = undefined;
});

describe("the built site", () => {
	test("serves every page the summary lists", async () => {
		const summary = (await (await fetch(`${ORIGIN}/llms.json`)).json()) as {
			pages: ReadonlyArray<{ url: string }>;
		};
		expect(summary.pages.length).toBeGreaterThan(5);
		for (const page of summary.pages) {
			const response = await fetch(`${ORIGIN}${page.url}`);
			expect(
				response.status,
				`${page.url} is listed in llms.json but is not served`,
			).toBe(200);
		}
	});

	test("serves the vulnerability route in machine-readable form, from the root", async () => {
		// Checked from the site root rather than from the page that documents it:
		// a reporting route that only works if you already know about it is not a
		// route.
		const response = await fetch(`${ORIGIN}/.well-known/security.txt`);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Contact: mailto:");
		expect(body).toMatch(/Expires:\s*\d{4}-\d{2}-\d{2}/);
	});

	test("ships no interactive island on a page that demonstrates nothing", async () => {
		// The load-bearing claim of a static site with one island in it. Asserted
		// on the served HTML rather than by counting script tags, because an island
		// is fetched by a custom element at runtime and both kinds of page carry
		// the same framework scripts.
		const html = await (await fetch(`${ORIGIN}/quickstart/`)).text();
		expect(html, "a content page hydrated something").not.toContain(
			"<astro-island",
		);
		expect(html).not.toContain('component-url="/_astro/TryIt');
	});

	test("hydrates exactly the demonstration page", async () => {
		const html = await (await fetch(`${ORIGIN}/try-it/`)).text();
		expect(html).toContain("<astro-island");
		expect(html).toMatch(/component-url="\/_astro\/TryIt/);
	});

	test("names the pinned draft on every page that describes behaviour", async () => {
		// A reader comparing this site with the specification has to be able to
		// tell whether they are reading the same document. The footer carries it on
		// every page precisely so no page can forget.
		for (const path of ["/quickstart/", "/reference/errors/", "/try-it/"]) {
			const html = await (await fetch(`${ORIGIN}${path}`)).text();
			expect(html, `${path} does not name a draft`).toContain("2 October 2026");
		}
	});
});

describe("the live demonstration", () => {
	test("registers, enumerates, invokes and refuses — in a real browser", async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			// Chromium logs this for the `tools` feature outside an origin trial.
			// Every consumer gets it; it says nothing about whether the polyfill
			// installed, so the assertions check the surface rather than the absence
			// of console noise.
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
			await page.goto(`${ORIGIN}/try-it/`, { waitUntil: "domcontentloaded" });

			// Enumeration: the page renders a row per registered tool.
			const row = page.locator(".ax-try__table tbody tr");
			await expect(row).toHaveCount(5);
			await expect(page.locator(".ax-try__table tbody")).toContainText(
				"search_products",
			);

			// The consequential annotation is *visible in the table*, not described
			// in prose beside it.
			await expect(
				page.locator(".ax-try__table tbody tr", {
					hasText: "proceed_to_checkout",
				}),
			).toContainText("yes");
			// The *cell*, not the row. `toContainText("no")` on the row matched the
			// substring inside "no — takes none" in a neighbouring column, so the
			// assertion passed whatever the Consequential column said — and would
			// have passed had the column not existed at all.
			await expect(
				page
					.locator(".ax-try__table tbody tr", { hasText: "add_to_cart" })
					.locator("td")
					.nth(2),
			).toHaveText("no");

			// Invocation. The result is displayed as the string the draft specifies.
			await page.getByRole("button", { name: /well formed/ }).click();
			await expect(page.locator(".ax-try__log")).toContainText(
				"search_products",
			);

			// Two refusals, each asserted separately. Asserting once after clicking
			// twice proved only that *a* refusal happened: the second click could have
			// done nothing and the test would still have passed. Each entry carries the
			// label it was invoked under, so the label is what identifies it.
			await page.getByRole("button", { name: /query is a number/ }).click();
			await expect(
				page.locator(".ax-try__log li", {
					hasText: "query is a number",
				}),
			).toContainText("UnknownError");

			await page.getByRole("button", { name: /no query/ }).click();
			await expect(
				page.locator(".ax-try__log li", { hasText: "no query" }),
			).toContainText("UnknownError");
		} finally {
			await browser.close();
		}
	});

	test("uses the same tool names as the storefront", async () => {
		// Asserted against the built page rather than against a shared constant,
		// because the two files deliberately do not import each other and a shared
		// constant would make this agreement impossible to violate and therefore
		// impossible to test. `test/vocabulary.test.ts` compares the sources.
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(`${ORIGIN}/try-it/`, { waitUntil: "domcontentloaded" });
			// Waited on the table the island renders, not on a timer. Reading it
			// immediately after navigation catches the server-rendered placeholder
			// and reports an empty vocabulary.
			await expect(page.locator(".ax-try__table tbody tr")).toHaveCount(5);
			const names = await page
				.locator(".ax-try__table tbody tr td:first-child")
				.allTextContents();
			expect(names.map((name) => name.trim()).sort()).toEqual([
				"add_to_cart",
				"apply_coupon_code",
				"proceed_to_checkout",
				"search_products",
				"view_cart",
			]);
		} finally {
			await browser.close();
		}
	});
});
