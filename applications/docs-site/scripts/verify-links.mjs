#!/usr/bin/env node
/**
 * Check every internal link against the **built output**.
 *
 * Two jobs, and the second is the one that matters:
 *
 * 1. The sidebar, the footer and the in-page links, read out of the generated
 *    HTML. A link to a page the build did not produce is a 404 a reader finds.
 * 2. The machine-readable files — `llms.json`, `.well-known/security.txt` — are
 *    checked for existence and parseability, because a disclosure route nobody
 *    can reach is not a disclosure route.
 *
 * Checking the built files rather than the sources is deliberate. The sources can
 * agree with each other and all be wrong about what ships; `dist/` is what a
 * reader is served.
 *
 * External links are **not** checked. A link that resolves proves only that it
 * resolves, and a check that implied more would be a check that lies.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");

if (!existsSync(DIST)) {
	process.stderr.write(
		"[links] dist/ does not exist. Build the site before running this.\n",
	);
	process.exit(1);
}

/** Every generated HTML page, relative to `dist/`. */
function htmlFiles(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...htmlFiles(path));
			continue;
		}
		if (entry.name.endsWith(".html")) {
			found.push(path);
		}
	}
	return found;
}

/**
 * The file a URL resolves to, or `undefined` when it does not.
 *
 * `build.format: "file"` means `/reference/api` is `reference/api.html`, and the
 * mapping is not something to reimplement loosely — a check that guesses the
 * output layout is a check that agrees with itself.
 */
function resolve(url) {
	const clean = url.split("#")[0].split("?")[0];
	if (clean === "" || clean === "/") {
		return join(DIST, "index.html");
	}
	const candidate = join(DIST, clean.replace(/^\//, ""));
	// A directory-style URL, from a link written without the extension.
	if (existsSync(join(candidate, "index.html"))) {
		return join(candidate, "index.html");
	}
	return candidate;
}

const pages = htmlFiles(DIST);
/**
 * Every URL the build actually serves.
 *
 * Normalised through the same shape as the links being checked, so a URL is
 * compared to a URL. Comparing paths to paths instead would make this set
 * disagree with every trailing-slash link on the site — which is most of them.
 */
const known = new Set(
	pages.map((page) => {
		const path = `/${relative(DIST, page).replace(/\\/g, "/")}`;
		// A page built at `quickstart/index.html` is served at `/quickstart/`.
		return path.endsWith("/index.html")
			? path.slice(0, -"index.html".length)
			: path;
	}),
);

const problems = [];
let checked = 0;

for (const page of pages) {
	const html = readFileSync(page, "utf8");
	const where = `/${relative(DIST, page).replace(/\\/g, "/")}`;
	for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
		const url = match[1];
		if (
			url.startsWith("http") ||
			url.startsWith("//") ||
			url.startsWith("mailto:") ||
			url.startsWith("data:") ||
			url === "#"
		) {
			continue;
		}
		if (url.startsWith("/_astro/") || url.startsWith("/pagefind/")) {
			// Build assets and the search index. Their existence is the build's
			// business and a hashed name changes on every build.
			continue;
		}
		checked += 1;
		const target = resolve(url);
		if (!existsSync(target)) {
			problems.push(`${where} -> ${url}`);
		}
	}
}

// The disclosure route and the machine-readable summary, checked by existence and
// by shape. A security.txt that does not parse is worse than none: a scanner
// reads it, gets nothing, and reports the route as absent.
const securityTxt = join(DIST, ".well-known/security.txt");
if (!existsSync(securityTxt)) {
	problems.push("missing /.well-known/security.txt");
} else {
	const body = readFileSync(securityTxt, "utf8");
	for (const field of ["Contact:", "Expires:", "Preferred-Languages:"]) {
		if (!body.includes(field)) {
			problems.push(`security.txt is missing the required field ${field}`);
		}
	}
	const expires = /Expires:\s*(\S+)/.exec(body)?.[1];
	if (expires !== undefined && Number.isNaN(Date.parse(expires))) {
		problems.push(`security.txt Expires is not a date: ${expires}`);
	} else if (expires !== undefined && Date.parse(expires) < Date.now()) {
		problems.push(`security.txt Expires is in the past: ${expires}`);
	}
}

const llms = join(DIST, "llms.json");
if (!existsSync(llms)) {
	problems.push("missing /llms.json");
} else {
	try {
		const parsed = JSON.parse(readFileSync(llms, "utf8"));
		if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
			problems.push("llms.json lists no pages");
		}
		for (const entry of parsed.pages ?? []) {
			// Compared through the resolver rather than against the set, so a URL
			// with or without a trailing slash is judged the same way the browser
			// would judge it.
			if (!existsSync(resolve(entry.url))) {
				problems.push(
					`llms.json lists ${entry.url}, which the build did not produce`,
				);
			}
		}
	} catch (error) {
		problems.push(`llms.json does not parse: ${error.message}`);
	}
}

if (problems.length > 0) {
	process.stderr.write(
		`[links] ${problems.length} broken of ${checked} internal links checked:\n${problems
			.map((line) => `  ${line}`)
			.join("\n")}\n`,
	);
	process.exit(1);
}

process.stdout.write(
	`[links] ${checked} internal links across ${pages.length} pages resolve; security.txt and llms.json are well formed\n`,
);
