#!/usr/bin/env node
// Version and publish, as one command that cannot fail for doing nothing.
//
// `changeset version` exits 1 when there are no unreleased changesets. That is
// the right answer for a tool and the wrong answer for a pipeline: wired into a
// release workflow unchanged, every ordinary push turns into a red check that
// nobody can explain, and a red check nobody can explain gets ignored. So this
// checks first, and treats "nothing to do" as success.
//
//   node scripts/release.mjs            version, then publish
//   node scripts/release.mjs --dry-run  version, then show publish-plan
//
// The dry run exists because publishing needs registry credentials and is not
// reversible, so the only safe way to rehearse a release is to stop short of it.
// `changeset version` still rewrites manifests in a dry run; review or discard
// that diff.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHANGESET_DIR = join(ROOT, ".changeset");
const DRY_RUN = process.argv.includes("--dry-run");

// Resolve the CLI through its own package rather than through PATH. A bare
// `changeset` is only on PATH when a package manager put it there, so this
// script silently failed when invoked directly and worked under `pnpm release`.
// `./bin.js` is an export of @changesets/cli, so this needs no .bin shim and no
// shell.
const require = createRequire(join(ROOT, "package.json"));
const CLI = require.resolve("@changesets/cli/bin.js");

// One markdown file per changeset. README.md documents the directory itself and
// is not a changeset.
const pending = readdirSync(CHANGESET_DIR).filter(
	(name) => name.endsWith(".md") && name !== "README.md",
);

function run(args) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (result.error) {
		console.error(
			`release: could not run changeset ${args[0]}: ${result.error.message}`,
		);
		process.exit(1);
	}
	return result.status ?? 1;
}

if (pending.length === 0) {
	console.log(
		"release: no unreleased changesets; nothing to version and nothing to publish.",
	);
	console.log(
		"release: add one with `pnpm changeset` when a change needs a release.",
	);
	process.exit(0);
}

console.log(
	`release: ${pending.length} changeset(s) pending: ${pending.join(", ")}`,
);

const versionStatus = run(["version"]);
if (versionStatus !== 0) {
	console.error("release: versioning failed; not publishing.");
	process.exit(versionStatus);
}

if (DRY_RUN) {
	console.log("release: dry run — showing publish-plan instead of publishing.");
	const planStatus = run(["publish-plan"]);
	if (planStatus !== 0) {
		console.error("release: could not read publish-plan.");
		process.exit(planStatus);
	}
	console.log("release: dry run complete. Nothing was published.");
	process.exit(0);
}

const publishStatus = run(["publish"]);
if (publishStatus !== 0) {
	console.error(
		"release: publish failed. The version bumps are committed; re-run `pnpm release`.",
	);
	process.exit(publishStatus);
}

console.log("release: done.");
