#!/usr/bin/env node
// Manifest invariants for the published packages.
//
// Publication metadata is not decoration. The platform's publishing trust
// relationship is bound to the repository field, so a manifest that names the
// wrong repository — or none — fails authentication at publish time with an
// error that does not point at the manifest. Discoverability scanners read the
// same three fields, and a package missing them reads as a package that does
// not exist.
//
//   node .github/ci/check-manifests.mjs
//   node .github/ci/check-manifests.mjs --require-versioned
//
// Exits 0 when every invariant holds, 1 with the findings listed otherwise.
//
// `--require-versioned` adds the one invariant that only the release path cares
// about, so that the ordinary pull-request check stays green while the cohort is
// still unversioned. See section 5.
//
// No dependencies. The runtime range is deliberately NOT range-checked here:
// `.npmrc` sets `engine-strict=true`, so a Node that does not satisfy a declared
// range already fails the frozen install in CI. What this checks is the part
// nothing else checks, which is that every package declares the same one.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Two levels up: .github/ci/ -> repository root.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The canonical repository. `repository.url` is the git form; `homepage` and
// `bugs` are the browsable form. Kept as constants rather than derived so the
// expected value is stated once and can be compared against `origin`.
const REPO_SLUG = "open-ax/ax-kit";
const REPO_GIT_URL = `https://github.com/${REPO_SLUG}.git`;
const REPO_WEB_URL = `https://github.com/${REPO_SLUG}`;

const findings = [];
const fail = (where, message) => findings.push(`${where}: ${message}`);

// ---------------------------------------------------------------------------
// Discover the workspace members.
//
// The workspace globs are `packages/*` and `applications/*`, so enumerating
// those two directories and keeping the ones with a manifest is the same set.
// Deliberately not parsed out of pnpm-workspace.yaml: that would need a YAML
// reader, and the globs are two literal strings.
// ---------------------------------------------------------------------------

function membersUnder(directory) {
	const absolute = join(ROOT, directory);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(directory, entry.name))
		.filter((relativePath) =>
			existsSync(join(ROOT, relativePath, "package.json")),
		);
}

const members = [...membersUnder("packages"), ...membersUnder("applications")];
if (members.length === 0) {
	console.error(
		"check-manifests: found no workspace members; refusing to pass vacuously.",
	);
	process.exit(1);
}

const manifests = members.map((relativePath) => ({
	relativePath,
	posixPath: relativePath.split(sep).join("/"),
	manifest: JSON.parse(
		readFileSync(join(ROOT, relativePath, "package.json"), "utf8"),
	),
}));

const publishable = manifests.filter(
	(entry) => entry.manifest.private !== true,
);
const withheld = manifests.filter((entry) => entry.manifest.private === true);

// ---------------------------------------------------------------------------
// 1. A published package says where it comes from.
// ---------------------------------------------------------------------------

