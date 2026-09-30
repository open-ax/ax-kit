// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { auditSnapshot } from "./audit.js";

const args: string[] = process.argv.slice(2);
const target: string | undefined = args[0];
if (typeof target !== "string" || target.length === 0) {
	console.error("usage: ax-kit audit <url>");
	process.exit(1);
}
console.log(
	auditSnapshot(target, {
		tools: [],
		policyAllowsTools: true,
		originKeyed: true,
	}),
);
