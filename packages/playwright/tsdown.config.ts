import { defineConfig } from "tsdown";

// The runner entry ships as dual ESM/CJS for the test process. The init
// script ships as a single self-contained global file evaluated in the page
// before any application script runs.
export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
	{
		entry: { "init.global": "src/init.ts" },
		format: ["iife"],
		dts: false,
		sourcemap: false,
		minify: true,
	},
]);