for (const { relativePath, posixPath, manifest } of publishable) {
	const where = `${manifest.name} (${relativePath})`;

	if (manifest.repository === undefined) {
		fail(where, "declares no repository");
	} else if (typeof manifest.repository === "string") {
		fail(
			where,
			"declares repository as a bare string; the object form carries the subdirectory",
		);
	} else {
		if (manifest.repository.type !== "git") {
			fail(
				where,
				`repository.type is ${JSON.stringify(manifest.repository.type)}, expected "git"`,
			);
		}
		if (manifest.repository.url !== REPO_GIT_URL) {
			fail(
				where,
				`repository.url is ${JSON.stringify(manifest.repository.url)}, expected ${JSON.stringify(REPO_GIT_URL)}`,
			);
		}
		if (manifest.repository.directory !== posixPath) {
			fail(
				where,
				`repository.directory is ${JSON.stringify(manifest.repository.directory)}, expected ${JSON.stringify(posixPath)}`,
			);
		}
	}

	if (manifest.homepage !== REPO_WEB_URL) {
		fail(
			where,
			`homepage is ${JSON.stringify(manifest.homepage)}, expected ${JSON.stringify(REPO_WEB_URL)}`,
		);
	}
	if (manifest.bugs !== `${REPO_WEB_URL}/issues`) {
		fail(
			where,
			`bugs is ${JSON.stringify(manifest.bugs)}, expected ${JSON.stringify(`${REPO_WEB_URL}/issues`)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// 2. A package that is never published carries none of it.
//
// Giving publication metadata to a package that cannot be published is noise
// that later reads as intent to publish.
// ---------------------------------------------------------------------------

for (const { relativePath, manifest } of withheld) {
	const where = `${manifest.name} (${relativePath})`;
	for (const field of ["repository", "homepage", "bugs"]) {
		if (manifest[field] !== undefined) {
			fail(where, `is private but declares ${field}`);
		}
	}
}

// ---------------------------------------------------------------------------
// 3. Every publishable package declares the same runtime range.
// ---------------------------------------------------------------------------

const ranges = new Map();
for (const { relativePath, manifest } of publishable) {
	const range = manifest.engines?.node;
	if (range === undefined) {
		fail(`${manifest.name} (${relativePath})`, "declares no engines.node");
		continue;
	}
	if (!ranges.has(range)) ranges.set(range, []);
	ranges.get(range).push(manifest.name);
}
if (ranges.size > 1) {
	const detail = [...ranges]
		.map(([range, names]) => `${range}: ${names.join(", ")}`)
		.join(" | ");
	fail(
		"workspace",
		`publishable packages disagree on engines.node — ${detail}`,
	);
}

const rootManifest = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
);
const declaredRange = [...ranges.keys()][0];
if (
	declaredRange !== undefined &&
	rootManifest.engines?.node !== declaredRange
) {
	fail(
		"package.json",
		`engines.node is ${JSON.stringify(rootManifest.engines?.node)}, publishable packages declare ${JSON.stringify(declaredRange)}`,
	);
}

// ---------------------------------------------------------------------------
// 4. The declared repository is the repository this checkout came from.
//
// This is the field publishing authentication is bound to. Comparing it to the
// actual remote means renaming or transferring the repository cannot leave nine
// manifests quietly pointing somewhere else.
// ---------------------------------------------------------------------------

// A remote reduced to `host/path`, so the forms a clone can legitimately take
// compare equal.
//
// `origin` is whatever the developer cloned with, and the canonical SSH remote
// is `git@github.com:open-ax/ax-kit.git` — not an HTTPS URL. Comparing that
// string to `REPO_WEB_URL` directly reports a checkout of the right repository
// as pointing somewhere else, and the finding names the wrong problem. Dropping
// the scheme, the user and the port leaves the repository identity, which is
// the thing that must match.
function normaliseRemote(url) {
	const trimmed = url.trim().replace(/\.git\/?$/, "");
	// `scp`-style SSH, `user@host:path`, which has no scheme to strip.
	const scpLike = /^[^/]+@([^/:]+):(.+)$/.exec(trimmed);
	if (scpLike !== null) {
		return `${scpLike[1]}/${scpLike[2]}`.replace(/\/$/, "").toLowerCase();
	}
	return trimmed
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^[^/@]*@/, "")
		.replace(/:\d+\//, "/")
		.replace(/\/$/, "")
		.toLowerCase();
}

let origin = null;
try {
	origin = execFileSync("git", ["remote", "get-url", "origin"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// No origin configured (a tarball, or CI running detached). The constants
	// above are still checked; only the cross-check is skipped.
}

if (origin === null) {
	console.log(
		"check-manifests: no origin remote; skipped the remote cross-check.",
	);
} else if (normaliseRemote(origin) !== normaliseRemote(REPO_WEB_URL)) {
	fail(
		"workspace",
		`origin is ${JSON.stringify(origin)}, manifests declare ${JSON.stringify(REPO_WEB_URL)}`,
	);
}

// ---------------------------------------------------------------------------
// 5. Every publishable package declares a version a registry will accept once.
//
// Release path only, behind `--require-versioned`.
//
// `changeset publish` decides what to publish by asking the registry, not by
// reading pending changesets: every publishable package whose version is not
// already published is published at whatever version the manifest carries. Two
// pending changesets cover two packages and say nothing about the other seven, so
// with the cohort at `0.0.0` a merge to `main` claims `0.0.0` for all nine. A
// published version can never be reused, so that is not recoverable by publishing
// again.
//
// The guard is deliberately narrow. It refuses while any manifest is at
// `0.0.0` and clears itself the moment `pnpm release:version` has been run and
// committed, which is the reviewed release change the workflow already assumes.
// It is not on by default because the ordinary pull-request check has to stay
// green for the whole time the cohort is still unversioned.
// ---------------------------------------------------------------------------

if (process.argv.includes("--require-versioned")) {
	for (const { relativePath, manifest } of publishable) {
		if (manifest.version === "0.0.0") {
			fail(
				`${manifest.name} (${relativePath})`,
				"declares version 0.0.0; publishing would claim that version permanently. Run `pnpm release:version` and commit the bump.",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const rangeNote = declaredRange === undefined ? "none declared" : declaredRange;
console.log(
	`check-manifests: ${publishable.length} publishable, ${withheld.length} private, engines.node ${rangeNote}`,
);

if (findings.length > 0) {
	console.error(`\n  [manifest] ${findings.length} finding(s):`);
	for (const finding of findings) console.error(`    ${finding}`);
	console.error("");
	process.exit(1);
}

console.log("check-manifests: ok");
