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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
		child.on("close", (code) => {
			resolve({ exitCode: code ?? 0, stdout, stderr });
		});
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

beforeAll(async () => {
	discoveryDir = await mkdtemp(join(tmpdir(), "ax-mcp-conformance-"));
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
	]);
}, 600_000);

afterAll(async () => {
	await transport?.close();
	// Every other `mkdtemp` user in this package removes its directory; this one
	// was the exception. On a clean close the directory is already empty, but a
	// crash mid-run leaves `relay.json`, which carries the bearer.
	rmSync(discoveryDir, { recursive: true, force: true });
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
	it("reaches the tool methods rather than passing because it ran nothing", () => {
		const reached = reachedScenarios(first);
		expect(reached.size).toBeGreaterThan(0);
		expect(
			[...reached],
			`the suite never reached a tool method; reached: ${[...reached].join(", ")}`,
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
});

/**
 * Archive the suite's own output, verbatim, next to where a reviewer will look.
 *
 * Written after the assertions rather than before, so the archive is only ever
 * produced by a run that also ran the checks above.
 */
afterAll(async () => {
	const dir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"protocol-results",
	);
	await mkdir(dir, { recursive: true });
	const reached = reachedScenarios(first);
	const unreached = declared.filter((name) => !reached.has(name));
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
			first.stdout,
			"--- stderr (verbatim) ---",
			first.stderr,
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
			"MEASURED RESULT",
			"",
			`Every scenario above was refused with HTTP 403. This daemon requires`,
			"the x-ax-bearer header and the suite has no way to send one:",
			"`conformance server --help` offers no header, auth or bearer option.",
			"",
			"That is the finding, not a protocol violation and not a defect here.",
			"The bearer is what stops a web page on the machine from reaching the",
			"daemon, so it stays. No conformance claim about MCP rests on this run:",
			"what it establishes is the coverage and the shape of the gap.",
			"",
			"Closing it needs the suite to grow a way to send credentials.",
			"",
			"The daemon under test is the shipped listener with a provider behind",
			"it, not a live browser. This suite checks the protocol surface an MCP",
			"client talks to. The page behind that surface is covered by the",
			"browser suites in this package.",
		].join("\n"),
		"utf8",
	);
});
