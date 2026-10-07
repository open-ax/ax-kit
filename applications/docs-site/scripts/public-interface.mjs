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

/**
 * Declarations this extractor can name, and the keyword that introduces them.
 *
 * Used only to attribute a `@private`-family marker to the declaration it
 * documents. The kind recorded on a member comes from the passes below, which
 * are anchored on `export`, so a bare `declare` in the middle of a declaration
 * file is never mistaken for an export.
 */
const DECLARATION =
	/(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|class|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

/**
 * The names a `@private`, `@internal` or `@package` marker takes out of the
 * surface.
 *
 * Read from the *unstripped* source, because the marker is itself a comment — and
 * that is the whole reason this is a separate pass. `PRIVATE` was declared when
 * this file was written and never applied to anything, while the docblock above
 * claimed the markers were honoured. A declaration the repository marks internal
 * was therefore published in the reference and tracked by the drift gate as
 * though it were public.
 *
 * A marker is attributed to the declaration that immediately follows it, allowing
 * for further comments. The gap must not contain a `{`, because a brace between
 * the comment and the declaration means the comment sits inside a body and
 * documents a member rather than a top-level export — and attributing that
 * member's name would silently drop an unrelated export that happens to share it.
 */
function findExcludedNames(source) {
	const excluded = new Set();
	const doc = /\/\*\*[\s\S]*?\*\//g;
	for (let found = doc.exec(source); found !== null; found = doc.exec(source)) {
		if (!PRIVATE.test(found[0])) {
			continue;
		}
		const rest = source.slice(found.index + found[0].length);
		const gap = /^[ \t\r\n]*(?:(?:\/\*[\s\S]*?\*\/)[ \t\r\n]*)*/.exec(rest);
		if (gap === null || rest[gap[0].length] === "{") {
			continue;
		}
		const declaration = DECLARATION.exec(rest.slice(gap[0].length));
		if (declaration !== null) {
			excluded.add(declaration[2]);
		}
	}
	return excluded;
}

/**
 * The declaration head: from the keyword to the body or the end of the statement.
 *
 * This is what lets the drift gate catch a *signature* change rather than only an
 * added or removed name. Recording `name` and `kind` alone meant that
 * `function search(input: SearchInput)` becoming `function search(input: string)`
 * produced a byte-identical report and a green build — the exact case the gate
 * exists to refuse.
 *
 * The body is excluded deliberately. An interface's members *are* the interface,
 * so embedding them would make the report enormous, sensitive to formatting, and
 * unreadable in a diff. What the head captures is the name, the parameters, the
 * return type, the heritage clause and a type alias's right-hand side, which is
 * where a signature actually changes.
 */
function declarationHead(text, from) {
	let depth = 0;
	for (let index = from; index < text.length; index += 1) {
		const char = text[index];
		if (char === "{") {
			return text.slice(from, index);
		}
		if (char === "(" || char === "[" || char === "<") {
			depth += 1;
			continue;
		}
		if (char === ")" || char === "]" || char === ">") {
			depth -= 1;
			continue;
		}
		if (char === ";" && depth <= 0) {
			return text.slice(from, index);
		}
	}
	return text.slice(from);
}

/** Collapse a declaration head onto one line, so formatting cannot change it. */
function normalise(text) {
	return text.replace(/\s+/g, " ").trim();
}

export function extractExports(source) {
	const exports = new Map();
	// Stripped once and reused by every pass. The `export { … }` pass used to run
	// over the raw source while the other two ran over the stripped text, so an
	// `export { example }` inside a documentation comment was reported as a public
	// export. `stripComments` exists to prevent exactly that, and one pass reading
	// the wrong input defeated it.
	const stripped = stripComments(source);
	const excluded = findExcludedNames(source);

	/** First writer wins, so an explicit `export declare` is not overwritten. */
	const record = (name, kind, signature) => {
		if (excluded.has(name) || exports.has(name)) {
			return;
		}
		exports.set(name, { name, kind, signature });
	};

	const lines = stripped.split(/\r?\n/);

	// `export declare function name(...): T;` and `export declare const name`.
	const declared =
		/export\s+declare\s+(?:async\s+)?(function|const|class|let)\s+([A-Za-z0-9_$]+)/g;
	for (const line of lines) {
		declared.lastIndex = 0;
		let match = declared.exec(line);
		while (match !== null) {
			record(match[2], match[1], normalise(declarationHead(line, match.index)));
			match = declared.exec(line);
		}
	}

	// Interfaces and type aliases, which are the bulk of this project's surface.
	// Recorded before the `export { … }` pass so a listed name can be resolved
	// against a real declaration rather than guessed at.
	const types = /export\s+(?:declare\s+)?(interface|type)\s+([A-Za-z0-9_$]+)/g;
	for (const line of lines) {
		types.lastIndex = 0;
		let match = types.exec(line);
		while (match !== null) {
			record(match[2], match[1], normalise(declarationHead(line, match.index)));
			match = types.exec(line);
		}
	}

	// Declarations that carry no `export`, kept only so a later `export { … }` clause
	// can be resolved against them.
	//
	// A declaration file commonly declares a type locally and re-exports it in a
	// list: `interface ModelContext extends EventTarget {` followed by
	// `export type { ModelContext, … }`. Without this pass such a name is recorded
	// with the kind the `type` clause implies and a signature of nothing but its own
	// name, so a change to the heritage clause or the alias target would not reach
	// the drift gate at all.
	//
	// Deliberately *not* passed to `record`. A name is not exported by being
	// declared, and reporting these would publish each file's internals.
	const local = new Map();
	const localDeclared =
		/^[ \t]*(?:declare\s+)?(interface|type)\s+([A-Za-z0-9_$]+)/gm;
	for (const line of lines) {
		localDeclared.lastIndex = 0;
		let match = localDeclared.exec(line);
		while (match !== null) {
			if (!local.has(match[2])) {
				local.set(match[2], {
					kind: match[1],
					signature: normalise(declarationHead(line, match.index)),
				});
			}
			match = localDeclared.exec(line);
		}
	}

	// `export { a, b as c };`, possibly spanning lines.
	const listed = /export\s+(type\s+)?\{([\s\S]*?)\}/g;
	for (
		let match = listed.exec(stripped);
		match !== null;
		match = listed.exec(stripped)
	) {
		const clauseIsTypeOnly = match[1] !== undefined;
		for (const clause of match[2].split(",")) {
			const trimmed = clause.trim();
			// `export { type Foo }` is an inline type-only re-export. It is public,
			// and the previous pass skipped these clauses outright, so they were
			// missing from both the report and the gate.
			const inlineType = /^type\s+([A-Za-z0-9_$]+)$/.exec(trimmed);
			const renamed = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(
				trimmed,
			);
			const localName =
				inlineType?.[1] ??
				renamed?.[1] ??
				(/^[A-Za-z0-9_$]+$/.test(trimmed) ? trimmed : undefined);
			if (localName === undefined) {
				continue;
			}
			const exported = renamed?.[2] ?? localName;
			// The kind is looked up rather than assumed. Labelling every listed name
			// `"type"` recorded `@ax-kit/playwright`'s `expect` — a runtime value
			// re-exported from `fixture.ts` — as a type, so a real change of kind on a
			// re-exported value could never be detected.
			//
			// A listed name with no declaration in this file is re-exported from
			// another module, and its kind is not knowable from here. That is
			// recorded as `"unknown"` rather than guessed: `"type"` was the guess, and
			// it was wrong often enough to be the bug rather than the default.
			// A local declaration wins over the clause's own `type` marker: the
			// marker describes how the name is re-exported, while the declaration
			// describes what it is. Where both exist the declaration is the better
			// answer, and it is the only one that carries a signature.
			const declared_ = exports.get(local) ?? local.get(localName);
			const kind =
				declared_ !== undefined
					? declared_.kind
					: inlineType !== null || clauseIsTypeOnly
						? "type"
						: "unknown";
			const signature = declared_?.signature ?? normalise(trimmed);
			record(exported, kind, signature);
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
