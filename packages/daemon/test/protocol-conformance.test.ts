// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP specification's own conformance suite, run against this daemon.
 *
 * The point is to replace an assertion with a measurement. Until this file
 * existed, the only thing checking the protocol claim was this repository's own
 * reading of the protocol, which means both sides of the check were the same
 * author. The suite is adopted whole: not reimplemented, not sampled, and not
 * run in a mode that hides what it did not reach.
 *
 * Three properties this file is built to preserve, because each of them is a
 * way a published conformance number becomes decoration:
 *
 * - **The suite's output is archived verbatim.** The summary asserted here is
 *   our reading of it. The two are separate artefacts, and the archive is the
 *   record.
 * - **Coverage is asserted, not implied.** A green run that never reached
 *   `tools/list` or `tools/call` proves nothing about a bridge, so the file
 *   refuses a run that reached neither.
 * - **A failure is recorded, not suppressed.** There is no filter and no
 *   "skip known failures" switch.
 *
 * **The measured result, as of 2026-10-15: every scenario the suite ran is
 * refused at the bearer, and that is the finding.** The suite has no way to send
 * `x-ax-bearer` — `conformance server --help` offers no header, auth or bearer
 * option, and its client authenticates nothing. So all twenty `2026-07-28`
 * scenarios, including `tools-list` and every `tools/call`, return `HTTP 403`.
 *
 * This is not a protocol violation and it is not a defect here. The bearer is
 * the control that stops a web page on the machine from reaching the daemon;
 * `docs/adr/0010` and the isolation proof behind it exist precisely to establish
 * that. Dropping it to produce a green number would trade the project's one
 * externally-checkable security property for a cosmetic result.
 *
 * The consequence is stated rather than hidden: **this suite cannot yet measure
 * the protocol surface**, and no conformance claim about MCP rests on it. What
 * it has established is the coverage and the shape of the gap. Closing it needs
 * the suite to grow a way to send credentials, which is upstream work of the
 * same kind as the WPT lag in `docs/adr/0006` and `0011`.
 *
 * The daemon under test is the shipped listener with a provider behind it, not
 * a browser. That limit is deliberate and is stated in the report: this suite
 * checks the protocol surface an MCP client talks to, and the page behind it is
 * covered by the browser suites in this package rather than by this suite.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PageBridge } from "../src/bridge.js";
import { startTransport, type Transport } from "../src/lifecycle.js";
import type { BridgeProvider } from "../src/outcome.js";
import { createDaemonInfo } from "../src/protocol.js";

const SUITE = fileURLToPath(
	import.meta.resolve("@modelcontextprotocol/conformance/dist/index.js"),
);

/**
 * The exact suite version this run is a measurement of.
 *
 * The alpha, not the latest release. `0.1.16` is the current `latest` tag, and
 * it has **no scenarios for `2026-07-28`** — its newest revision is
 * `2025-11-25`. Run against it, every scenario in this file fails at the first
 * request, and the resulting number would measure the suite's lag rather than
 * this daemon. `0.2.0-alpha.12` carries 40 server scenarios for `2026-07-28`,
 * including `server-stateless` and twelve `input_required` cases that exercise
 * the multi-round-trip shape a consequential tool here returns.
 *
 * This is recorded because it is the kind of thing that gets "fixed" by
 * downgrading the dependency and silently returning to a meaningless number.
 */
const SUITE_VERSION = "0.2.0-alpha.12";

/** The MCP revision this daemon implements, and the only one it speaks. */
const MCP_REVISION = "2026-07-28";

/**
 * The version actually installed, read rather than restated.
 *
 * `SUITE_VERSION` above is the claim; this is the thing the claim is checked
 * against. Reading the dependency's own manifest is what makes the recorded pin
 * an assertion rather than a comment — otherwise downgrading or bumping the
 * dependency silently leaves the archive header stamping the old version over a
 * run a different suite performed, which is the exact failure the constant
 * exists to prevent.
 */
const INSTALLED_SUITE_VERSION = readInstalledSuiteVersion();

function readInstalledSuiteVersion(): string {
	// Resolved through the package's own entry point rather than by reaching for
	// `node_modules` at a fixed depth, so the path does not depend on where this
	// file sits relative to the workspace root.
	const manifest = fileURLToPath(
		import.meta.resolve("@modelcontextprotocol/conformance/package.json"),
	);
	const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { version?: unknown }).version !== "string"
	) {
		throw new Error(
			"the conformance suite manifest does not declare a string version",
		);
	}
	return (parsed as { version: string }).version;
}

