// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { resolveInitScriptPath } from "./paths.js";
import { IDL_HARNESS_PATH, INSTALL_SCRIPT_PATH } from "./wpt.js";
import { IDL_HARNESS_PAGE_PATH, startSuiteServer } from "./wpt-server.js";

/**
 * Runs the pinned suite against the built bundle and reports what happened.
 *
 * The bundle under test is the artifact the normal `pnpm build` produces,
 * installed through an init script so the surface exists before any suite script
 * runs. Not source, not a development build, and not a test-only entry.
 *
 * Suite files are served byte-identical to upstream. Two files are replaced, and
 * both replacements are files upstream designates for the job:
 * `resources/testharnessreport.js`, described in its own header as "intended for
 * vendors to implement code needed to integrate testharness.js tests with their
 * own test systems", and `common/get-host-info.sub.js`, a template the WPT
 * server fills in with the ports and hostnames of the machine running the
 * suite. No test file is edited, wrapped or reordered.
 *
 * Waiting is by callback. The reporter calls a page binding once the harness
 * completes, and the runner awaits that call. There is no polling, and no timer
 * stands in for completion: a file that has not reported inside its bound is
 * recorded as not completing, which is a failure and not a pass.
 */

const HARNESS_SCRIPT_PATH = "/resources/testharness.js";

/** The one testharness completion code that means nothing went wrong. */
const HARNESS_OK = 0;

export interface SubtestResult {
	readonly name: string;
	readonly status: string;
	readonly message: string;
}

export interface FileOutcome {
	/** Repository path, or the generated page for the interface-definition dimension. */
	readonly unit: string;
	/** `harness` reports subtests; `crash` is judged on survival alone. */
	readonly kind: "harness" | "crash";
	readonly status: "pass" | "fail" | "did-not-complete";
	readonly results: readonly SubtestResult[];
	readonly note: string;
}

export interface SuiteRun {
	readonly browserName: string;
	readonly browserVersion: string;
	readonly files: readonly FileOutcome[];
}

const REPORTER = `
(() => {
  const text = (value) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    return String(value);
  };
  // A testharness test reports its verdict as a number: 0 PASS, 1 FAIL,
  // 2 TIMEOUT, 3 NOTRUN, 4 UNCAUGHT. Normalised to a word here, so nothing
  // downstream infers a verdict from how a status happens to be spelled.
  const verdict = (status) => {
    switch (Number(status)) {
      case 0: return "PASS";
      case 1: return "FAIL";
      case 2: return "TIMEOUT";
      case 3: return "NOTRUN";
      case 4: return "UNCAUGHT";
      default: return "UNKNOWN";
    }
  };
  // Only leaves are reported. A parent test aggregates its children, so scoring
  // parents as well would report every failure twice and bury the assertion that
  // actually failed. Steps are folded into the message, because a failing
  // promise_test frequently carries its explanation in a step rather than in the
  // test's own message field.
  const flatten = (test, out) => {
    if (test === null || typeof test !== "object") return;
    const subtests = Array.isArray(test.subtests) ? test.subtests : [];
    if (subtests.length > 0) {
      for (const subtest of subtests) flatten(subtest, out);
      return;
    }
    const status = verdict(test.status);
    if (status === "PASS") {
      out.push({ name: text(test.name), status: status, message: "" });
      return;
    }
    const parts = [text(test.message)];
    if (Array.isArray(test.steps)) {
      for (const step of test.steps) {
        const message = text(step);
        if (message !== "") parts.push(message);
      }
    }
    out.push({
      name: text(test.name),
      status: status,
      message: parts.filter((part) => part !== "").join("\\n"),
    });
  };
  add_completion_callback((tests, status) => {
    const results = [];
    try {
      if (Array.isArray(tests)) {
        for (const test of tests) flatten(test, results);
      }
      const numeric =
        status !== null && typeof status === "object" ? status.status : status;
      window.__axHarness({
        kind: "complete",
        harnessStatus: Number(numeric),
        results: results,
      });
    } catch (error) {
      window.__axHarness({
        kind: "complete",
        harnessStatus: -1,
        results: [
          { name: "reporter", status: "UNCAUGHT", message: String(error) },
        ],
      });
    }
  });
  // The suite's files that declare no harness are judged on whether the browser
  // survives them. They end by hanging, so the only thing an observer can wait
  // for is the thing that would be a failure: a crash, a closed page, a
  // navigation, or an event from the surface under test.
  const surface = document.modelContext;
  if (surface && typeof surface.addEventListener === "function") {
    for (const name of ["toolcancel", "toolactivated", "toolchange"]) {
      surface.addEventListener(name, () => {
        window.__axHarness({ kind: "signal", signal: name });
      });
    }
  }
})();
`;

