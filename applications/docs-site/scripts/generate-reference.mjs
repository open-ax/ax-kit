#!/usr/bin/env node
/**
 * Generate the API reference page from the public interface.
 *
 * The page is written, not hand-maintained. For a project whose product is a
 * correctness claim, a reference describing a signature that no longer exists is
 * not a documentation defect — so the reference is derived from the same
 * extractor the drift gate reads, and cannot describe something absent.
 *
 * ## What this generates, and what it refuses to
 *
 * Names, entry points, kinds, and which entry point reaches each. **Not** parameter
 * types, and **not** specification prose.
 *
 * Two different reasons. Copying parameter types means re-implementing a
 * TypeScript printer, and the result would be a worse rendering of something a
 * reader can get from the declarations. Copying prose means the specification's
 * text becomes a second source of truth here that will be wrong within days — so
 * the page links to the draft instead, and names which dated draft it describes.
 *
 * ## Extensions are separable at a glance
 *
 * Each subpath gets its own group and is labelled. A reader must be able to tell
 * which names they can rely on being standard and which are this project's,
 * reachable only through their own entry point. If that is not visible on the
 * page, the reader assumes all of it is standard.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAllPackages, serialise } from "./public-interface.mjs";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(SITE, "../..");
const OUT = join(SITE, "src/content/docs/reference");
const REPORT = join(SITE, "src/data/api-report.json");

/**
 * The draft this page describes, read from the package rather than restated here.
 *
 * A reference page naming a different draft than the code implements is the exact
 * failure this project exists to avoid, and a literal string in a script is a
 * second place for the two to drift.
 *
 * Parsed out of `constants.ts` rather than imported: this script runs before any
 * build has happened in a fresh checkout, so the built declarations it reads may
 * not exist yet. The source is the same file the package exports the constant
 * from, and a value that appears in two places is a value that can differ.
 */
function pinnedDraft() {
	const source = readFileSync(
		join(REPO, "packages/core/src/constants.ts"),
		"utf8",
	);
	const draft = /draft:\s*"([^"]+)"/.exec(source);
	const commit = /commit:\s*"([^"]+)"/.exec(source);
	if (draft === null || commit === null) {
		throw new Error(
			"could not read SPEC_VERSION from packages/core/src/constants.ts",
		);
	}
	return { draft: draft[1], commit: commit[1] };
}

/** Escape for a markdown table cell. A `|` in a member name would break the row. */
function cell(value) {
	return String(value).replace(/\|/g, "\\|");
}

function kindLabel(kind) {
	if (kind === "const" || kind === "let") {
		return "value";
	}
	// A name re-exported from another module with no local declaration. Its kind is
	// not knowable from this package's declarations, and guessing is what put
	// `expect` — a runtime value re-exported from `@playwright/test` — in the
	// types table.
	if (kind === "unknown") {
		return "re-exported";
	}
	return kind;
}

/**
 * Plural labels, where appending `s` is wrong.
 *
 * `class` is the only one English breaks with a suffix, and it broke visibly:
 * the generated page read `### classs (2)` for four packages. It is spelled out
 * rather than computed because a one-entry map is shorter than the rule that
 * would produce it correctly for the other four kinds.
 */
const KIND_PLURAL = { class: "classes" };

/**
 * Kinds that exist only in the type system.
 *
 * A copyable import example has to compile, and `import { SomeInterface }` is an
 * error under `isolatedModules` and most bundlers' verbatim-module-syntax
 * handling. The first `@ax-kit/cli` member is `AuditContextInput`, a type, so the
 * generated page offered a snippet that would not build.
 */
const TYPE_ONLY_KINDS = new Set(["interface", "type"]);

/**
 * Kind groups, in the order a reader wants them: callable things, then types,
 * then names whose kind this package's declarations do not state.
 *
 * `unknown` is last and always present in the list rather than appended on demand,
 * because a name dropped from the page is worse than a name shown under a label
 * admitting the label is all we know.
 */
const KIND_ORDER = [
	"function",
	"const",
	"class",
	"interface",
	"type",
	"unknown",
];

