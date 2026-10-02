// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser driver the audit was missing.
 *
 * Everything here is ours, not the draft's: the draft defines the page
 * surface, while this module decides how a real browser is launched and handed
 * to the pure collector. The collector stays pure so it remains testable; this
 * is the part that talks to a browser.
 *
 * Three properties this driver has to hold:
 *
 * - It never sleeps. Readiness is the page's own state: the context appearing,
 *   then a bounded drain of the core's task-turn notification.
 * - The browser closes on every path, including a failure during page
 *   creation. A leaked browser outlives the test that made it.
 * - A page with no context is a subject, not an error. It audits as "no tools",
 *   which scoring distinguishes from "tools present but undiscoverable".
 */

import type { Browser, BrowserContext, Page } from "playwright";

import type { BrowserLike, BrowserPageLike } from "./audit.js";
import { auditSnapshot, collectContext } from "./audit.js";
import type { AuditContextInput } from "./scoring.js";
import { countFailures, scoreAudit } from "./scoring.js";

/**
 * Adapts a Playwright page to the narrow surface the collector needs. The
 * collector cannot tell this apart from any other page implementation, which is
 * the point: it keeps a browser dependency out of the pure layer.
 */
class PageAdapter implements BrowserPageLike {
	constructor(private readonly page: Page) {}

	async goto(url: string): Promise<void> {
		await this.page.goto(url);
	}

	evaluate<T>(fn: () => T): Promise<Awaited<T>> {
		return this.page.evaluate(fn) as Promise<Awaited<T>>;
	}
}

/**
 * A driven page with the one extra capability the audit needs: waiting for a
 * condition the page establishes. `arg` is serialized into the page, because a
 * closure over test-scope values does not survive the hop.
 */
export interface DrivenPage extends BrowserPageLike {
	waitFor<T>(
		fn: (arg: unknown) => T,
		arg: unknown,
		description: string,
	): Promise<Awaited<T>>;
}

class DrivenPageAdapter implements DrivenPage {
	constructor(private readonly page: Page) {}

	async goto(url: string): Promise<void> {
		await this.page.goto(url);
	}

	evaluate<T>(fn: () => T): Promise<Awaited<T>> {
		return this.page.evaluate(fn) as Promise<Awaited<T>>;
	}

	async waitFor<T>(
		fn: (arg: unknown) => T,
		arg: unknown,
		description: string,
	): Promise<Awaited<T>> {
		try {
			const handle = await this.page.waitForFunction(fn, arg, {
				timeout: 30_000,
			});
			return (await handle.jsonValue()) as Awaited<T>;
		} catch (error: unknown) {
			throw new Error(`${description}: ${String(error)}`);
		}
	}
}

class ContextAdapter implements BrowserLike {
	constructor(private readonly session: Session) {}

	newPage(): Promise<BrowserPageLike> {
		return this.session.context.newPage().then((page) => new PageAdapter(page));
	}

	close(): Promise<void> {
		return closeSession(this.session);
	}
}

export interface DrivenBrowser {
	newPage(): Promise<DrivenPage>;
	close(): Promise<void>;
}

export interface LaunchOptions {
	readonly headless: boolean;
}

/**
 * A launched browser and one context inside it. Both have to be closed: the
 * context alone leaves the browser process alive.
 */
interface Session {
	readonly browser: Browser;
	readonly context: BrowserContext;
}

/**
 * `channel: "chromium"` is deliberate. Playwright resolves bundled Chromium in
 * headless mode to a shell that loads no extension, and the same channel keeps
 * extension work and audit work on one binary.
 */
async function launchSession(options: LaunchOptions): Promise<Session> {
	const { chromium } = await import("playwright");
	const browser: Browser = await chromium.launch({
		channel: "chromium",
		headless: options.headless,
	});
	try {
		const context = await browser.newContext();
		return { browser, context };
	} catch (error: unknown) {
		// No `Session` comes back, so no caller has a `finally` that could close
		// it. Leaving the process here keeps the command alive with no exit code.
		await browser.close();
		throw error;
	}
}

