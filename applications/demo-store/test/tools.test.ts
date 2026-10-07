// Copyright 2026 Utpal Sen
// SPDX-License-Identifier: Apache-2.0

// What an agent observes on this page.
//
// Every assertion here is about the published surface — names, schema
// rejection, annotations in the enumerated output, ordering — rather than about
// how the store is implemented. A test that asserted "registerTool was called
// five times" would break on any refactor and prove nothing about whether an
// agent can use the shop.
//
// The store is reset between cases. State that survives between tool calls is
// the point of a cart, so tests that do not reset would pass in one order and
// fail in another.

import type { ModelContext, RegisteredTool } from "@ax-kit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTool, registerStorefrontTools } from "../src/lib/register";
import { resetStore } from "../src/lib/store";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../src/lib/tools";

/**
 * The canonical vocabulary, in the order a page author reads it.
 *
 * This is the *declaration* order — search, read, add, discount, check out —
 * which is how a shopping flow is described and how the storefront's own copy
 * lists them. It is deliberately not the order an agent sees, because the
 * draft specifies that `getTools()` resolves ascending by name. Those two orders
 * differ, and conflating them would mean the example taught the wrong thing
 * about either.
 */
const DECLARED_ORDER = [
	"search_products",
	"view_cart",
	"add_to_cart",
	"apply_coupon_code",
	"proceed_to_checkout",
];

/** The draft's specified listing order: ascending by name. */
const LISTING_ORDER = [...DECLARED_ORDER].sort();

function context(): ModelContext {
	// Read through `document` rather than as a bare `document.modelContext`: the
	// surface is not in the DOM lib's types until the platform ships it, and a cast
	// to a hand-written interface would typecheck while hiding a signature change
	// from the compiler. The real type comes from `@ax-kit/core`, so a rename
	// upstream fails this line rather than passing it.
	//
	// `document` and not `globalThis`: the installer defines the property on the
	// document object, and the two are the same object in a browser but not
	// necessarily in every DOM implementation the fast layer runs on.
	const installed = (document as unknown as Record<string, unknown>)
		.modelContext as ModelContext | undefined;
	if (installed === undefined) {
		throw new Error("document.modelContext is not installed");
	}
	return installed;
}

let dispose: (() => void) | undefined;

/**
 * Register the five tools and return the surface.
 *
 * Registration is per-test and torn down in `afterEach`. It has to be: the
 * surface is installed once for the whole file and the registry refuses a
 * duplicate name, so a test that registered without cleaning up would fail every
 * test after it with `duplicate tool search_products` — a cascade that looks
 * like a broken registry and is really a leaking fixture.
 */
async function surface(): Promise<ModelContext> {
	const installed = context();
	dispose = await registerStorefrontTools(installed);
	return installed;
}

/**
 * Wait for the surface to hold no tools.
 *
 * Removal is by aborting the registration signal, and the draft queues the
 * change notification as a task rather than firing it synchronously. So the wait
 * is on the notification and then on the listing — never a sleep, which would be
 * both flaky in CI and blind to the ordering the draft specifies.
 */
async function settled(afterListening?: () => void): Promise<void> {
	await new Promise<void>((resolve) => {
		context().addEventListener("toolchange", () => resolve(), { once: true });
		// The action runs *after* the listener is attached, not before. It used to
		// be called by the caller first and awaited afterwards, which left the
		// window between disposal and attachment — a registry that dispatched
		// `toolchange` synchronously would resolve nothing and the test would sit
		// until the runner timed it out. That the draft queues the notification as a
		// task is why it never happened, and depending on that is not the same as
		// being correct.
		afterListening?.();
	});
}

async function invoke(
	name: string,
	input?: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
	const ctx = context();
	const tools = await ctx.getTools();
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) {
		throw new Error(`no tool named ${name}`);
	}
	try {
		const raw = await ctx.executeTool(tool as RegisteredTool, input);
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (error) {
		return { ok: false, error };
	}
}

beforeEach(() => {
	resetStore();
});