function packageSection(entry) {
	const entryPoints = Object.entries(entry.entries);
	const all = entryPoints.flatMap(([, value]) => value.members);
	const isRoot = (subpath) => subpath === ".";

	const lines = [];
	lines.push(`## ${entry.name}`, "");
	lines.push(
		`${all.length} exported ${all.length === 1 ? "name" : "names"} across ${entryPoints.length} ${entryPoints.length === 1 ? "entry point" : "entry points"}.`,
		"",
	);
	lines.push(
		entry.dependencies.length === 0
			? "No runtime dependencies."
			: `Runtime dependencies: ${entry.dependencies.map((name) => `\`${name}\``).join(", ")}.`,
		"",
	);

	lines.push("### Entry points", "");
	lines.push("| Entry point | Names | Reached by |");
	lines.push("|---|---|---|");
	for (const [subpath, value] of entryPoints) {
		const specifier = isRoot(subpath)
			? entry.name
			: `${entry.name}/${subpath.replace(/^\.\//, "")}`;
		// The import is spelled with a named member rather than an ellipsis.
		// A reference a reader copies has to compile, and `import { … }` does not.
		// A type-only member additionally needs `import type`, or the snippet is
		// an error rather than merely a value the runtime cannot find.
		const first = value.members[0];
		const keyword = TYPE_ONLY_KINDS.has(first?.kind) ? "import type" : "import";
		const example =
			first === undefined
				? `\`import "${specifier}"\``
				: `\`${keyword} { ${first.name} } from "${specifier}"\``;
		lines.push(
			`| \`${cell(subpath)}\` | ${value.members.length} | ${example} |`,
		);
	}
	lines.push("");

	if (entryPoints.length > 1) {
		const extra = entryPoints.length - 1;
		lines.push(
			`Only \`.\` carries the specification's surface. The other ${extra} ${extra === 1 ? "entry point is" : "entry points are"} this project's own additions, reachable only through ${extra === 1 ? "that subpath" : "those subpaths"}. The default import never exposes ${extra === 1 ? "it" : "them"}, so a conformance run cannot observe ${extra === 1 ? "it" : "them"}.`,
			"",
		);
	}

	for (const kind of KIND_ORDER) {
		const group = all
			.filter((member) => member.kind === kind)
			.sort((a, b) => a.name.localeCompare(b.name));
		if (group.length === 0) {
			continue;
		}
		// Singular for one member, the irregular plural where English has one, and a
		// plain `s` otherwise.
		const singular = kindLabel(kind);
		const label =
			group.length === 1 ? singular : (KIND_PLURAL[kind] ?? `${singular}s`);
		lines.push(`### ${label} (${group.length})`, "");
		lines.push("| Name | Entry point |");
		lines.push("|---|---|");
		for (const member of group) {
			// One name can be reachable from more than one entry point in a
			// re-exporting package, so the entry point is looked up rather than
			// remembered.
			const reachable = entryPoints
				.filter(([, value]) =>
					value.members.some((entry_) => entry_.name === member.name),
				)
				.map(([subpath]) => `\`${cell(subpath)}\``)
				.join(", ");
			lines.push(`| \`${cell(member.name)}\` | ${reachable} |`);
		}
		lines.push("");
		if (kind === "unknown") {
			lines.push(
				"These are re-exported from another module, so this package's own",
				"declarations do not state whether each is a value or a type. They are",
				"listed rather than guessed at, and grouped here rather than with the types.",
				"",
			);
		}
	}

	return lines.join("\n");
}

const { packages } = readAllPackages();
const spec = pinnedDraft();

const front = [
	"---",
	// `draft: false` is not optional. The documentation framework filters entries
	// to those explicitly marked as not drafts in a production build, so a page
	// without it is silently omitted from the output — a build that reports
	// success and ships nothing. Every generated page therefore carries it, and
	// `test/browser.ts` asserts the page exists in the built output.
	"draft: false",
	"title: API reference",
	"description: Every exported name, grouped by entry point, generated from the published type declarations.",
	"---",
	"",
	"This page is **generated** from the published type declarations of every package in this",
	"repository. It is not hand-maintained, and a change to a public signature that does not",
	"reach this page fails the build. See",
	"[`scripts/verify-reference.mjs`](https://github.com/open-ax/ax-kit/blob/main/applications/docs-site/scripts/verify-reference.mjs).",
	"",
	`It describes **${spec.draft}** (upstream \`${spec.commit}\`). Every page on this site that`,
	"describes behaviour names the draft it describes, because the proposal is re-dated often",
	"and a reader comparing this page with the specification needs to know whether they are",
	"reading the same thing.",
	"",
	"The specification itself is [linked, not copied](https://webmachinelearning.github.io/webmcp/).",
	"A Community Group draft that has been re-dated four times in eight days will make any text",
	"copied here wrong within days, and a second source of truth that is wrong is worse than no",
	"second source of truth.",
	"",
	"## Reading this page",
	"",
	"- **The default entry point is the specification's surface.** Every name on `.` traces to a",
	"  dated draft of the proposal.",
	"- **Other subpaths are this project's own**, documented as such, and unreachable from the",
	"  default import.",
	"- **No parameter types appear here.** They are in the `.d.ts` files, which is what a",
	"  consumer's compiler reads; a table paraphrasing them would be a worse copy.",
	"- **Verification is never defined by the default entry point.** Call",
	"  `installModelContext(document)` yourself. A package that installs on import as a side",
	"  effect cannot be tree-shaken, and a polyfill that runs when a bundler happens to",
	"  evaluate a module is a debugging session.",
	"- **`@ax-kit/core/auto` is the deliberate exception.** It is this project's own entry",
	"  point, not the specification's, and it installs on import for frameworks that have no",
	"  client entry hook to run an explicit call from. The default entry point never does.",
	"",
];

mkdirSync(OUT, { recursive: true });
writeFileSync(
	join(OUT, "api.mdx"),
	`${front.join("\n")}${packages.map(packageSection).join("\n")}`,
	"utf8",
);

const nameCount = packages
	.flatMap((entry) => Object.values(entry.entries))
	.reduce((total, value) => total + value.members.length, 0);

// The report is regenerated here rather than only by the gate, because the gate's
// failure message tells a maintainer to run this command. A regeneration that fixed
// the page but left the report stale would send the next person round the loop once
// more — which is how a gate gets stopped being run.
writeFileSync(REPORT, serialise({ packages }), "utf8");

process.stdout.write(
	`[reference] wrote the API page for ${packages.length} packages, ${nameCount} names, and refreshed the interface report\n`,
);
