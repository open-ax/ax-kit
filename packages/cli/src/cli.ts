// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

import { parseAuditTarget } from "./args.js";
import { auditSnapshot } from "./audit.js";
import type { AuditContextInput } from "./scoring.js";
import { countFailures, scoreAudit } from "./scoring.js";

function readTarget(): string {
	try {
		return parseAuditTarget(process.argv.slice(2));
	} catch {
		console.error("usage: ax-kit audit <url>");
		process.exit(1);
	}
}

const target: string = readTarget();
const snapshot: AuditContextInput = {
	tools: [],
	policyAllowsTools: true,
	originKeyed: true,
};
console.error(
	"experimental stub: no Chromium driver wired yet; scoring an empty snapshot, not the live page. Use auditUrl() with a headless browser for real results.",
);
console.log(auditSnapshot(target, snapshot));
process.exitCode = countFailures(scoreAudit(snapshot)) > 0 ? 2 : 0;
