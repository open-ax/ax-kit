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
 * Approval is a click. `request` is gesture-gated in the worker as well, so a
 * request filed without one is rejected there too rather than trusted here.
 */

const requests = document.getElementById("requests");
const empty = document.getElementById("empty");
const disclaimer = document.getElementById("disclaimer");

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

	const heading = document.createElement("h2");
	heading.textContent = entry.toolName;
	card.appendChild(heading);

	const list = document.createElement("dl");
	const fields = [
		["Description", entry.description],
		["Origin", entry.origin],
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
		// The click is the gesture. Nothing approves without one.
		button.addEventListener("click", () => {
			void decide(operation, entry.key);
		});
		card.appendChild(button);
	}
	return card;
}

async function decide(operation, key) {
	await chrome.runtime.sendMessage({
		panel: operation,
		args: { key },
	});
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
