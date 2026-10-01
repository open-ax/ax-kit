// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { parseAuditTarget } from "./args.js";
import { auditLiveUrlFindings, exitCodeFor } from "./driver.js";

/**
 * The audit command. It drives a real browser against the given URL, prints the
 * report, and exits with a code that follows the findings.
 *
 * Diagnostics go to standard error so the report on standard output stays
 * machine-readable.
 */

async function main(): Promise<number> {
	let target: string;
	try {
		target = parseAuditTarget(process.argv.slice(2));
	} catch {
		process.stderr.write("usage: ax-kit audit <url>\n");
		return 1;
	}
	try {
		const { report, context } = await auditLiveUrlFindings(
			{ headless: true },
			target,
		);
		process.stdout.write(`${report}\n`);
		return exitCodeFor(context);
	} catch (error: unknown) {
		process.stderr.write(
			`audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}

main().then(
	(code: number) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(
			`audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	},
);