/**
 * Close both. Closing only the context leaves the browser process running and
 * keeps the node event loop alive, so the command would never return an exit
 * code — the process would have to be killed to be believed.
 */
async function closeSession(session: Session): Promise<void> {
	try {
		await session.context.close();
	} finally {
		await session.browser.close();
	}
}

/** Launch a real browser behind the collector's narrow interface. */
export async function launchBrowser(
	options: LaunchOptions,
): Promise<BrowserLike> {
	const session = await launchSession(options);
	return new ContextAdapter(session);
}

/**
 * The same browser, with pages that can also be waited on by condition.
 *
 * `close` closes the whole session rather than the context alone, so it means
 * the same thing here as it does on the plain adapter: a caller that closes one
 * browser never has to know a second thing was left running.
 */
export async function launchDrivenBrowser(
	options: LaunchOptions,
): Promise<DrivenBrowser> {
	const session = await launchSession(options);
	return {
		newPage: () =>
			session.context.newPage().then((page) => new DrivenPageAdapter(page)),
		close: () => closeSession(session),
	};
}

/**
 * Task turns without timers. One round yields a single MessageChannel turn,
 * flushing queued change notifications ahead of the continuation. The core's
 * own browser tests drain registrations the same way.
 */
const SETTLE_TURNS = 4;

async function settleInPage(page: Page): Promise<void> {
	await page.evaluate(async (turns: number) => {
		for (let index = 0; index < (turns as number); index += 1) {
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (): void => {
					channel.port1.close();
					channel.port2.close();
					resolve();
				};
				channel.port2.postMessage(undefined);
			});
		}
	}, SETTLE_TURNS);
}

/**
 * Collect from a page that has finished setting itself up.
 *
 * A page registers tools asynchronously, so navigating is not the same as being
 * ready. This waits for the context to exist, then drains a bounded number of
 * task turns. No sleep: the wait ends when the registrations have landed.
 */
export async function collectSettled(page: Page): Promise<AuditContextInput> {
	await waitForContextOrNothing(page);
	await settleInPage(page);
	return collectContext(new PageAdapter(page));
}

/**
 * Wait for a context to appear, or give up and report a page with no tools.
 *
 * The budget is bounded so a page that never installs one cannot hold the
 * command open, but it is long enough that an ordinary page registering
 * asynchronously is never misreported as empty. A page with no context is a
 * legitimate subject; the timeout only decides how long we are willing to wait
 * before believing it.
 */
async function waitForContextOrNothing(page: Page): Promise<void> {
	try {
		await page.waitForFunction(
			() =>
				typeof (document as unknown as Record<string, unknown>)[
					"modelContext"
				] === "object",
			undefined,
			{ timeout: 5_000 },
		);
	} catch {
		// No context: the collector reports an empty tool set and scoring states
		// that plainly, rather than treating it as a malfunction.
	}
}

/** Audit one URL with a real browser and return the report and its context. */
export async function auditLiveUrlFindings(
	options: LaunchOptions,
	url: string,
): Promise<{ report: string; context: AuditContextInput }> {
	const session = await launchSession(options);
	try {
		const page = await session.context.newPage();
		await page.goto(url);
		const collected = await collectSettled(page);
		return { report: auditSnapshot(url, collected), context: collected };
	} finally {
		await closeSession(session);
	}
}

/** Audit one URL with a real browser and return the formatted report. */
export async function auditLiveUrl(
	options: LaunchOptions,
	url: string,
): Promise<string> {
	return (await auditLiveUrlFindings(options, url)).report;
}

/** Exit code that follows the findings, so the command works in a pipeline. */
export function exitCodeFor(context: AuditContextInput): number {
	return countFailures(scoreAudit(context)) > 0 ? 2 : 0;
}
