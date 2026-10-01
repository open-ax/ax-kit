// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// Write the loadable manifest from the same posture function the assertions
// read. A separate step rather than a build hook so the emitted file cannot
// describe an intention the code does not hold.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = pathToFileURL(resolve(here, "../dist/index.mjs")).href;
const { defaultManifestDocument } = await import(bundle);

const dir = resolve(here, "../dist/unpacked");
mkdirSync(dir, { recursive: true });

// A Manifest V3 `service_worker` must be a `.js` file. The bundler emits
// `sw.mjs` for an ESM entry, so it is renamed rather than pointed at: the
// manifest referring to an `.mjs` would be a file the browser will not load.
const bundled = resolve(dir, "sw.mjs");
const loadable = resolve(dir, "sw.js");
// A repeat build can leave the renamed file behind from the previous run.
await rm(loadable, { force: true });
await rename(bundled, loadable);

// The side panel is part of the loadable bundle, not an optional extra: the
// manifest's `side_panel.default_path` must resolve to a real file, and a
// manifest that names a missing page is one Chrome refuses to load at all.
for (const file of ["panel.html", "panel.js"]) {
	copyFileSync(resolve(here, "../panel", file), resolve(dir, file));
}

writeFileSync(
	resolve(dir, "manifest.json"),
	`${JSON.stringify(defaultManifestDocument(), null, 2)}\n`,
);
