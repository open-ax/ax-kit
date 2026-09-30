import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: false,
		minify: true,
	},
	{
		entry: { cli: "src/cli.ts" },
		outDir: "dist",
		format: ["cjs"],
		dts: false,
		sourcemap: false,
		minify: true,
	},
]);