afterEach(async () => {
	// The surface is installed once per process by `test/setup.ts`, so every test
	// shares it and differs only in which tools are registered. Teardown removes
	// them; without it the registry refuses the next test's first registration as
	// a duplicate.
	if (dispose === undefined) {
		return;
	}
	const remove = dispose;
	dispose = undefined;
	await settled(remove);
});

describe("the published vocabulary", () => {
	it("publishes exactly the five canonical tools, in the specified listing order", async () => {
		await surface();
		const tools = await context().getTools();
		// The draft specifies ascending by name. Asserting the declaration order
		// here would be asserting an implementation accident rather than
		// conformance.
		expect(tools.map((tool) => tool.name)).toEqual(LISTING_ORDER);
	});

	it("declares them in the order a shopping flow is described, which differs", () => {
		// Two orders, deliberately, and this asserts they differ. A reference
		// example that listed them in sorted order everywhere would read as
		// though sorting were the author's intent; it is the draft's rule, not
		// this shop's.
		expect(TOOL_NAMES).toEqual(DECLARED_ORDER);
		expect(LISTING_ORDER).not.toEqual(DECLARED_ORDER);
	});

	it("does not expose a sixth tool", async () => {
		await surface();
		expect(await context().getTools()).toHaveLength(5);
	});
});

describe("annotations", () => {
	it("marks only the irreversible tool consequential", async () => {
		await surface();
		const tools = await context().getTools();
		const consequential = tools
			.filter((tool) => tool.annotations?.consequentialHint === true)
			.map((tool) => tool.name);
		// Not "at least one": the argument for annotating exactly one is the
		// whole reason this example is useful, so a second annotation is a
		// failure rather than a wider demonstration.
		expect(consequential).toEqual(["proceed_to_checkout"]);
	});

	it("marks the two cart mutations not consequential, and says why", async () => {
		await surface();
		const tools = await context().getTools();
		for (const name of ["add_to_cart", "apply_coupon_code"]) {
			const tool = tools.find((entry) => entry.name === name);
			expect(
				tool?.annotations?.consequentialHint,
				`${name} is reversible and costs nothing, so over-annotating it would train agents to dismiss confirmations`,
			).toBeFalsy();
		}
	});

	it("marks the read-only tools read-only", async () => {
		await surface();
		const tools = await context().getTools();
		const readOnly = tools
			.filter((tool) => tool.annotations?.readOnlyHint === true)
			.map((tool) => tool.name);
		expect(readOnly.sort()).toEqual(["search_products", "view_cart"]);
	});

	it("invents no annotation the draft does not define", async () => {
		await surface();
		const tools = await context().getTools();
		const defined = new Set([
			"readOnlyHint",
			"untrustedContentHint",
			"consequentialHint",
			"debugging",
		]);
		for (const tool of tools) {
			for (const key of Object.keys(tool.annotations ?? {})) {
				expect(
					defined.has(key),
					`${key} is not a draft-defined annotation`,
				).toBe(true);
			}
		}
	});
});

describe("argument schemas", () => {
	it("declares a schema for every tool that takes arguments, and none for the two that do not", async () => {
		await surface();
		const tools = await context().getTools();
		// Two tools take nothing: the cart read and the checkout. Both are real
		// cases rather than degenerate ones, and a schema is omitted for both —
		// declaring an empty object would imply arguments exist and merely happen
		// to be optional.
		const takesNone = ["view_cart", "proceed_to_checkout"];
		for (const tool of tools) {
			if (takesNone.includes(tool.name)) {
				expect(
					tool.inputSchema,
					`${tool.name} takes no arguments, so it declares no schema`,
				).toBeUndefined();
				continue;
			}
			expect(
				tool.inputSchema,
				`${tool.name} declares no inputSchema`,
			).toBeDefined();
		}
	});

	it("hands an agent a schema that round-trips to what was declared", async () => {
		await surface();
		const tools = await context().getTools();
		const search = tools.find((tool) => tool.name === "search_products");
		// The draft serialises `inputSchema` at registration and the registry
		// holds the serialized form, so what comes back on a listing is that
		// string's parsed value. Round-tripping is the observable consequence, and
		// it is the right thing to assert: asserting the intermediate type would
		// be asserting an implementation detail of this registry rather than the
		// behaviour an agent depends on.
		expect(search?.inputSchema).toEqual(TOOL_DEFINITIONS[0]?.inputSchema);
	});

	it("keeps the declared schema's required members on the enumerated copy", async () => {
		await surface();
		const tools = await context().getTools();
		const schema = tools.find((tool) => tool.name === "add_to_cart")
			?.inputSchema as { required?: unknown };
		// An agent decides what to send from this. A schema that lost its
		// `required` on the way through registration would still parse and still
		// look right in a snapshot test, and would make every call a guess.
		expect(schema.required).toEqual(["sku", "quantity"]);
	});
});