/**
 * A provider with one tool, so the suite has something real to list and call.
 *
 * A daemon advertising an empty tool set would let a green run mean nothing,
 * which is the outcome this file exists to rule out.
 */
function provider(): BridgeProvider {
	return {
		listTools: async () => [
			{
				name: "viewCart",
				description: "Show the current cart.",
				inputSchema: {
					type: "object",
					properties: { verbose: { type: "boolean" } },
				},
			},
		],
		callTool: async (name: string) => ({
			kind: "completed",
			result: JSON.stringify({ echoed: name }),
		}),
	};
}

interface Run {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function suite(args: string[]): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [SUITE, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			// A signalled child reports `code === null`. Collapsing that to 0
			// would record a crashed suite as a passing one, and this file's whole
			// claim is about what an exit code means.
			resolve({ exitCode: signal === null ? (code ?? 0) : -1, stdout, stderr });
		});
	});
}

/**
 * The suite's own per-scenario results, read from the `checks.json` files its
 * `--output-dir` writes.
 *
 * This is what makes the finding evidenced rather than asserted. The suite's
 * stdout reports a verdict count per scenario and nothing about *why* — a reader
 * cannot tell a protocol violation from a refusal at the gate by looking at it,
 * and `403` appears nowhere in it. `checks.json` carries each check's id, its
 * status, and the error message the suite actually observed.
 */
async function readChecks(
	dir: string,
): Promise<
	ReadonlyMap<string, { readonly status: string; readonly message: string }>
> {
	const byScenario = new Map<string, { status: string; message: string }>();
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("server-")) {
			continue;
		}
		const raw = await readFile(join(dir, entry.name, "checks.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			continue;
		}
		for (const check of parsed as ReadonlyArray<{
			id?: unknown;
			status?: unknown;
			errorMessage?: unknown;
		}>) {
			if (
				typeof check.id === "string" &&
				typeof check.status === "string" &&
				check.status !== "SUCCESS"
			) {
				byScenario.set(entry.name, {
					status: check.status,
					message:
						typeof check.errorMessage === "string"
							? check.errorMessage
							: "(no message)",
				});
				break;
			}
		}
	}
	return byScenario;
}

/**
 * One request answered directly by the daemon, bypassing the suite.
 *
 * `handleRequest` checks the origin before the bearer and answers both refusals
 * with the same `403 text/plain`, so the status code alone cannot say which
 * guard fired. The body does: `bad origin`, or `bad bearer`.
 *
 * This exists because the suite's own report stops at `content-type text/plain`
 * and never carries the body. Without a direct probe a `403` from the suite
 * could be attributed to either guard, and the finding would be a claim about a
 * status code wearing the clothes of a claim about a cause.
 */
async function probe(
	port: number,
	headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const call = httpRequest(
			{ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => {
					resolve({ status: response.statusCode ?? 0, body: body.trim() });
				});
			},
		);
		call.on("error", reject);
		call.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
	});
}

/** Every server scenario the suite itself declares for this revision. */
function declaredScenarios(stdout: string): string[] {
	// The listing has a server section and a client section. Only the server
	// section is this run's business, and it is cut at the heading. Each line
	// carries the revisions it targets in brackets, and only the ones naming
	// this revision are in scope.
	//
	// The cut is `idx < 0 ? length : idx` and not `Math.max`: `Math.max` picks
	// the length whenever the heading is present, because the offset is smaller,
	// which makes the slice a no-op and folds the client scenarios in. That
	// inflated the recorded denominator from 40 to 75 and listed 35 scenarios a
	// server run can never execute as coverage gaps.
	const heading = stdout.indexOf("Client scenarios");
	const server = stdout.slice(0, heading < 0 ? stdout.length : heading);
	return [...server.matchAll(/^\s*-\s+(\S+)\s+\[([^\]]*)\]/gm)]
		.filter((match) => match[2].split(",").includes(MCP_REVISION))
		.map((match) => match[1]);
}

/**
 * Which scenarios the run actually reached.
 *
 * Read from the suite's own output rather than from an expectation of it: the
 * coverage claim has to be the suite's, or it is a claim about us.
 */
