import { defineConfig } from "tsdown";

export default defineConfig([
	{
		// The library surface. Consumers import the policy functions directly, so
		// this stays a dual-format bundle with types.
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
	{
		// The loadable unpacked directory: the service worker plus, written
		// afterwards by `scripts/emit-manifest.mjs`, the manifest itself. The
		// manifest is emitted by a separate step rather than from this config so
		// the config imports no source module.
		// Emitted as `sw.mjs` by the bundler's extension rule; the manifest step
		// renames it to `sw.js`, because a Manifest V3 `service_worker` must be a
		// JavaScript file and the manifest may not point at an `.mjs`.
		entry: { sw: "src/service-worker.ts" },
		outDir: "dist/unpacked",
		format: ["esm"],
		dts: false,
		sourcemap: false,
		minify: true,
	},
]);
