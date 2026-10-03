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
		// The process entry. Single-file ESM, no types, so the binary in a
		// `bin` field is a file a user can spawn with no resolution step.
		entry: ["src/main.ts"],
		format: ["esm"],
		dts: false,
		sourcemap: false,
		minify: false,
		outDir: "dist",
	},
]);
