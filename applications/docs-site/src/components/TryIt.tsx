/**
 * The live demonstration.
 *
 * This component is the reason the documentation site exists in this form. For a
 * library that modifies a global in someone else's page, the only meaningful
 * question — *does this actually work, in my browser, on my page* — is answered
 * by running it. A reader who has not run it has not evaluated it, and
 * installation is exactly the step that deters evaluation.
 *
 * So every behavioural claim in the documentation is executable here. A page that
 * says the tool surface refuses a badly-typed call teaches less than a page where
 * the reader types one and watches it fail: **the refusal is the content.**
 *
 * ## Everything comes from the published entry points
 *
 * `@ax-kit/core` and `@ax-kit/core/auto`, not from `src/`. A demonstration driven
 * through an internal path proves the demonstration works and tells the reader
 * nothing about what they would install. Copying the code on this page is
 * therefore copying code that works.
 *
 * ## The vocabulary is the storefront's
 *
 * `search_products`, `view_cart`, `add_to_cart`, `apply_coupon_code`,
 * `proceed_to_checkout` — the same names and argument shapes as the reference
 * storefront, so a reader who learns the vocabulary here finds it identical
 * there. Two names for one concept in two places is a failure this project has
 * committed once already; `test/vocabulary.test.ts` asserts the two files agree,
 * so it cannot happen again silently.
 *
 * ## No sleeps
 *
 * Every transition is driven by the surface's own `toolchange` event or by the
 * promise an operation returned. Nothing here waits on a timer, and that is not
 * only for tidiness: a sleep would make the demonstration lie about ordering,
 * since the draft queues change notifications as a task rather than firing them
 * synchronously.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "@ax-kit/core/auto";
import type { ModelContext, RegisteredTool } from "@ax-kit/core";

// The canonical vocabulary, duplicated from the storefront on purpose.
//
// A copy rather than an import across workspaces: this island is bundled into the
// documentation's own JavaScript, and reaching into another application's source
// to draw its vocabulary would couple the documentation's build to that
// application's layout. The duplication is checked rather than avoided — see
// `test/vocabulary.test.ts`, which fails when the two files disagree.
const TOOLS = [
	{
		name: "search_products",
		title: "Search products",
		description: "Find products by name or description.",
		consequential: false,
		schema: { query: "string", "maxPrice?": "integer" },
	},
	{
		name: "view_cart",
		title: "View cart",
		description: "Read the cart.",
		consequential: false,
		schema: {},
	},
	{
		name: "add_to_cart",
		title: "Add to cart",
		description: "Add a quantity of one product.",
		consequential: false,
		schema: { sku: "string", quantity: "integer" },
	},
	{
		name: "apply_coupon_code",
		title: "Apply coupon code",
		description: "Apply a discount.",
		consequential: false,
		schema: { code: "string" },
	},
	{
		name: "proceed_to_checkout",
		title: "Proceed to checkout",
		description: "Place the order. Irreversible.",
		consequential: true,
		schema: {},
	},
] as const;

type Row = {
	readonly name: string;
	readonly title: string;
	readonly consequential: boolean;
	readonly hasSchema: boolean;
	/**
	 * The declared argument shapes, read from the tool's own `inputSchema`.
	 *
	 * Present so the table can show the contract rather than only whether one was
	 * declared. The page claimed to display the same argument shapes as the
	 * storefront while showing a single yes/no, which made the claim false for
	 * every tool that takes arguments.
	 *
	 * `undefined` when a schema is declared but cannot be summarised, which is a
	 * different fact from "no arguments".
	 */
	readonly arguments:
		| ReadonlyArray<{
				readonly name: string;
				readonly type: string;
				readonly required: boolean;
		  }>
		| undefined;
};

/**
 * The declared argument shapes, read from a tool's `inputSchema`.
 *
 * `inputSchema` is typed `unknown`, and stays that way here. It is an
 * externally-supplied JSON Schema, so its shape is checked at runtime rather than
 * asserted: a cast would both hide a signature change and let a malformed schema
 * throw during render, which would take the whole demonstration down.
 *
 * Returns an empty list for anything that is not an object schema with a
 * `properties` dictionary. A tool that declares a schema this reader cannot
 * summarise is shown as taking unspecified arguments, which is true, rather than
 * as taking none, which would be a lie.
 */