describe("schema rejection is ours, not the platform's", () => {
	// Two layers of assertion, because the draft puts them in different places.
	//
	// What an agent observes through `executeTool` is a rejection — and the
	// draft specifies that a callback which throws rejects with `UnknownError`,
	// so the handler's own message does not reach the caller. Asserting the
	// message here would be asserting something the specification says cannot
	// happen.
	//
	// What the page author observes is the message, on the object handed to
	// `registerTool`. That is asserted against `buildTool` directly, which is
	// also the artefact a reader would inspect.

	async function refusal(name: string, input: unknown): Promise<unknown> {
		await surface();
		const result = await invoke(name, input);
		expect(result.ok, `${name} should have been refused`).toBe(false);
		return result.error;
	}

	function handler(name: string): (input: unknown) => Promise<unknown> {
		const definition = TOOL_DEFINITIONS.find((entry) => entry.name === name);
		if (definition === undefined) {
			throw new Error(`no definition named ${name}`);
		}
		return buildTool(definition).execute as (
			input: unknown,
		) => Promise<unknown>;
	}

	it("rejects a search whose query is not a string, with UnknownError", async () => {
		const error = await refusal("search_products", { query: 42 });
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("UnknownError");
	});

	it("names the offending argument in the page author's own diagnostic", async () => {
		await expect(handler("search_products")({ query: 42 })).rejects.toThrow(
			/"query" must be a string, got number/,
		);
	});

	it("rejects a search with no query at all", async () => {
		expect(await refusal("search_products", {})).toBeInstanceOf(DOMException);
		await expect(handler("search_products")({})).rejects.toThrow(
			/missing required argument "query"/,
		);
	});

	it("rejects a non-integer quantity", async () => {
		const error = await refusal("add_to_cart", {
			sku: "AX-MUG-001",
			quantity: 1.5,
		});
		expect((error as DOMException).name).toBe("UnknownError");
		await expect(
			handler("add_to_cart")({ sku: "AX-MUG-001", quantity: 1.5 }),
		).rejects.toThrow(/"quantity" must be an integer/);
	});

	it("rejects a null where an optional integer is declared", async () => {
		// `null` is a value, not an absence. Reading it as absence would make a
		// caller's mistake look like a correct call.
		const error = await refusal("search_products", {
			query: "mug",
			maxPrice: null,
		});
		expect((error as DOMException).name).toBe("UnknownError");
		await expect(
			handler("search_products")({ query: "mug", maxPrice: null }),
		).rejects.toThrow(/"maxPrice" must be an integer when present, got null/);
	});

	it("rejects arguments to a tool that takes none", async () => {
		await surface();
		expect((await invoke("view_cart", {})).ok).toBe(true);
		expect((await invoke("view_cart", { anything: 1 })).ok).toBe(false);
		await expect(handler("view_cart")({ anything: 1 })).rejects.toThrow(
			/takes no arguments/,
		);
	});

	it("rejects arguments to the consequential tool too", async () => {
		await surface();
		// `proceed_to_checkout` declares no schema, exactly as `view_cart` does,
		// and it is the call that spends money. Refusing a caller's unexpected
		// arguments is *more* important here, not less, so it must not be the one
		// tool that silently ignores them.
		//
		// The cart is filled first because checkout refuses an empty one, and
		// that refusal would otherwise be indistinguishable from the one under
		// test: both come back as `ok: false`.
		expect(
			(await invoke("add_to_cart", { sku: "AX-MUG-001", quantity: 1 })).ok,
		).toBe(true);
		expect((await invoke("proceed_to_checkout", {})).ok).toBe(true);
		expect((await invoke("proceed_to_checkout", { anything: 1 })).ok).toBe(
			false,
		);
		await expect(
			handler("proceed_to_checkout")({ anything: 1 }),
		).rejects.toThrow(/takes no arguments/);
	});

	it("rejects a quantity that would make the total inexact", async () => {
		await surface();
		// `1e300` is an integer and is well above 1, so the declared schema accepts
		// it — the schema checks the type and nothing else. Accepted, it multiplied
		// by a price in minor units produces a total no integer can represent, and
		// the agent is shown a cart total that is wrong. The bound therefore has to
		// be the handler's, and this asserts that it is.
		for (const bad of [1e300, Number.MAX_SAFE_INTEGER, 1001]) {
			await expect(
				handler("add_to_cart")({ sku: "AX-MUG-001", quantity: bad }),
				`${bad} should be refused`,
			).rejects.toThrow(/between 1 and 1000/);
		}
		// And the largest permitted quantity still produces an exact total, so the
		// bound is not simply refusing everything.
		await expect(
			handler("add_to_cart")({ sku: "AX-BAG-006", quantity: 1000 }),
		).resolves.toBeDefined();
	});

	it("rejects a primitive in place of an object", async () => {
		await surface();
		for (const bad of [42, "nope", null, []]) {
			expect(
				(await invoke("add_to_cart", bad)).ok,
				`${JSON.stringify(bad)} should be refused`,
			).toBe(false);
		}
		await expect(handler("add_to_cart")(42)).rejects.toThrow(
			/expected an object argument, got number/,
		);
	});

	it("never reaches a handler with bad arguments", async () => {
		// The observable proof that validation runs before the handler: a refused
		// call leaves the cart exactly as it was. If the handler ran first and
		// validated afterwards, the state would already have moved.
		await surface();
		await invoke("add_to_cart", { sku: "AX-MUG-001", quantity: 2 });
		const before = await invoke("view_cart");
		await invoke("add_to_cart", { sku: "AX-MUG-001", quantity: "lots" });
		const after = await invoke("view_cart");
		expect(after.value).toEqual(before.value);
	});
});

