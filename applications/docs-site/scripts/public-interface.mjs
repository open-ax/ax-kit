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
 * A declaration this extractor can name, and the keyword that introduces it.
 *
 * `export` is required for the private-marker pass: a declaration that is not
 * exported cannot be a public export, and excluding one would wrongly drop a
 * different name that *is* re-exported later.
 */
const TOP_LEVEL_DECLARATION =
	/export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|class|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

/** The same, without `export`, for declarations used only to resolve a re-export. */
const ANY_DECLARATION =
	/(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|class|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

/**
 * The names a `@private`, `@internal` or `@package` marker takes out of the
 * surface.
 *
 * Read from the *unstripped* source, because the marker is itself a comment — and
 * that is the whole reason this is a separate pass. `PRIVATE` was declared when
 * this file was written and never applied to anything, while the file's own
 * docblock claimed the markers were honoured.
 *
 * One linear scan, tracking brace depth, rather than a search from each marker.
 * Searching forward from a marker finds the *next declaration of any kind*, which
 * for a marker on a class or interface member is a declaration further down the
 * file — so a member documented `@internal` would silently remove an unrelated
 * public export. Depth is what distinguishes the two: a marker at depth 0
 * documents a top-level declaration, and anything deeper documents a member.
 *
 * A marker is also cleared by any brace it reaches before the declaration, and by
 * any intervening comment, so it cannot carry past the thing it documents.
 */
function findExcludedNames(source) {
	const excluded = new Set();
	let depth = 0;
	let quote = "";
	let pendingPrivate = false;
	let index = 0;

	while (index < source.length) {
		const char = source[index];

		if (quote !== "") {
			if (char === "\\") {
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
			const close = source.indexOf("*/", index + 2);
			const stop = close === -1 ? source.length : close + 2;
			pendingPrivate =
				source[index + 1] === "*" &&
				depth === 0 &&
				PRIVATE.test(source.slice(index, stop));
			index = stop;
			continue;
		}
		if (char === "{") {
			depth += 1;
			pendingPrivate = false;
			index += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			pendingPrivate = false;
			index += 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r" || char === "\n") {
			index += 1;
			continue;
		}
		if (pendingPrivate) {
			const rest = source.slice(index);
			const declaration = TOP_LEVEL_DECLARATION.exec(rest);
			// `index === 0` is the point: the declaration must begin exactly here,
			// not somewhere further along.
			if (declaration !== null && declaration.index === 0) {
				excluded.add(declaration[2]);
			}
			pendingPrivate = false;
		}
		index += 1;
	}

	return excluded;
}

/**
 * The complete declaration starting at `from`.
 *
 * This is what lets the drift gate catch a *signature* change rather than only an
 * added or removed name. Recording `name` and `kind` alone meant that
 * `function search(input: SearchInput)` becoming `function search(input: string)`
 * produced a byte-identical report and a green build — the exact case the gate
 * exists to refuse.
 *
 * **Complete, including bodies.** An interface's members *are* its signature:
 * recording `interface ModelContext extends EventTarget` and stopping at the brace
 * leaves `registerTool(input: X): Promise<void>` becoming
 * `registerTool(input: X, options: Y): Promise<void>` invisible to the gate. The
 * same applies to a class's members and to an object-shaped type alias. So the
 * walk continues to the `;` that ends the statement or to the `}` that closes the
 * declaration's own body.
 *
 * The walk skips string literals, because a declaration file quotes strings in
 * its types and a `;` or brace inside one would end the declaration early.
 */
function declarationAt(text, from) {
	let depth = 0;
	let quote = "";
	let sawBrace = false;

	for (let index = from; index < text.length; index += 1) {
		const char = text[index];

		if (quote !== "") {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) {
				quote = "";
			}
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{") {
			depth += 1;
			sawBrace = true;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			// The brace that closes this declaration's own body ends it.
			if (sawBrace && depth === 0) {
				return text.slice(from, index + 1);
			}
			continue;
		}
		if (char === ";" && depth === 0) {
			return text.slice(from, index);
		}
	}
	return text.slice(from);
}

/** Collapse a declaration onto one line, so formatting cannot change it. */
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

	/**
	 * Declarations that carry no `export`, kept only so a later `export { … }`
	 * clause can be resolved against them.
	 *
	 * A declaration file commonly declares a type locally and re-exports it in a
	 * list: `interface ModelContext extends EventTarget {` followed by
	 * `export type { ModelContext, … }`. Without this, such a name is recorded with
	 * the kind the `type` clause implies and a signature of nothing but its own
	 * name, so a change to the heritage clause or to a member would not reach the
	 * drift gate at all.
	 *
	 * Deliberately *not* passed to `record`. A name is not exported by being
	 * declared, and reporting these would publish each file's internals.
	 */
	const localDeclarations = new Map();

	/** First writer wins, so an explicit `export declare` is not overwritten. */
	const record = (name, kind, signature) => {
		if (excluded.has(name) || exports.has(name)) {
			return;
		}
		exports.set(name, { name, kind, signature });
	};

	// Run over the whole document rather than line by line. A declaration file
	// wraps signatures freely, and reading one line at a time truncated every
	// declaration that did not fit: the report carried
	// `…auditLiveUrlFindings(…): Promise<`, so a change to the rest of the return
	// type could not change the report at all.
	//
	// `export declare` covers functions, constants, classes and lets. Interfaces
	// and type aliases have no `declare`, so they are matched separately.
	const EXPORTED =
		/(?:export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?|^\s*(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?)(function|const|class|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
	for (
		let match = EXPORTED.exec(stripped);
		match !== null;
		match = EXPORTED.exec(stripped)
	) {
		// The declaration must actually be exported. The alternation also matches a
		// bare top-level declaration so the local lookup below can find it; those
		// are recorded separately.
		const text = stripped.slice(match.index);
		const isExported = /^export\b/.test(text);
		if (isExported) {
			record(
				match[2],
				match[1],
				normalise(declarationAt(stripped, match.index)),
			);
		} else {
			localDeclarations.set(match[2], {
				kind: match[1],
				signature: normalise(declarationAt(stripped, match.index)),
			});
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
			// and an earlier version of this pass skipped these clauses outright, so
			// they were missing from both the report and the gate.
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

			// Resolution order: this file's exported declarations, then its
			// unexported ones, then nothing.
			//
			// Keyed on `localName`, not on `local` — the Map. An earlier version read
			// `exports.get(local)`, which passed the Map object as a key and so never
			// matched: every listed export fell through to the unexported lookup or
			// to `"unknown"`, and `export { foo as bar }` recorded `bar` with `foo`'s
			// absence rather than `foo`'s declaration. That defeated the gate for
			// every aliased re-export, which is exactly the case a reviewer looks at.
			//
			// A local declaration wins over the clause's own `type` marker: the marker
			// describes how the name is re-exported, the declaration describes what it
			// is. A name resolvable from neither is re-exported from another module
			// and its kind is not knowable here, which is recorded as `"unknown"`
			// rather than guessed.
			const resolved =
				exports.get(localName) ?? localDeclarations.get(localName);
			const kind =
				resolved !== undefined
					? resolved.kind
					: inlineType !== null || clauseIsTypeOnly
						? "type"
						: "unknown";
			const signature = resolved?.signature ?? normalise(trimmed);
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

export { basename, declarationAt, dirname, normalise, PACKAGES, PRIVATE, REPO };
