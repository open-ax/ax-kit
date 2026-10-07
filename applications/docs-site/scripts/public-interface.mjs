/**
 * The public interface of every published package, extracted from the built
 * type declarations.
 *
 * This is the *source* for both the generated reference and the drift report.
 * One extractor, two consumers, and the reason is in the docs-site ADR: using
 * one tool for both jobs gives either documentation that drifts or a build that
 * fails on irrelevant changes. The split is between "write pages" and "write a
 * committed report that changes when the interface does".
 *
 * ## What counts as public
 *
 * Only what is reachable from an entry point. A declaration in `dist/` that no
 * export map points at is not public however visible it is in a file, and
 * including it would make the report change on internal refactors — which is
 * exactly the irrelevant change the gate must not fail on.
 *
 * Private and internal markers are honoured because this repository already has
 * them: a member documented as internal is excluded, so moving it between a
 * public class and an internal one is a deliberate act with a reviewable diff.
 *
 * ## Why the declarations rather than the source
 *
 * The `.d.mts` files are what a consumer's compiler reads, so they are what a
 * signature claim has to be true about. Reading the source would describe what
 * the package was written to be rather than what it offers.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PACKAGES = join(REPO, "packages");

/** JSDoc markers that take a declaration out of the public surface. */
const PRIVATE = /@(private|internal|package)\b/;

/**
 * Collapse a declaration file into one line per exported name.
 *
 * Not a TypeScript parse. A parser would be the better tool and would also be a
 * dependency this site does not otherwise need, for a report that only has to
 * notice *that* the interface changed, not parse it. The declaration syntax this
 * runs over is machine-generated and uniform: `declare` members, `export
 * declare` and `export {`, and nothing else.
 */
/**
 * Remove comments, keeping string literals intact.
 *
 * The naive `/\/\*[\s\S]*?\*\//g` would also eat a `/*` inside a string, and a
 * declaration file's documentation quotes both `//` and `/*` in its examples. A
 * scanner that tracks string and template state is the honest amount of machinery
 * for that.
 *
 * Comments are stripped because a declaration file quotes the specification's own
 * IDL in its documentation, and that IDL is written in declaration syntax — so
 * `interface ModelContext` inside a comment would otherwise be reported as an
 * export this package provides, which it does not.
 */
