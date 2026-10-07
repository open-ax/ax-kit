#!/usr/bin/env node
/**
 * Write the API report, and fail the build when it has changed.
 *
 * This is the drift gate, and its whole purpose is to make a public-signature
 * change fail the build rather than accumulate as documentation debt. Two things
 * make that work, and both are properties of this script rather than of the
 * documentation:
 *
 * **The report is committed.** A reviewer sees the reference diff beside the code
 * diff, so the change to the interface and the change to the words about it are
 * reviewed together. A gate whose only output is a red build teaches people to
 * look for the flag that makes it green.
 *
 * **Regenerating with no source change produces no diff.** That is verified here,
 * on every run, rather than assumed. If the report were unstable the gate would
 * fire on unrelated changes and would be turned off within a week, and an off
 * gate is worse than no gate because it is still displayed.
 *
 * ## What it does not check
 *
 * Prose. A page containing a claim that has gone stale is a documentation defect,
 * and no amount of signature comparison catches it. What this catches is the case
 * that is not a defect at all: a reference describing a signature that no longer
 * exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAllPackages, serialise } from "./public-interface.mjs";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPORT_PATH = join(SITE, "src/data/api-report.json");

/**
 * The report, as it stands on disk.
 *
 * Returns `undefined` when the file is absent. That is a defect rather than a
 * first run: the report is committed, so a checkout without one has lost a
 * tracked file, and the caller treats it as a failure.
 */
function readCommitted() {
	if (!existsSync(REPORT_PATH)) {
		return undefined;
	}
	return readFileSync(REPORT_PATH, "utf8");
}

const current = serialise(readAllPackages());
const committed = readCommitted();

if (committed === undefined) {
	// Writing the report and exiting 0 was the original behaviour, and it made
	// the gate meaningless in the one place that matters: deleting
	// `api-report.json` in a pull request removed the committed baseline, so
	// there was nothing to compare against and the gate reported success for
	// *any* interface whatsoever. The gate could be disabled by deleting the file
	// that defines it.
	//
	// Generation is a separate, explicit step (`generate:reference`). A missing
	// report means the change has not been reviewed, which is exactly what this
	// gate exists to prevent.
	process.stderr.write(
		`[reference] ${REPORT_PATH} is missing. It is committed, so its absence is a\n` +
			`           deleted file rather than a first run. Generate and commit it:\n` +
			`             pnpm --filter @ax-kit/docs-site generate:reference\n`,
	);
	process.exit(1);
}

if (committed === current) {
	process.stdout.write("[reference] the public interface is unchanged\n");
	process.exit(0);
}

/**
 * A readable diff, because "the build failed" is not a reviewable artifact.
 *
 * Reported per package and per entry point rather than as one line, because a
 * maintainer needs to know *which* package changed to know whether to regenerate
 * the pages or to look for a mistake. The committed file is left alone: writing
 * the new report automatically would turn a gate into a rubber stamp, since the
 * build would go green on the same run that quietly approved the change.
 */
function toEntry(value) {
	return [value.name, value];
}

function describe() {
	// Compared as a map keyed by package name, not as arrays.
	//
	// `readAllPackages` returns `{ packages: [...] }` — an object with one
	// meaningful key, because that is the shape the report is written in. Walking
	// it as though it were the package list itself compares `packages` to a package
	// name and reports every member of every package as added and removed at once,
	// which is both unreadable and hides the one line that matters.
	const before = new Map(JSON.parse(committed).packages.map(toEntry));
	const after = new Map(JSON.parse(current).packages.map(toEntry));
	const lines = [
		"[reference] the public interface changed without a change to the reference:",
		"",
	];

	// Packages present in the committed report and gone from the current one are
	// reported too, rather than only in the other direction. A package removed
	// from the workspace is the most consequential change on this list and the
	// easiest to miss.
	for (const name of before.keys()) {
		if (after.get(name) === undefined) {
			lines.push(`  - package ${name} (removed)`);
		}
	}

	for (const [name, entry] of after) {
		const previous = before.get(name);
		if (previous === undefined) {
			lines.push(`  + package ${name} (${entry.version})`);
			continue;
		}
		if (previous.version !== entry.version) {
			lines.push(`  ~ ${name} ${previous.version} -> ${entry.version}`);
		}
		for (const [subpath, value] of Object.entries(entry.entries)) {
			const prior = previous.entries?.[subpath];
			if (prior === undefined) {
				lines.push(`  + ${name} ${subpath} (new entry point)`);
				continue;
			}
			const beforeNames = new Set(prior.members.map((member) => member.name));
			const afterNames = new Set(value.members.map((member) => member.name));
			for (const member of value.members) {
				if (!beforeNames.has(member.name)) {
					lines.push(`  + ${name} ${subpath} ${member.name}`);
				}
			}
			for (const priorName of beforeNames) {
				if (!afterNames.has(priorName)) {
					lines.push(`  - ${name} ${subpath} ${priorName}`);
				}
			}
			// A member whose *kind* changed — a function that became a type, an
			// interface that became an alias — is a different member as far as a
			// consumer is concerned, and a name-only comparison would report
			// nothing.
			const beforeKinds = new Map(
				prior.members.map((member) => [member.name, member.kind]),
			);
			for (const member of value.members) {
				const priorKind = beforeKinds.get(member.name);
				if (priorKind !== undefined && priorKind !== member.kind) {
					lines.push(
						`  ~ ${name} ${subpath} ${member.name} ${priorKind} -> ${member.kind}`,
					);
				}
			}

			// A member whose *signature* changed, under an unchanged name and kind.
			//
			// This is the case the gate's stated invariant is actually about, and it
			// was the one it could not see: `searchProducts(input: SearchInput)`
			// becoming `searchProducts(input: string)` adds no name, removes no name
			// and changes no kind, so every other comparison in this function
			// reported nothing and the build went green over a breaking change.
			//
			// Both sides are printed because "the signature changed" is not
			// actionable; a maintainer needs to see the two declarations to know
			// whether to regenerate or to look for a mistake.
			const beforeSignatures = new Map(
				prior.members.map((member) => [member.name, member.signature]),
			);
			for (const member of value.members) {
				const priorSignature = beforeSignatures.get(member.name);
				if (
					priorSignature !== undefined &&
					priorSignature !== member.signature
				) {
					lines.push(
						`  ~ ${name} ${subpath} ${member.name} signature changed:`,
					);
					lines.push(`      was: ${priorSignature}`);
					lines.push(`      now: ${member.signature}`);
				}
			}
		}

		// Entry points that existed and no longer do. A removed subpath is a
		// breaking change and appears here rather than being silently absent.
		for (const subpath of Object.keys(previous.entries ?? {})) {
			if (entry.entries[subpath] === undefined) {
				lines.push(`  - ${name} ${subpath} (entry point removed)`);
			}
		}
	}

	lines.push("");
	lines.push(
		"  Either the reference pages need updating, or this change is internal",
	);
	lines.push("  and did not belong on the public surface.");
	lines.push("");
	lines.push(`  To accept it, regenerate the report and the pages together:`);
	lines.push(`    pnpm --filter @ax-kit/docs-site generate:reference`);
	lines.push("");
	lines.push(`  ${REPORT_PATH}`);
	return lines.join("\n");
}

process.stderr.write(`${describe()}\n`);
process.exit(1);
