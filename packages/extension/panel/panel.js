// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Side-panel shell. It renders the confirmation surface's frame and nothing
 * else yet; the approval traffic arrives with the confirmation itself.
 *
 * The panel is an extension page: it reaches only the worker, never a page, and
 * it is opened by a user gesture rather than assumed to be poppable. It is the
 * surface `CONFIRMATION_SURFACE` names.
 *
 * It carries no pending-approval state of its own. Reading it from the worker is
 * the only honest source, and doing that is part of wiring confirmation, not of
 * shipping the shell.
 */

const status = document.getElementById("status");

if (status !== null) {
	status.textContent = "No tool invocation is waiting for approval.";
}