function readArguments(schema: unknown):
	| ReadonlyArray<{
			name: string;
			type: string;
			required: boolean;
	  } | null>
	| undefined {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return undefined;
	}
	const { properties, required } = schema as {
		readonly properties?: unknown;
		readonly required?: unknown;
	};
	// `undefined` means "a schema is declared but this reader cannot summarise it".
	// It is deliberately not the same answer as an empty list: an object schema
	// can constrain its arguments with `patternProperties` or
	// `additionalProperties` and no `properties` at all, and reporting that as
	// "takes no arguments" would be a claim about the tool that the tool does not
	// make. An empty `properties` really does mean no named arguments, so that case
	// still returns an empty list.
	if (typeof properties !== "object" || properties === null) {
		return undefined;
	}
	const requiredNames = new Set(
		Array.isArray(required)
			? required.filter((n): n is string => typeof n === "string")
			: [],
	);
	const out: Array<{ name: string; type: string; required: boolean }> = [];
	for (const [name, node] of Object.entries(properties)) {
		let type = "unknown";
		if (typeof node === "object" && node !== null && !Array.isArray(node)) {
			const declared = (node as { readonly type?: unknown }).type;
			if (typeof declared === "string") {
				type = declared;
			}
		}
		out.push({ name, type, required: requiredNames.has(name) });
	}
	return out;
}

type Outcome =
	| {
			readonly id: number;
			readonly kind: "result";
			readonly label: string;
			readonly value: string;
	  }
	| {
			readonly id: number;
			readonly kind: "refusal";
			readonly label: string;
			readonly name: string;
	  }
	| {
			readonly id: number;
			readonly kind: "error";
			readonly label: string;
			readonly detail: string;
	  };

/**
 * The next log entry's id.
 *
 * Every entry needs a key React can distinguish, and two obvious choices are
 * wrong here. Keying on `${label}-${kind}` repeats as soon as a reader clicks the
 * same button twice, which is the first thing anyone does with a demonstration.
 * Keying on the array index is stable for an append-only list, but it is the
 * documented way to introduce state bugs the moment an entry is ever inserted or
 * removed, and it is refused by this repository's own lint rule.
 *
 * A counter is correct for both cases: unique by construction, and unaffected by
 * reordering.
 */
let nextOutcomeId = 0;

/** Read `document.modelContext` without pretending the DOM lib declares it. */
function surface(): ModelContext | undefined {
	return (document as unknown as Record<string, unknown>).modelContext as
		| ModelContext
		| undefined;
}