describe("invocation", () => {
	it("runs a search with its optional argument omitted", async () => {
		await surface();
		const result = await invoke("search_products", { query: "mug" });
		expect(result.ok).toBe(true);
		const value = result.value as { products: ReadonlyArray<{ name: string }> };
		expect(value.products.map((entry) => entry.name)).toContain("Enamel Mug");
	});

	it("ranks a prefix match above every kind of substring match", async () => {
		await surface();
		// "m" reaches all three ranks at once, which is the point of choosing it:
		//
		//   "Merino Socks, Three Pack"  prefix of the name            -> ranked 1st
		//   "Enamel Mug"                "m" inside the name           -> ranked 2nd
		//   "Cotton T-Shirt"            "m" only in the summary       -> ranked 2nd
		//
		// Summaries are deliberately not scored, so the last two tie and fall
		// through to alphabetical order — which puts "Cotton T-Shirt" before
		// "Enamel Mug". And with all three scores equal, alphabetical order puts
		// "Cotton T-Shirt" *first*, ahead of the only prefix match.
		//
		// So the first entry discriminates: it is the prefix match only if the
		// three ranks are distinct. Asserting membership alone would pass either
		// way, which is why this asserts the position.
		const result = await invoke("search_products", { query: "m" });
		expect(result.ok).toBe(true);
		const value = result.value as { products: ReadonlyArray<{ name: string }> };
		const names = value.products.map((entry) => entry.name);
		expect(names).toEqual([
			"Merino Socks, Three Pack",
			"Cotton T-Shirt",
			"Enamel Mug",
		]);
	});

	it("runs a search with its optional argument present, and the bound applies", async () => {
		await surface();
		const unbounded = await invoke("search_products", { query: "" });
		const bounded = await invoke("search_products", {
			query: "",
			maxPrice: 2000,
		});
		const all = (unbounded.value as { products: unknown[] }).products;
		const cheap = (bounded.value as { products: unknown[] }).products;
		expect(cheap.length).toBeLessThan(all.length);
	});

	it("resolves to a serialized string, as the draft's return type requires", async () => {
		await surface();
		const tools = await context().getTools();
		const view = tools.find((tool) => tool.name === "view_cart");
		const raw = await context().executeTool(view as RegisteredTool);
		expect(typeof raw).toBe("string");
		// The draft's algorithm serializes a JavaScript value to a JSON string, so
		// an object result comes back as text and has to be parsed by the caller.
		expect(typeof JSON.parse(raw)).toBe("object");
	});

	it("lets an agent add, read, discount and check out", async () => {
		await surface();
		expect(
			(await invoke("add_to_cart", { sku: "AX-MUG-001", quantity: 2 })).ok,
		).toBe(true);

		const cart = await invoke("view_cart");
		const value = cart.value as {
			lines: ReadonlyArray<{ sku: string; quantity: number }>;
			subtotal: number;
		};
		expect(value.lines).toEqual([{ sku: "AX-MUG-001", quantity: 2 }]);
		// 2 × 1200, in minor units. Asserted rather than computed from the
		// catalogue so that a price change in the data is a visible test failure
		// rather than a silently updated expectation.
		expect(value.subtotal).toBe(2400);

		const coupon = await invoke("apply_coupon_code", { code: "axkit10" });
		// Ten percent of 2400, which is the whole point of the code being
		// percentage-shaped rather than a flat amount.
		expect((coupon.value as { discount: number }).discount).toBe(240);

		const order = await invoke("proceed_to_checkout");
		expect((order.value as { orderId: string }).orderId).toMatch(/^AX-\d{4}$/);
	});

	it("rejects an unknown coupon without touching the cart", async () => {
		await surface();
		await invoke("add_to_cart", { sku: "AX-MUG-001", quantity: 1 });
		const before = await invoke("view_cart");
		const result = await invoke("apply_coupon_code", { code: "NOPE" });
		expect(result.ok).toBe(false);
		expect((await invoke("view_cart")).value).toEqual(before.value);
	});
});