interface HarnessPayload {
	readonly kind: "complete" | "signal";
	readonly harnessStatus?: number;
	readonly results?: readonly SubtestResult[];
	readonly signal?: string;
}

function isHarnessFile(unit: string, body: string): boolean {
	// The interface-definition harness is a script, and its generated page loads
	// the harness even though the script itself does not.
	if (unit === IDL_HARNESS_PATH) {
		return true;
	}
	return body.includes(HARNESS_SCRIPT_PATH);
}

/**
 * Forwarded from every document, whether or not it loads the reporter.
 *
 * The suite's two files that declare no harness are judged on whether the
 * browser survives them, and they end by hanging. The only thing an observer
 * can wait for is the thing that would be a failure: a crash, a closed page, a
 * frame navigation, or an event from the surface under test. A listener is
 * added and nothing is replaced or patched.
 */
const OBSERVER = `
(() => {
  const surface = document.modelContext;
  if (!surface || typeof surface.addEventListener !== "function") return;
  for (const name of ["toolcancel", "toolactivated", "toolchange"]) {
    surface.addEventListener(name, () => {
      try {
        window.__axObserved(name);
      } catch (error) {
        void error;
      }
    });
  }
})();
`;

export interface RunSuiteOptions {
	/** Every servable path, keyed by repository path with no leading slash. */
	readonly bodies: ReadonlyMap<string, string>;
	/** Units to run, in report order. */
	readonly units: readonly string[];
	/** Per-file completion bound, in milliseconds. */
	readonly fileTimeoutMs: number;
	readonly onProgress?: (line: string) => void;
}

/** The interface-definition harness runs from a generated page, not its own path. */
function requestPathFor(unit: string): string {
	return unit === IDL_HARNESS_PATH ? IDL_HARNESS_PAGE_PATH : `/${unit}`;
}

function observe(page: Page, options: RunSuiteOptions): void {
	page.on("console", (message) => {
		options.onProgress?.(`      [page:${message.type()}] ${message.text()}`);
	});
	page.on("pageerror", (error) => {
		options.onProgress?.(`      [pageerror] ${error.message}`);
	});
}

/**
 * The built bundle, wrapped so that evaluating it twice in one document is a
 * no-op rather than a thrown `TypeError`.
 *
 * The bundle holds its registry in a module-scope `WeakMap`, so a second
 * evaluation in the same document is a different registry that then tries to
 * redefine an existing non-configurable property. The guard is on the document
 * rather than on a shared symbol because a shared symbol would need the realms
 * to already agree, which is the thing being established here.
 *
 * The bytes between the braces are the shipped artifact, read from the file the
 * normal build produced. Nothing is rewritten.
 */
function installScript(): string {
	const source = readFileSync(resolveInitScriptPath(), "utf8");
	return `if (Object.getOwnPropertyDescriptor(document, "modelContext") === undefined) {\n${source}\n}\n`;
}

/**
 * Install both scripts into one page or context.
 *
 * The route that actually covers the suite is the response injection in
 * `startSuiteServer`, which reaches every document over HTTP including frames
 * and popups. This is the fallback for the documents that never make a request.
 * The install script is idempotent, so the two routes overlapping is harmless
 * and either one alone is not sufficient.
 */
async function instrument(target: Page | BrowserContext): Promise<void> {
	await target.addInitScript({ content: installScript() });
	await target.addInitScript(OBSERVER);
}

/**
 * Why a crash-kind file is recorded as surviving.
 *
 * `signal` is the event the runner did observe, so it is named as observed.
 * Printing it as the event that did *not* arrive reports the opposite of what
 * happened, and the settle reason is the only thing a reader of the report has
 * to go on.
 */
function describeCrashObservation(
	navigated: boolean,
	signal: string | undefined,
): string {
	if (navigated) {
		return "a frame navigation";
	}
	return signal === undefined
		? "no frame navigation and no event"
		: `no frame navigation, and a ${signal} event`;
}

function survivedNote(
	kind: FileOutcome["kind"],
	navigated: boolean,
	signal: string | undefined,
): string {
	if (kind !== "crash") {
		return "";
	}
	return `survived; observed ${navigated ? "a frame navigation" : (signal ?? "completion")}`;
}

