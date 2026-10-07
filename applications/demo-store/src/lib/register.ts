/**
 * Binding the storefront's vocabulary to the tool surface.
 *
 * This is the only file in the example that imports `@ax-kit/core`, and it is
 * the file a page author copies. Everything it does is either draft-defined or
 * one line of glue; the store's own logic lives in `store.ts`, where it can be
 * tested without a browser.
 *
 * ## Argument validation is ours, not the platform's
 *
 * The draft's `inputSchema` is a *declared contract*. It describes what a
 * well-formed call looks like; the draft does not implement checking against
 * it, because the draft is a platform specification and the platform validates
 * its own dictionaries. A polyfill has to do that work itself, and a
 * badly-typed call must not reach a handler.
 *
 * So every handler begins by validating its arguments from `unknown` against the
 * same schema it registered. The two are written from one table
 * (`TOOL_DEFINITIONS`) so they cannot drift apart, and the test suite asserts
 * that a wrongly-typed call is refused before any handler runs.
 *
 * ## Registration and removal are separate lifetimes
 *
 * Registration is controlled by one `AbortSignal` — this controller — and
 * execution by a different one, passed per call. That distinction is the
 * draft's, and conflating them is the bug this function's shape exists to
 * avoid: deregistering a tool must not cancel an unrelated call, and cancelling
 * a call must not remove the tool.
 */

import type {
	ModelContext,
	ModelContextTool,
	ToolExecuteCallback,
} from "@ax-kit/core";
import {
	addToCart,
	applyCouponCode,
	currentCart,
	proceedToCheckout,
	searchProducts,
	viewCartResult,
} from "./store";
import type { ToolDefinition } from "./tools";
import { TOOL_DEFINITIONS } from "./tools";

/** A refusal by our own validation, as distinct from a handler's own failure. */
class BadArguments extends Error {
	constructor(tool: string, detail: string) {
		super(`${tool}: ${detail}`);
		this.name = "BadArguments";
	}
}

/**
 * Read one required member of the shape.
 *
 * Everything crossing into a handler is `unknown`, because the caller is an
 * agent and an agent can send anything. Each read is checked rather than cast:
 * a cast here would move a type error from a readable message to a `TypeError`
 * from three frames down inside unrelated code.
 */
function required(value: unknown, name: string, tool: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BadArguments(
			tool,
			`expected an object argument, got ${describe(value)}`,
		);
	}
	const member = (value as Record<string, unknown>)[name];
	if (member === undefined) {
		throw new BadArguments(tool, `missing required argument "${name}"`);
	}
	return member;
}

function requiredString(value: unknown, name: string, tool: string): string {
	const member = required(value, name, tool);
	if (typeof member !== "string") {
		throw new BadArguments(
			tool,
			`"${name}" must be a string, got ${describe(member)}`,
		);
	}
	return member;
}

function requiredInteger(value: unknown, name: string, tool: string): number {
	const member = required(value, name, tool);
	if (typeof member !== "number" || !Number.isInteger(member)) {
		throw new BadArguments(
			tool,
			`"${name}" must be an integer, got ${describe(member)}`,
		);
	}
	return member;
}

/**
 * An optional member, present-and-typed or absent.
 *
 * `undefined` and a present `null` are different: the draft's dictionary members
 * default when *absent*, and a caller sending `{"maxPrice": null}` has sent a
 * value, not omitted one. So this refuses `null` rather than treating it as
 * absence, because silently reading it as absent would make a mistake look like
 * a correct call.
 */
function optionalInteger(
	value: unknown,
	name: string,
	tool: string,
): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BadArguments(
			tool,
			`expected an object argument, got ${describe(value)}`,
		);
	}
	const member = (value as Record<string, unknown>)[name];
	if (member === undefined) {
		return undefined;
	}
	if (typeof member !== "number" || !Number.isInteger(member)) {
		throw new BadArguments(
			tool,
			`"${name}" must be an integer when present, got ${describe(member)}`,
		);
	}
	return member;
}

function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "an array";
	}
	return typeof value;
}

/**
 * The handler for one tool definition.
 *
 * Written as a table rather than five functions so the mapping from a declared
 * schema to the validation it performs is one line each and visible at a glance.
 * A reader should be able to see, without opening another file, that every tool
 * that declares an argument validates it.
 */
/**
 * Refuse any arguments to a tool that declares none.
 *
 * Both `view_cart` and `proceed_to_checkout` declare no schema. A schema that
 * says nothing accepts still means *nothing*, not *anything*, so a caller that
 * sends arguments has made a mistake and should be told so rather than quietly
 * given the right answer to a question they did not ask.
 *
 * Shared rather than written twice: the refusal is the teaching moment in both
 * handlers, and two copies of it would be free to drift apart.
 */