function stripComments(source) {
	let out = "";
	let index = 0;
	let quote = "";
	while (index < source.length) {
		const char = source[index];
		if (quote !== "") {
			out += char;
			if (char === "\\") {
				out += source[index + 1] ?? "";
				index += 2;
				continue;
			}
			if (char === quote) {
				quote = "";
			}
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			out += char;
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			while (index < source.length && source[index] !== "\n") {
				index += 1;
			}
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			index += 2;
			while (
				index < source.length &&
				!(source[index] === "*" && source[index + 1] === "/")
			) {
				index += 1;
			}
			index += 2;
			// The newlines are kept, so a member's position in the report still
			// corresponds to a line a maintainer would look up.
			out += "\n";
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

export function extractExports(source) {
	const exports = new Map();
	const lines = stripComments(source).split(/\r?\n/);

	// `export declare function name(...): T;` and `export declare const name`.
	const declared =
		/export\s+declare\s+(?:async\s+)?(function|const|class|let)\s+([A-Za-z0-9_$]+)/g;
	for (const line of lines) {
		declared.lastIndex = 0;
		let match = declared.exec(line);
		while (match !== null) {
			exports.set(match[2], { name: match[2], kind: match[1] });
			match = declared.exec(line);
		}
	}

	// `export { a, b as c };`, possibly spanning lines.
	const listed = /export\s+(?:type\s+)?\{([\s\S]*?)\}/g;
	for (
		let match = listed.exec(source);
		match !== null;
		match = listed.exec(source)
	) {
		for (const clause of match[1].split(",")) {
			const name = clause
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (name === undefined || name === "") {
				continue;
			}
			if (name.startsWith("type ")) {
				continue;
			}
			if (!exports.has(name)) {
				exports.set(name, { name, kind: "type" });
			}
		}
	}

	// Interfaces and type aliases, which are the bulk of this project's surface.
	const types = /export\s+(?:declare\s+)?(interface|type)\s+([A-Za-z0-9_$]+)/g;
	for (const line of lines) {
		types.lastIndex = 0;
		let match = types.exec(line);
		while (match !== null) {
			exports.set(match[2], { name: match[2], kind: match[1] });
			match = types.exec(line);
		}
	}

	return [...exports.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One package's public interface, keyed by entry point.
 *
 * Entry points come from the `exports` map rather than from the filesystem,
 * because the export map is the contract: a file in `dist/` that the map does not
 * name is unreachable and therefore not public.
 */
export function readPackageInterface(packageDir) {
	const manifestPath = join(packageDir, "package.json");
	if (!existsSync(manifestPath)) {
		return undefined;
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.private === true) {
		return undefined;
	}

	const entries = {};
	for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
		if (subpath.includes("*") || typeof target !== "object") {
			continue;
		}
		const importPath = target.import?.default;
		const types = target.import?.types ?? target.types;
		if (typeof types !== "string") {
			continue;
		}
		const declarationPath = join(packageDir, types);
		if (!existsSync(declarationPath)) {
			// A published package with no declarations has no describable interface,
			// and reporting that as empty would be indistinguishable from an empty
			// export map.
			continue;
		}
		const members = extractExports(readFileSync(declarationPath, "utf8"));
		entries[subpath] = {
			// The runtime artifact is recorded as well as the types, because "the
			// entry point resolves" and "it has declarations" are different facts
			// and a consumer's failure is often one of them and not the other.
			runtime: typeof importPath === "string" ? importPath : undefined,
			members,
		};
	}

	return {
		name: manifest.name,
		version: manifest.version,
		dependencies: Object.keys(manifest.dependencies ?? {}),
		entries,
	};
}

/**
 * Every publishable package's public interface, sorted by name.
 *
 * Sorted so that regenerating with no source change produces no diff. An
 * unsorted report would make the committed file depend on directory iteration
 * order, which is not stable across machines, and the drift gate would fire on
 * a reorganisation.
 */
export function readAllPackages() {
	const packages = readdirSync(PACKAGES)
		.filter((entry) => {
			const dir = join(PACKAGES, entry);
			return (
				statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))
			);
		})
		.map((entry) => readPackageInterface(join(PACKAGES, entry)))
		.filter((value) => value !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));

	return { packages };
}

/**
 * The report, as stable JSON.
 *
 * Every object's keys sorted, recursively — see `stableStringify` for why a
 * `JSON.stringify` replacer is not sufficient.
 */
export function serialise(report) {
	return `${stableStringify(report, "\t")}\n`;
}

/**
 * `JSON.stringify` with sorted keys at every level.
 *
 * Not a replacer function: a replacer receives an already-serialised subtree and
 * cannot reorder it, so sorting nested keys means rebuilding each object on the
 * way out. This matters because a package entry holds objects inside objects, and
 * unsorted output would make the committed report depend on key insertion order —
 * stable within one Node version and not across machines, which is precisely the
 * kind of instability that gets a gate switched off.
 */
function stableStringify(value, indent) {
	if (Array.isArray(value)) {
		const items = value.map((item) => stableStringify(item, indent));
		return items.length === 0
			? "[]"
			: `[\n${items.join(",\n")}\n${indent.slice(0, -1)}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.keys(value)
			.sort()
			// `undefined` is dropped rather than rendered: a member whose value is
			// undefined is absent from the interface, and writing `"x": undefined`
			// would make the report depend on which optional members a declaration
			// happens to spell out.
			.filter((key) => value[key] !== undefined)
			.map((key) => {
				const rendered = stableStringify(value[key], indent);
				return `${indent}${JSON.stringify(key)}: ${rendered.replace(/\n/g, `\n${indent}`)}`;
			});
		return entries.length === 0
			? "{}"
			: `{\n${entries.join(",\n")}\n${indent.slice(0, -1)}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export { basename, dirname, PACKAGES, PRIVATE, REPO };
