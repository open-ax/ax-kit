// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import type { AxPage } from "../src/ax.js";
import { expect, test } from "../src/fixture.js";

const RICH_HTML = `<!doctype html><html><body>
<div id="churn-root">
<button id="action-btn" data-churn="true">act</button>
<ul id="churn-list"><li>a</li><li>b</li><li>c</li></ul>
<p id="churn-note" data-churn="true">note</p>
</div>
<div id="click-result"></div>
<div id="api-result"></div>
<script>
document.getElementById("action-btn").addEventListener("click", () => {
  const slot = document.getElementById("click-result");
  if (slot !== null) {
    slot.textContent = "clicked";
  }
});
fetch("/api/data")
  .then((response) => response.json())
  .then((data) => {
    const slot = document.getElementById("api-result");
    if (slot !== null && typeof data.label === "string") {
      slot.textContent = data.label;
    }
  })
  .catch(() => undefined);
</script>
</body></html>`;

async function gotoRich(page: AxPage): Promise<void> {
	await page.route("http://localhost/**/*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: RICH_HTML,
		});
	});
	await page.goto("http://localhost/");
}

async function gotoRichWithAbortedApi(page: AxPage): Promise<void> {
	await page.route("http://localhost/api/**", async (route) => {
		await route.abort();
	});
	await page.route("http://localhost/", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: RICH_HTML,
		});
	});
	await page.goto("http://localhost/");
}

/**
 * Deterministic DOM churn, seeded and synchronous: attribute and class
 * churn, subtree reordering, node removal with re-insertion, and one
 * duplicated action button so locator strictness trips. Self-contained;
 * only the seed crosses the boundary.
 */
async function runShuffler(page: AxPage, seed: number): Promise<void> {
	await page.evaluate(
		(arg: unknown): void => {
			const seedValue = (arg as { seed: unknown }).seed;
			let state = (typeof seedValue === "number" ? seedValue : 1) >>> 0;
			function next(): number {
				state |= 0;
				state = (state + 0x6d2b79f5) | 0;
				let t = Math.imul(state ^ (state >>> 15), 1 | state);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			}
			const root = document.getElementById("churn-root");
			if (root !== null) {
				for (const el of Array.from(root.querySelectorAll("[data-churn]"))) {
					el.setAttribute("data-round", String(Math.floor(next() * 1000)));
					el.classList.toggle("churned", next() > 0.5);
				}
			}
			const action = document.getElementById("action-btn");
			if (action !== null && action.parentElement !== null) {
				const clone = action.cloneNode(true) as Element;
				clone.setAttribute("data-clone", "true");
				action.parentElement.appendChild(clone);
			}
			const list = document.getElementById("churn-list");
			if (list !== null) {
				const items = Array.from(list.children);
				items.reverse();
				for (const item of items) {
					list.appendChild(item);
				}
			}
			const note = document.getElementById("churn-note");
			if (note !== null && note.parentElement !== null) {
				const parent = note.parentElement;
				const sibling = note.nextSibling;
				parent.removeChild(note);
				parent.insertBefore(note, sibling);
			}
		},
		{ seed },
	);
}

async function registerCounter(page: AxPage): Promise<void> {
	await page.evaluate((): Promise<void> => {
		const holder = document as unknown as Record<string, unknown>;
		const surface = holder.modelContext as unknown as {
			registerTool: (tool: unknown) => Promise<unknown>;
		};
		return surface
			.registerTool({
				name: "counter_tool",
				description: "in-process counter",
				execute: async () => ({ clicks: 42 }),
			})
			.then(() => undefined);
	});
}

test("locator controls pass without churn", async ({ page }) => {
	await gotoRich(page);
	await page.locator("#action-btn").click();
	await expect(page.locator("#click-result")).toHaveText("clicked");
});

test("tool path stays green where churned locators go red", async ({
	page,
}) => {
	await gotoRich(page);
	await registerCounter(page);
	await runShuffler(page, 7);
	await expect(page.locator("#action-btn").click()).rejects.toThrow();
	await expect(page.locator("#click-result")).toHaveText("");
	const out = await page.ax.executeTool<{ clicks: number }>("counter_tool", {});
	expect(out).toEqual({ clicks: 42 });
});

test("tool path needs no network round-trip", async ({ page }) => {
	const failedPromise = page.waitForEvent("requestfailed");
	await gotoRichWithAbortedApi(page);
	const failed = await failedPromise;
	expect(failed.url()).toContain("/api/data");
	await expect(page.locator("#api-result")).toHaveText("");
	await registerCounter(page);
	const out = await page.ax.executeTool<{ clicks: number }>("counter_tool", {});
	expect(out).toEqual({ clicks: 42 });
});

test("the timeout guard follows the in-page clock", async ({ page }) => {
	await gotoRich(page);
	await page.clock.install();
	const settled = page.ax.waitForTool("clock_tool", { timeout: 30_000 }).then(
		() => null,
		(reason: unknown) => reason as Error,
	);
	for (let step = 0; step < 40; step++) {
		await page.clock.fastForward(1_000);
	}
	const error = await settled;
	expect(error?.name).toBe("TimeoutError");
});

test("registers through concurrent churn", async ({ page }) => {
	await gotoRich(page);
	const churning = page.evaluate(
		(arg: unknown): Promise<void> => {
			const rounds = (arg as { rounds: unknown }).rounds;
			const total = typeof rounds === "number" ? rounds : 0;
			async function oneRound(index: number): Promise<void> {
				const list = document.getElementById("churn-list");
				if (list !== null) {
					const items = Array.from(list.children);
					items.reverse();
					for (const item of items) {
						list.appendChild(item);
					}
				}
				document.body.classList.toggle("churn", index % 2 === 0);
				await new Promise<void>((resolve) => {
					const channel = new MessageChannel();
					channel.port1.onmessage = (): void => {
						channel.port1.close();
						channel.port2.close();
						resolve();
					};
					channel.port2.postMessage(0);
				});
			}
			async function run(): Promise<void> {
				for (let index = 0; index < total; index++) {
					await oneRound(index);
				}
			}
			return run();
		},
		{ rounds: 20 },
	);
	const registered = registerCounter(page);
	const out = await page.ax.executeTool<{ clicks: number }>("counter_tool", {});
	await registered;
	await churning;
	expect(out).toEqual({ clicks: 42 });
});