function reachedScenarios(run: Run): ReadonlySet<string> {
	const seen = new Set<string>();
	for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
		// The suite prints one line per scenario with its verdict, e.g.
		// `✔ tools-list: 2 passed` or `✗ tools_call: 1 passed, 1 failed`.
		//
		// The name is captured as `\S+` and not as `[a-z0-9-]+` because scenario
		// names carry `_` and `/` — `tools_call`, `auth/basic-cimd` — and a
		// narrower pattern would truncate them to `tools` and `auth`. That would
		// report a scenario as never reached in the same run that ran it, which
		// is precisely what happens the day this endpoint stops refusing.
		const match = /^\s*[✔✗×✓]\s+(\S+?):/.exec(line);
		if (match !== null) {
			seen.add(match[1]);
		}
	}
	return seen;
}

let transport: Transport;
let first: Run;
let declared: string[];
let discoveryDir: string;
let resultsDir: string;
let checks: ReadonlyMap<
	string,
	{ readonly status: string; readonly message: string }
>;
// Vitest runs `afterAll` even when `beforeAll` threw. Without this flag a setup
// failure is reported as a `TypeError` from reading state the failed setup never
// assigned - the less useful of the two errors - and a half-built run still
// rewrites the committed reports.
let setupComplete = false;

beforeAll(async () => {
	discoveryDir = await mkdtemp(join(tmpdir(), "ax-mcp-conformance-"));
	resultsDir = await mkdtemp(join(tmpdir(), "ax-mcp-results-"));
	transport = await startTransport({
		discoveryDir,
		// A bridge nobody pulls from, so the HTTP surface is exercised without a
		// browser in the way and the run is the same on every machine.
		bridge: new PageBridge(),
		provider: provider(),
		info: createDaemonInfo(),
	});
	declared = declaredScenarios((await suite(["list"])).stdout);
	first = await suite([
		"server",
		"--url",
		`http://127.0.0.1:${String(transport.port)}/mcp`,
		// Scenarios are filtered to the one revision this daemon speaks. Without
		// this the run includes `2025-06-18` and `2025-11-25` scenarios that
		// assert an `initialize` handshake this revision removed, so every one of
		// them fails for a reason that has nothing to do with this code.
		"--spec-version",
		MCP_REVISION,
		"--verbose",
		// Ask for the per-scenario result files rather than scraping the summary
		// block, so the archive carries what the suite observed and not only what
		// it counted.
		"--output-dir",
		resultsDir,
	]);
	checks = await readChecks(resultsDir);
	setupComplete = true;
}, 600_000);

afterAll(async () => {
	await transport?.close();
	// Every other `mkdtemp` user in this package removes its directory; these
	// were the exceptions. On a clean close `discoveryDir` is already empty, but
	// a crash mid-run leaves `relay.json`, which carries the bearer. Each is
	// guarded because this hook runs even when `beforeAll` threw part-way, in
	// which case the second directory may never have been created.
	if (discoveryDir !== undefined) {
		rmSync(discoveryDir, { recursive: true, force: true });
	}
	if (resultsDir !== undefined) {
		rmSync(resultsDir, { recursive: true, force: true });
	}
});