async function runUnit(
	browser: Browser,
	origin: string,
	unit: string,
	options: RunSuiteOptions,
): Promise<FileOutcome> {
	const body = options.bodies.get(unit);
	if (body === undefined) {
		return {
			unit,
			kind: "harness",
			status: "did-not-complete",
			results: [],
			note: "absent from the served file set",
		};
	}
	const kind: FileOutcome["kind"] = isHarnessFile(unit, body)
		? "harness"
		: "crash";
	const context = await browser.newContext();
	let report: HarnessPayload | undefined;
	let signal: string | undefined;
	let crashed = false;
	let closed = false;
	let navigated = false;
	let settle: (() => void) | undefined;
	const finished = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let expire: (() => void) | undefined;
	const bound = new Promise<void>((resolve) => {
		expire = () => {
			resolve();
		};
		setTimeout(resolve, options.fileTimeoutMs);
	});

	const verdict = (
		status: FileOutcome["status"],
		results: readonly SubtestResult[],
		note: string,
	): FileOutcome => ({
		unit,
		kind,
		status,
		results,
		note,
	});

	try {
		const page = await context.newPage();
		await instrument(page);
		observe(page, options);
		page.on("crash", () => {
			crashed = true;
			settle?.();
		});
		page.on("close", () => {
			closed = true;
			settle?.();
		});
		page.on("framenavigated", (frame) => {
			// Only a crash file settles on this. A harness file routinely
			// navigates frames, and settling there would end it before it ran.
			if (kind === "crash" && frame !== page.mainFrame()) {
				navigated = true;
				settle?.();
			}
		});
		await page.exposeBinding(
			"__axHarness",
			(_source, payload: HarnessPayload) => {
				if (payload.kind === "signal") {
					// Only a crash file settles on an observed event. A harness
					// file settles on its report, and this suite fires
					// `toolchange` constantly.
					if (kind === "crash") {
						signal = payload.signal;
						settle?.();
					}
					return;
				}
				report = payload;
				settle?.();
			},
		);
		await page.exposeBinding("__axObserved", (_source, name: string) => {
			if (kind === "crash") {
				signal = name;
				settle?.();
			}
		});
		// The response injection in `startSuiteServer` is what instruments every
		// document that arrives over HTTP, in every engine. These are for the
		// documents that never make a request, namely a frame's initial
		// about:blank. Installing per page as new pages *appear* was tried and
		// abandoned: on Firefox it races page disposal and throws from the
		// protocol channel. The install script is idempotent, so the two routes
		// overlapping is harmless and either one alone is not sufficient.
		await instrument(context);
		await page.goto(`${origin}${requestPathFor(unit)}`, { waitUntil: "load" });
		await Promise.race([finished, bound]);
		expire?.();

		if (crashed) {
			return verdict("fail", [], "the browser process crashed");
		}
		if (report === undefined) {
			if (kind === "crash") {
				if (closed) {
					return verdict("fail", [], "the page closed");
				}
				return verdict(
					"pass",
					[],
					`survived; observed ${describeCrashObservation(navigated, signal)}`,
				);
			}
			return verdict(
				closed ? "fail" : "did-not-complete",
				[],
				closed
					? "the page closed before reporting"
					: "the harness never reported completion",
			);
		}
		const results = report.results ?? [];
		const failing = results.filter((result) => result.status !== "PASS");
		if (failing.length > 0) {
			return verdict("fail", results, survivedNote(kind, navigated, signal));
		}
		if ((report.harnessStatus ?? 0) !== HARNESS_OK) {
			// The harness disagreed with every subtest it reported. Recorded
			// rather than dropped, because a file that fails for a reason the
			// subtests do not carry is exactly the failure a report must not
			// lose.
			return verdict(
				"fail",
				[
					{
						name: "harness",
						status: "FAIL",
						message: `completion code ${report.harnessStatus} with no failing subtest`,
					},
				],
				survivedNote(kind, navigated, signal),
			);
		}
		return verdict("pass", results, survivedNote(kind, navigated, signal));
	} catch (error) {
		return verdict("did-not-complete", [], `runner error: ${String(error)}`);
	} finally {
		await context.close();
	}
}

/** Run every unit on `browser`, in the order given, and report each outcome. */
export async function runSuite(
	browser: Browser,
	options: RunSuiteOptions,
): Promise<SuiteRun> {
	const server = await startSuiteServer(options.bodies, REPORTER, {
		path: INSTALL_SCRIPT_PATH,
		source: installScript(),
	});
	const files: FileOutcome[] = [];
	try {
		for (const unit of options.units) {
			files.push(await runUnit(browser, server.origins.self, unit, options));
		}
	} finally {
		await server.close();
	}
	return {
		browserName: browser.browserType().name(),
		browserVersion: browser.version(),
		files,
	};
}
