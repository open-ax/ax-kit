import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/ax/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: false,
	minify: true,
});