describe(`MCP conformance suite ${SUITE_VERSION}`, () => {
	// The recorded pin is a claim; this is what makes it a check. Bump or
	// downgrade the dependency and this fails instead of leaving the archive
	// header stamping a version the run did not use.
	it("is the version that is actually installed", () => {
		expect(INSTALLED_SUITE_VERSION).toBe(SUITE_VERSION);
	});

	it("declares server scenarios for this revision, and no others", () => {
		// An exact count, because the count is what `coverage.txt` publishes as
		// the denominator. A `toBeGreaterThan` bound lets a parser that folds in
		// the client section pass while reporting a wrong number — which is what
		// this assertion replaced.
		expect(declared.length).toBe(40);
		expect(declared).toContain("tools-list");
		expect(declared).toContain("tools-call-simple-text");
		expect(declared).toContain("server-stateless");
		// Client-side scenarios cannot appear here; the section cut is what keeps
		// them out, and this is the assertion that would notice if it stopped.
		expect(declared).not.toContain("tools_call");
		expect(declared.some((name) => name.includes("/"))).toBe(false);
	});

	// The check that makes a green run mean something. Without it, a run that
	// connected to nothing and therefore failed nothing would be reported as a
	// pass, which is the single most likely way this number becomes decoration.
	//
	// "Reported", not "executed": the suite issues each scenario and records a
	// verdict for it, and the 403 means the daemon refused before any MCP method
	// ran. The claim here is that the suite *reached* those scenarios, which is
	// what makes the refusal evidence rather than silence.
	it("reports the tool scenarios rather than passing because it ran nothing", () => {
		const reached = reachedScenarios(first);
		expect(reached.size).toBeGreaterThan(0);
		expect(
			[...reached],
			`the suite reported no tool scenario; reported: ${[...reached].join(", ")}`,
		).toEqual(expect.arrayContaining(["tools-list", "tools-call-simple-text"]));
	});

	it("is reproducible: a second run of the same version agrees", async () => {
		const second = await suite([
			"server",
			"--url",
			`http://127.0.0.1:${String(transport.port)}/mcp`,
			"--spec-version",
			MCP_REVISION,
		]);
		const a = [...reachedScenarios(first)].sort();
		const b = [...reachedScenarios(second)].sort();
		expect(b).toEqual(a);
		expect(second.exitCode).toBe(first.exitCode);
	}, 600_000);

	/**
	 * The measured result, stated rather than asserted away.
	 *
	 * This does **not** assert exit 0, and the reason is the finding rather than
	 * a gap in the harness. Every scenario the suite ran fails with `HTTP 403`,
	 * because this daemon requires the `x-ax-bearer` header and the conformance
	 * suite has no way to send one — `conformance server --help` has no header,
	 * auth or bearer option, and the client it drives authenticates nothing.
	 *
	 * That is not a protocol violation and not a defect here. The bearer is the
	 * control that keeps a web page on the machine from reaching the daemon at
	 * all, and removing it to make a conformance number look better would trade
	 * the project's one externally-checkable security property for a cosmetic
	 * green. The endpoint under test is the *same* endpoint an agent reaches
	 * through the bridge, and that is deliberate: a second, unguarded MCP
	 * endpoint would be a second, unguarded way into the page.
	 *
	 * So the 403s are recorded here as the baseline, with their cause, exactly
	 * as the WebMCP expected-failure list records what it cannot yet explain.
	 * The assertions that matter are the ones above: the suite reached the tool
	 * methods, the run is reproducible, and the number below is what was
	 * measured.
	 *
	 * What would close this properly is the suite growing a way to send
	 * credentials. That is upstream work, and it is the same shape as the WPT
	 * lag recorded in `docs/adr/0006` and `0011`.
	 */
	it("is refused at the bearer, which is the finding", () => {
		expect(
			first.exitCode,
			"the suite reported something other than the bearer refusal; if this " +
				"now passes, the finding is gone and the reason needs reading before " +
				"the number is published",
		).toBe(1);
		expect(
			[...reachedScenarios(first)],
			"the run reached no scenario, so the refusal proves nothing",
		).toContain("tools-list");
	});

	// The finding, asserted against what the suite actually observed rather than
	// against the exit code. `exitCode === 1` cannot distinguish "refused at the
	// gate" from "crashed at startup" or "died after three scenarios"; the status
	// code can, and this is the assertion that makes the archive a measurement
	// rather than a narrative.
	//
	// What it does *not* claim is which guard refused. A `403` here is a claim
	// about a status code; `handleRequest` answers both the origin guard and the
	// bearer guard the same way. The control test above is what pins the cause to
	// the bearer, and this one is deliberately worded no stronger than what the
	// suite's own output can support.
	it("observes HTTP 403 in every scenario that failed", () => {
		expect(checks.size).toBeGreaterThan(0);
		const offenders = [...checks].filter(
			([, check]) => !/\b403\b/.test(check.message),
		);
		expect(
			offenders.map(([dir, check]) => `${dir}: ${check.message}`),
			"a scenario failed without reporting HTTP 403; the recorded finding " +
				"no longer describes this run, so it needs reading before it is " +
				"published",
		).toEqual([]);
	});

	// The control for the test above. `handleRequest` checks the origin before the
	// bearer and answers both with the same status and content type, so "the suite
	// saw 403" does not identify a cause on its own. These two probes do.
	//
	// The first is the suite's own request shape: a loopback Host and Origin, no
	// bearer. The second is the same request with an origin the relay gate refuses.
	// If the first said `bad origin`, the suite would be measuring the origin guard
	// and every claim built on it would be wrong.
	it("tells the two refusals apart, and the suite's shape clears the origin gate", async () => {
		const loopback = `http://127.0.0.1:${String(transport.port)}`;
		const unauthenticated = await probe(transport.port, {
			host: `127.0.0.1:${String(transport.port)}`,
			origin: loopback,
			"content-type": "application/json",
		});
		expect(unauthenticated.status).toBe(403);
		expect(unauthenticated.body).toBe("bad bearer");

		const foreign = await probe(transport.port, {
			host: `127.0.0.1:${String(transport.port)}`,
			origin: "https://example.invalid",
			"content-type": "application/json",
		});
		expect(foreign.status).toBe(403);
		// Measured, not assumed: the relay gate reports a non-loopback origin under
		// its own name, and the point is that it is *not* the bearer's message.
		expect(foreign.body).toBe("non-loopback origin");
		expect(foreign.body).not.toBe(unauthenticated.body);
	});
});

