import { defineConfig } from "tsdown";

// Two single-entry builds, kept self-contained on purpose: the size gate
// measures each artifact file, so shared chunks would under-measure the root.
// Duplication across entries is the documented cost of honest measurement.
export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
	{
		entry: { index: "src/ax/index.ts" },
		outDir: "dist/ax",
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
]);