export default function TryIt(): React.JSX.Element {
	const [rows, setRows] = useState<ReadonlyArray<Row>>([]);
	const [log, setLog] = useState<ReadonlyArray<Outcome>>([]);
	const [unavailable, setUnavailable] = useState(false);
	// Tracked separately from `rows`, because "no rows" is ambiguous: it is both the
	// state while registration is in flight and the state after it failed. Leaving
	// the page on "Registering…" after a failure is a page contradicting itself,
	// and the error explaining why sits in the log further down.
	const [registrationFailed, setRegistrationFailed] = useState(false);
	// The registration controller. One for the whole set, so every tool is removed
	// together — the two lifetimes stay distinct, and the execution signal below
	// cancels one call without touching any of this.
	const controller = useRef<AbortController | null>(null);
	const mounted = useRef(true);

	// The id is stamped here rather than at each call site, so an entry cannot be
	// logged without one.
	const note = useCallback((outcome: Omit<Outcome, "id">) => {
		nextOutcomeId += 1;
		const entry = { ...outcome, id: nextOutcomeId } as Outcome;
		setLog((previous) => [...previous, entry]);
	}, []);

	useEffect(() => {
		mounted.current = true;
		const context = surface();

		if (context === undefined) {
			// The platform refused the surface: an insecure context, or a `tools`
			// Permissions Policy feature this document does not allow. Every refusal
			// below is then unreachable, so the page says so rather than offering
			// buttons that will not work.
			setUnavailable(true);
			return;
		}

		const abort = new AbortController();
		controller.current = abort;
		let cancelled = false;

		const read = async () => {
			const tools = await context.getTools();
			if (!cancelled && mounted.current) {
				setRows(
					tools.map((tool: RegisteredTool) => ({
						name: tool.name,
						title: tool.title,
						consequential: tool.annotations?.consequentialHint === true,
						hasSchema: tool.inputSchema !== undefined,
						arguments: readArguments(tool.inputSchema),
					})),
				);
			}
		};

		// The notification is what re-reads the listing. Waiting on it rather than
		// on a timer is what keeps the demonstration honest about the draft's
		// ordering: the draft queues the notification as a task, so a synchronous
		// read after `registerTool` returns would show nothing yet.
		const onChange = () => {
			void read();
		};
		context.addEventListener("toolchange", onChange);

		void Promise.all(
			TOOLS.map((tool) =>
				context.registerTool(
					{
						name: tool.name,
						title: tool.title,
						description: tool.description,
						...(tool.schema === undefined ||
						Object.keys(tool.schema).length === 0
							? {}
							: {
									inputSchema: {
										type: "object",
										properties: Object.fromEntries(
											Object.entries(tool.schema).map(([key, kind]) => [
												key.replace("?", ""),
												{ type: kind },
											]),
										),
										required: Object.keys(tool.schema).filter(
											(key) => !key.endsWith("?"),
										),
									},
								}),
						execute: async () => ({
							tool: tool.name,
							describedBy: "the demonstration",
						}),
						annotations: {
							readOnlyHint:
								tool.name === "search_products" || tool.name === "view_cart",
							consequentialHint: tool.consequential,
						},
					},
					{ signal: abort.signal },
				),
			),
		)
			.then(read)
			.catch((error: unknown) => {
				if (!cancelled && mounted.current) {
					setRegistrationFailed(true);
					note({
						kind: "error",
						label: "registration",
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			});

		return () => {
			cancelled = true;
			mounted.current = false;
			context.removeEventListener("toolchange", onChange);
			// Removal by aborting the registration signal. Deregistering a tool must
			// not cancel a call that is already running, which is why the execution
			// signal below is a separate controller.
			abort.abort();
		};
	}, [note]);

	const invoke = useCallback(
		async (name: string, input: unknown, label: string) => {
			const context = surface();
			if (context === undefined) {
				return;
			}
			const tools = await context.getTools();
			const tool = tools.find((entry) => entry.name === name);
			if (tool === undefined) {
				note({ kind: "error", label, detail: `no tool named ${name}` });
				return;
			}
			try {
				const raw = await context.executeTool(tool, input);
				// The draft's return type is `Promise<DOMString>` over a JSON
				// serialization, so an object arrives as text. Displaying the raw
				// string rather than the parsed value is what shows that.
				note({ kind: "result", label, value: raw });
			} catch (error) {
				note({
					kind: "refusal",
					label,
					name: error instanceof DOMException ? error.name : "Error",
				});
			}
		},
		[note],
	);

	if (unavailable) {
		return (
			<div className="ax-try ax-try--unavailable">
				<p>
					This document has no tool surface, so the demonstration below cannot
					run. The usual cause is that this page is served without the{" "}
					<code>tools</code> permission policy.
				</p>
			</div>
		);
	}

	return (
		<div className="ax-try">
			<p>
				Everything below is running in your browser against the published entry
				points. Register, enumerate, invoke and watch what two malformed calls
				do.
			</p>
			<p className="ax-try__muted">
				With <em>this library</em> answering, both are refused. It checks the
				arguments against the declared <code>inputSchema</code> before a tool's{" "}
				<code>execute</code> runs. It reports the failure as the draft's
				generic <code>UnknownError</code>, so an agent cannot tell a bad{" "}
				<code>query</code> from a missing one. That is a limitation worth seeing
				rather than a conformance claim.
			</p>
			<p className="ax-try__muted">
				<b>
					If your browser ships its own <code>document.modelContext</code>
				</b>
				, it is that surface which answers here, not this library:{" "}
				<code>installModelContext</code> preserves an existing implementation
				rather than replacing it. The draft does not require a native surface to
				check <code>inputSchema</code>. This demonstration's handlers do not
				throw, so on such a browser both calls may succeed. That would be the
				native surface behaving as specified, not a fault here.
			</p>

			<h4>What an agent sees on this page</h4>
			{rows.length === 0 ? (
				registrationFailed ? (
					<p className="ax-try__muted">
						Registration failed. The reason is in the log below.
					</p>
				) : (
					<p>Registering…</p>
				)
			) : (
				// The scroll wrapper below is what keeps this table usable on a
				// phone: four columns do not fit 360px, and without it the table
				// either crushes its code column into wrapping mid-identifier
				// or pushes the whole page sideways.
				<div className="ax-try__scroll" tabIndex={0} role="region" aria-label="Registered tools">
				<table className="ax-try__table">
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Title</th>
							<th scope="col">Consequential</th>
							<th scope="col">Arguments</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.name}>
								<td>
									<code>{row.name}</code>
								</td>
								<td>{row.title}</td>
								<td>
									{row.consequential ? (
										<strong>yes</strong>
									) : (
										<span className="ax-try__muted">no</span>
									)}
								</td>
								<td>
									{row.hasSchema ? (
										row.arguments === undefined ? (
											<span className="ax-try__muted">
												declared, but not summarisable here
											</span>
										) : (
											<code>
												{row.arguments.length === 0
													? "none"
													: row.arguments
															.map(
																(argument) =>
																	`${argument.name}${argument.required ? "" : "?"}: ${argument.type}`,
															)
															.join(", ")}
											</code>
										)
									) : (
										<span className="ax-try__muted">takes none</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				</div>
			)}

			<h4>Invoke one</h4>
			<p className="ax-try__muted">
				The first two calls are well formed and succeed. The last two break
				the declared <code>inputSchema</code> and are refused with{" "}
				<code>UnknownError</code> before any tool code runs.
			</p>
			<div className="ax-try__group">
				<p className="ax-try__group-label">Calls that succeed</p>
				<p className="ax-try__actions">
					<button
						type="button"
						onClick={() =>
							void invoke(
								"search_products",
								{ query: "mug" },
								"search with query mug",
							)
						}
					>
						{"search_products({ query: \"mug\" })"}
					</button>
					<button
						type="button"
						onClick={() =>
							void invoke("proceed_to_checkout", undefined, "checkout")
						}
					>
						proceed_to_checkout()
					</button>
				</p>
			</div>
			<div className="ax-try__group">
				<p className="ax-try__group-label">
					Calls that are refused with <code>UnknownError</code>
				</p>
				<p className="ax-try__actions">
					<button
						type="button"
						onClick={() =>
							void invoke(
								"search_products",
								{ query: 42 },
								"search with numeric query",
							)
						}
					>
						{"search_products({ query: 42 })"}
					</button>
					<button
						type="button"
						onClick={() =>
							void invoke("search_products", {}, "search with no query")
						}
					>
						{"search_products({})"}
					</button>
				</p>
			</div>

			<h4>What came back</h4>
			{log.length === 0 ? (
				<p className="ax-try__muted">Nothing yet.</p>
			) : (
				<ol className="ax-try__log">
					{log.map((entry) => (
						<li key={entry.id}>
							<span className="ax-try__label">{entry.label}</span>
							{entry.kind === "result" && (
								<>
									{" → "}
									<code>{entry.value}</code>
									<span className="ax-try__muted">
										{" "}
										(a string, as the draft specifies)
									</span>
								</>
							)}
							{entry.kind === "refusal" && (
								<>
									{" → rejected with "}
									<code>{entry.name}</code>
								</>
							)}
							{entry.kind === "error" && (
								<>
									{" → "}
									<code>{entry.detail}</code>
								</>
							)}
						</li>
					))}
				</ol>
			)}

			{/*
			 * The consequence of the annotation is stated here rather than left for the
			 * reader to infer from a table cell, because it is the one thing on this
			 * page that a reader is most likely to get wrong in their own page.
			 */}
			<p className="ax-try__note">
				<strong>One tool is consequential and four are not.</strong>{" "}
				<code>proceed_to_checkout</code> spends money and cannot be undone. The
				two cart mutations are reversible and cost nothing. A user who clicked{" "}
				<em>add to cart</em> has already confirmed it. Over-annotating trains
				agents and users to dismiss confirmations, which is the failure mode the
				annotation exists to prevent.
			</p>
		</div>
	);
}