/**
 * Archive the suite's own output, verbatim, next to where a reviewer will look.
 *
 * Written after the assertions rather than before, so the archive is only ever
 * produced by a run that also ran the checks above.
 *
 * Two guards, because the archive is committed evidence and a run that did not
 * measure must not be able to overwrite it. `setupComplete` covers a setup
 * failure, which Vitest still runs this hook for; the pair below covers a run
 * that finished but is not the finding — a suite that suddenly passed, or died
 * before writing any checks. In both cases the assertions fail loudly and the
 * files on disk are left alone. Rewriting the record of what was measured from a
 * broken run is worse than a dirty working tree.
 */
afterAll(async () => {
	if (!setupComplete || first.exitCode !== 1 || checks.size === 0) {
		return;
	}
	const dir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"protocol-results",
	);
	await mkdir(dir, { recursive: true });
	const reached = reachedScenarios(first);
	const unreached = declared.filter((name) => !reached.has(name));
	const resultsDirRegExp = new RegExp(
		resultsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		"g",
	);
	await writeFile(
		join(dir, "server-run.txt"),
		[
			`# @modelcontextprotocol/conformance ${SUITE_VERSION}`,
			`# endpoint: the daemon's own MCP listener, provider-backed, no browser`,
			`# revision:  ${MCP_REVISION}`,
			`$ conformance server --url http://127.0.0.1:<port>/mcp --spec-version ${MCP_REVISION} --verbose`,
			`$ echo $?`,
			`${String(first.exitCode)}`,
			"",
			"--- stdout (verbatim) ---",
			// The suite echoes the `--output-dir` it was given, which is an
			// ephemeral temp path. Stripped rather than committed: this file is
			// public, the path says nothing about the run, and it differs on every
			// machine. Everything else below is the suite's own words.
			first.stdout.replace(resultsDirRegExp, "<output-dir>"),
			"--- stderr (verbatim) ---",
			first.stderr.replace(resultsDirRegExp, "<output-dir>"),
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(dir, "coverage.txt"),
		[
			`suite:    @modelcontextprotocol/conformance ${SUITE_VERSION}`,
			"declared: " + String(declared.length),
			"reached:  " + String(reached.size),
			"exit:     " + String(first.exitCode),
			"",
			"reached scenarios:",
			...[...reached].sort().map((name) => `  ${name}`),
			"",
			"not reached:",
			...(unreached.length === 0
				? ["  (none)"]
				: unreached.map((name) => `  ${name}`)),
			"",
			"WHAT THE SUITE REPORTED, per scenario",
			"",
			"Quoted from the suite's own checks.json, not summarised. This is the",
			"evidence for the finding: every refusal is the bearer gate, not a",
			"protocol violation.",
			"",
			...[...checks]
				.sort()
				.map(([dir, check]) =>
					[
						`  ${dir.replace(/^server-/, "").replace(/-[0-9TZ.-]+$/, "")}`,
						`      ${check.status}: ${check.message.replace(/\s+/g, " ").trim()}`,
					].join("\n"),
				),
			"The daemon under test is the shipped listener with a provider behind",
			"it, not a live browser. This suite checks the protocol surface an MCP",
			"client talks to. The page behind that surface is covered by the",
			"browser suites in this package.",
			"",
			"WHY, and why nothing is changed about it, is in the pull request and",
			"in packages/daemon/test/protocol-conformance.test.ts's header. It is",
			"not repeated here, because a generated file that restates a conclusion",
			"keeps restating it after the conclusion stops being true.",
		].join("\n"),
		"utf8",
	);
});