describe("lifecycle", () => {
	it("removes every tool when the returned disposer runs", async () => {
		// Registered here rather than through `surface()` so the disposer belongs
		// to this test and `afterEach` has nothing left to tear down.
		const disposeHere = await registerStorefrontTools(context());
		expect(await context().getTools()).toHaveLength(5);
		await settled(disposeHere);
		expect(await context().getTools()).toHaveLength(0);
	});

	it("keeps the other tools registered when one registration is refused", async () => {
		// A duplicate name is the natural way to provoke a refused registration,
		// and `view_cart` is already taken by the set this test registered.
		await surface();
		await expect(
			context().registerTool({
				name: "view_cart",
				description: "a second one, which must be refused",
				execute: async () => null,
			}),
		).rejects.toThrow();
		expect(await context().getTools()).toHaveLength(5);
	});

	it("keeps the registration signal and the execution signal distinct", async () => {
		// Cancelling one call must not unregister the tool. Conflating the two
		// lifetimes is the bug the register function's shape exists to avoid.
		await surface();
		const tools = await context().getTools();
		const search = tools.find((tool) => tool.name === "search_products");
		const controller = new AbortController();
		const call = context().executeTool(
			search as RegisteredTool,
			{ query: "mug" },
			{ signal: controller.signal },
		);
		controller.abort();
		await expect(call).rejects.toThrow();
		// The tool is still there, because its lifetime is the registration one.
		expect((await context().getTools()).map((tool) => tool.name)).toEqual(
			LISTING_ORDER,
		);
	});
});