function refusesArguments(tool: string): (input: unknown) => void {
	return (input: unknown) => {
		// Accepts only an empty, non-array object, and refuses everything else.
		//
		// The earlier version refused an object with keys and let everything
		// through otherwise — so `[]`, `true` and `42` all reached the handler. For
		// `proceed_to_checkout` that meant an order was placed on a populated cart
		// by a caller that sent something other than no arguments at all, which is
		// the opposite of what the refusal is for.
		//
		// `buildTool` normalises `undefined` and `null` to `{}` before calling the
		// handler, so "no arguments" arrives here as the empty object and every
		// other shape is a caller that sent something. An array is refused rather
		// than treated as empty: `Object.keys([])` is `[]`, so the earlier check
		// could not tell an empty array from no arguments.
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			Object.keys(input as Record<string, unknown>).length > 0
		) {
			throw new BadArguments(tool, "takes no arguments");
		}
	};
}

const HANDLERS: Readonly<Record<string, (input: unknown) => unknown>> = {
	search_products: (input) => {
		const query = requiredString(input, "query", "search_products");
		const maxPrice = optionalInteger(input, "maxPrice", "search_products");
		return {
			products: searchProducts(
				maxPrice === undefined ? { query } : { query, maxPrice },
			),
		};
	},
	view_cart: (input) => {
		refusesArguments("view_cart")(input);
		return viewCartResult();
	},
	add_to_cart: (input) => {
		const sku = requiredString(input, "sku", "add_to_cart");
		const quantity = requiredInteger(input, "quantity", "add_to_cart");
		return addToCart({ sku, quantity });
	},
	apply_coupon_code: (input) => {
		const code = requiredString(input, "code", "apply_coupon_code");
		return applyCouponCode({ code });
	},
	proceed_to_checkout: (input) => {
		// The consequential tool refuses arguments for the same reason the
		// read-only one does. It is the call that spends money, so the case for
		// saying "that is not a call I recognise" is stronger here, not weaker.
		refusesArguments("proceed_to_checkout")(input);
		return proceedToCheckout();
	},
};

/**
 * Publish the storefront's tools.
 *
 * Returns a function that removes all of them. Removal is ours, not the draft's:
 * the draft removes by aborting the registration signal, and
 * `unregisterTool` from `@ax-kit/core/ax` removes synchronously, which is what a
 * component teardown needs. Both routes end in the same place, and the returned
 * function here uses the draft's mechanism — one controller for the whole set,
 * aborted together.
 *
 * The signal is *not* passed to any handler. That is the whole point of keeping
 * the two lifetimes distinct: deregistering the set must not cancel a call that
 * is already running, and a caller cancelling its own call must not remove the
 * tools.
 */
export async function registerStorefrontTools(
	context: ModelContext,
): Promise<() => void> {
	const controller = new AbortController();
	const handles: Promise<undefined>[] = [];

	for (const definition of TOOL_DEFINITIONS) {
		handles.push(
			context.registerTool(buildTool(definition), {
				signal: controller.signal,
			}),
		);
	}

	// Awaited together rather than one at a time, which is a shorter wait and
	// nothing else. It does *not* batch the change notifications: all five
	// `registerTool` calls have already been started by the loop above, so
	// awaiting them in sequence would emit exactly the same five notifications.
	// Whether those coalesce into one is the registry's business, not this
	// function's, and claiming otherwise here would teach a reader something
	// untrue about a limit they are paying for.
	await Promise.all(handles);

	return () => {
		controller.abort();
	};
}

/**
 * Build the object handed to `registerTool` for one definition.
 *
 * Exported because it is the artefact a page author actually wants to inspect:
 * everything the example does to the draft's surface is visible in one returned
 * object, and a test can call `execute` directly to see the validation without a
 * document.
 *
 * Worth knowing when reading it: the draft specifies that a callback which
 * throws rejects the caller with `UnknownError`, so the message a handler throws
 * is **not** what an agent sees. `BadArguments` produces a readable refusal in a
 * console, and an agent sees `UnknownError`. That is the specification's
 * behaviour rather than this example's choice, and a page author who needs a
 * distinguishable refusal for a caller has to validate before invoking.
 */
export function buildTool(definition: ToolDefinition): ModelContextTool {
	const handler = HANDLERS[definition.name];
	if (handler === undefined) {
		// Unreachable by construction: both tables are written here and the
		// definition list is exhaustive. A missing handler would otherwise
		// register a tool that throws `is not a function` on first call, which
		// is a much worse thing for a reader of a reference example to meet.
		throw new Error(`no handler for ${definition.name}`);
	}
	const execute: ToolExecuteCallback = async (inputObject) =>
		handler(inputObject ?? {});

	return {
		name: definition.name,
		title: definition.title,
		description: definition.description,
		...(definition.inputSchema === undefined
			? {}
			: { inputSchema: definition.inputSchema }),
		execute,
		// The annotation is derived from the definition rather than written out
		// per tool, so the consequential/non-consequential decision is visible in
		// one table with its reasoning rather than scattered across registrations
		// where it cannot be compared at a glance.
		annotations: {
			readOnlyHint: !MUTATES.has(definition.name),
			consequentialHint: definition.consequential,
		},
	};
}

/** The tools that change something. Drives `readOnlyHint`; see `toTool`. */
const MUTATES: ReadonlySet<string> = new Set([
	"add_to_cart",
	"apply_coupon_code",
	"proceed_to_checkout",
]);

export { currentCart };
