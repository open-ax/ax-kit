// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

/**
 * Side panel: the only confirmation surface.
 *
 * It renders what a person is about to approve — name, description, and the
 * exact arguments — and it decides nothing on its own. Every value it shows
 * comes from the worker's store, so the panel and the thing that will execute
 * cannot disagree.
 *
 * Approval is a click, and it is the only thing that grants one: the worker
 * files the confirmation itself from the tool view it validated, and nothing
 * else can put an approval in front of a person.
 *
 * Copied verbatim into the unpacked directory, so this file is plain
 * JavaScript — it is never transpiled.
 */

const requests = document.getElementById("requests");
const empty = document.getElementById("empty");
const refused = document.getElementById("refused");
const disclaimer = document.getElementById("disclaimer");
const inFlight = new Set();

/** Ask the worker for the pending approvals, and nothing else. */
async function pending() {
	const reply = await chrome.runtime.sendMessage({
		panel: "list",
		args: {},
	});
	if (typeof reply !== "object" || reply === null) {
		return [];
	}
	const record = reply;
	if (record.ok !== true) {
		return [];
	}
	const result = record.result;
	if (disclaimer !== null && typeof result?.disclaimer === "string") {
		disclaimer.textContent = result.disclaimer;
	}
	return Array.isArray(result?.pending) ? result.pending : [];
}

/** One request, with its description and the arguments being approved. */
function render(entry) {
	const card = document.createElement("div");
	card.className = "request";
	card.dataset.key = entry.key;
	card.dataset.definitionVersion = entry.definitionVersion;

	const heading = document.createElement("h2");
	heading.textContent = entry.toolName;
	card.appendChild(heading);

	const list = document.createElement("dl");
	const fields = [
		["Description", entry.description],
		// Two origins, because they can disagree: `origin` is what the tool
		// declared about itself and `frameOrigin` is where it actually lives.
		// Only the second is observed, so a person deciding reads both.
		["Declared origin", entry.origin],
		["Frame origin", entry.frameOrigin],
		["Arguments", entry.argsJson],
	];
	for (const [label, value] of fields) {
		const term = document.createElement("dt");
		term.textContent = label;
		const definition = document.createElement("dd");
		definition.textContent = value;
		definition.dataset.field = label.toLowerCase();
		list.append(term, definition);
	}
	card.appendChild(list);

	const buttons = [
		["approve", "Approve"],
		["reject", "Reject"],
	];
	for (const [operation, label] of buttons) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.dataset.operation = operation;
		// The click is the gesture. Nothing approves without one. The displayed
		// definition version travels with the decision so a stale card cannot
		// approve a replacement definition it never showed.
		button.addEventListener("click", () => {
			if (inFlight.has(entry.key)) {
				return;
			}
			inFlight.add(entry.key);
			for (const other of card.querySelectorAll("button")) {
				other.disabled = true;
			}
			void decide(operation, entry.key, entry.definitionVersion).finally(() => {
				inFlight.delete(entry.key);
			});
		});
		card.appendChild(button);
	}
	return card;
}

/**
 * Record a refusal the person needs to see.
 *
 * The worker refuses for reasons a person can act on — the invocation is gone,
 * the tab has moved on — and a card that quietly reappears with no explanation
 * would leave them clicking a button that does nothing.
 */
function reportRefusal(reason) {
	if (refused === null) {
		return;
	}
	refused.textContent = reason;
	refused.hidden = false;
}

async function decide(operation, key, definitionVersion) {
	const reply = await chrome.runtime.sendMessage({
		panel: operation,
		args: { key, definitionVersion },
	});
	if (typeof reply !== "object" || reply === null || reply.ok !== true) {
		const detail = typeof reply?.error === "string" ? reply.error : "";
		reportRefusal(
			detail === ""
				? "The worker did not accept that decision. It may have restarted."
				: `The worker refused that decision: ${detail}`,
		);
	} else if (refused !== null) {
		refused.hidden = true;
	}
	await refresh();
}

async function refresh() {
	const entries = await pending();
	if (requests === null || empty === null) {
		return;
	}
	requests.replaceChildren(...entries.map(render));
	empty.hidden = entries.length > 0;
}

chrome.runtime.onMessage.addListener((message) => {
	const record = message ?? {};
	if (record.handler === "pendingChanged") {
		void refresh();
	}
});

void refresh();
