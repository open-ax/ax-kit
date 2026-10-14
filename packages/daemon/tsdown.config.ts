import { defineConfig } from "tsdown";

export default defineConfig([
	{
		// The library surface. Consumers import the policy helpers directly, so
		// this stays a dual-format bundle with types.
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
	{
		// The process entries. Single-file ESM, no types, so a binary in a `bin`
		// field is a file a user can spawn with no resolution step.
		//
		// The shims in `bin/` import from here by exact filename, so these two
		// are emitted unminified and unsplit: a minifier that renames or splits
		// them would make `bin/` point at a file that is not there.
		entry: [
			"src/main.ts",
			"src/discovery.ts",
			"src/browser-host.ts",
			"src/install-host.ts",
		],
		format: ["esm"],
		dts: false,
		sourcemap: false,
		minify: false,
		outDir: "dist",
	},
]);
