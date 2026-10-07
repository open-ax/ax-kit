/**
 * The canonical tool vocabulary.
 *
 * One set of names and one set of argument shapes, used identically here, in
 * the documentation site, and in every example in this project. Two names for
 * one concept in two places is a failure mode worth designing against, and a
 * reference implementation whose whole job is to be copied must not ship it.
 *
 * The names are snake_case because tool names are an interface between an agent
 * and a page, and an agent that has learned one convention reads another one
 * correctly. The draft's name rule permits 1–128 characters of `[A-Za-z0-9_.-]`,
 * which these satisfy.
 *
 * The argument schemas are JSON Schema in the restricted subset the draft's
 * `inputSchema` describes: `type`, `properties`, `required`, and nothing else.
 * They are declared as data, validated from `unknown` at every boundary, and
 * serialised at registration time.
 *
 * ## Which tools are consequential, and why
 *
 * Only `proceed_to_checkout` carries `consequentialHint`.
 *
 * That is not a judgement about severity — placing an order spends money and
 * cannot be undone. The draft's semantics are about what a person would want to
 * approve *first*, and the test is whether the effect is irreversible or
 * reaches the world.
 *
 * `add_to_cart` and `apply_coupon_code` deliberately do **not** carry it. Both
 * are reversible, neither spends anything, neither contacts anyone, and a user
 * who clicks "add to cart" has already confirmed the addition by clicking. This
 * is the argument written out because it is the part a reader is most likely to
 * get wrong: over-annotating trains agents and users to dismiss confirmations,
 * which is the exact failure mode that the consequential annotation exists to
 * prevent. An annotation nobody ever sees acted on is worse than no annotation.
 *
 * A separate sensitivity annotation has been discussed upstream and is not used
 * here. Inventing a name the draft does not define is exactly what this project
 * refuses to do; if it lands, these tools are revisited against it.
 *
 * ## No origin restrictions
 *
 * `exposedTo` is omitted on every tool. Narrowing a surface to particular
 * origins is supported and valuable, and it is exercised in this project's own
 * test suite and documentation. A storefront that hid half its own capabilities
 * would teach the harder lesson at the wrong moment, and the reader who needs
 * the restricted example can find one that is about restriction rather than
 * about shopping.
 */

export interface ToolDefinition {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema?: Record<string, unknown> | undefined;
	readonly consequential: boolean;
}

/**
 * A product, and the price an agent is told about.
 *
 * Prices are integer minor units (pence, cents) rather than floats. A float
 * price is a rounding bug waiting for a tax rule, and the value crosses into an
 * agent's context as a number.
 */
export interface Product {
	readonly sku: string;
	readonly name: string;
	readonly price: number;
	readonly currency: string;
	readonly summary: string;
}

export interface CartLine {
	readonly sku: string;
	readonly quantity: number;
}

export interface Cart {
	readonly lines: ReadonlyArray<CartLine>;
	readonly coupon: string | null;
	readonly subtotal: number;
	readonly discount: number;
	readonly total: number;
}

export const PRODUCTS: readonly Product[] = [
	{
		sku: "AX-MUG-001",
		name: "Enamel Mug",
		price: 1200,
		currency: "GBP",
		summary: "A 350ml mug with a black rim, dishwasher safe.",
	},
	{
		sku: "AX-TEE-002",
		name: "Cotton T-Shirt",
		price: 2400,
		currency: "GBP",
		summary: "Mid-weight cotton, cut for everyday wear.",
	},
	{
		sku: "AX-HOOD-003",
		name: "Fleece Hoodie",
		price: 5800,
		currency: "GBP",
		summary: "Brushed fleece with a lined hood and a kangaroo pocket.",
	},
	{
		sku: "AX-CAP-004",
		name: "Six-Panel Cap",
		price: 1900,
		currency: "GBP",
		summary: "Cotton twill with a brass adjuster and a woven label.",
	},
	{
		sku: "AX-SOCK-005",
		name: "Merino Socks, Three Pack",
		price: 3200,
		currency: "GBP",
		summary: "Three pairs in a merino blend, sized UK 7 to 11.",
	},
	{
		sku: "AX-BAG-006",
		name: "Canvas Shoulder Bag",
		price: 6400,
		currency: "GBP",
		summary: "Waxed canvas with a leather strap and an inner pocket.",
	},
];

/** The catalogue tool. `maxPrice` is optional, and absence means no bound. */
const SEARCH: ToolDefinition = {
	name: "search_products",
	title: "Search products",
	description:
		"Find products by name or description. Pass maxPrice to exclude anything more expensive; omit it for no price bound.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Text to match against product names and summaries.",
			},
			maxPrice: {
				type: "integer",
				description:
					"Optional upper bound in minor currency units. Omit for no bound.",
			},
		},
		required: ["query"],
	},
	consequential: false,
};

/** The cart read. Takes nothing, which is a real case rather than a degenerate one. */
const VIEW_CART: ToolDefinition = {
	name: "view_cart",
	title: "View cart",
	description:
		"Read the current cart: its lines, any coupon, and the subtotal, discount and total. Takes no arguments.",
	consequential: false,
};

/**
 * A cart mutation. Reversible, so not consequential — the reasoning is at the
 * top of this file and is the part worth copying.
 */
const ADD_TO_CART: ToolDefinition = {
	name: "add_to_cart",
	title: "Add to cart",
	description:
		"Add a quantity of one product to the cart. Reversible: the cart can be emptied, and nothing is charged.",
	inputSchema: {
		type: "object",
		properties: {
			sku: {
				type: "string",
				description: "The product's SKU, as reported by search_products.",
			},
			quantity: {
				type: "integer",
				description: "How many to add. Must be at least 1.",
			},
		},
		required: ["sku", "quantity"],
	},
	consequential: false,
};

/** A cart mutation, and the second deliberate non-consequential annotation. */
const APPLY_COUPON: ToolDefinition = {
	name: "apply_coupon_code",
	title: "Apply coupon code",
	description:
		"Apply a discount code to the cart. Reversible and costs nothing; an invalid code is rejected without changing the cart.",
	inputSchema: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description: "The discount code, case-insensitive.",
			},
		},
		required: ["code"],
	},
	consequential: false,
};

/** The only consequential tool in this project, because it is the only irreversible one. */
const CHECKOUT: ToolDefinition = {
	name: "proceed_to_checkout",
	title: "Proceed to checkout",
	description:
		"Place the order and pay. This spends money and cannot be undone, which is why it is annotated consequential and the other four are not.",
	consequential: true,
};

/** The five tools, in the order they are registered and therefore listed. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	SEARCH,
	VIEW_CART,
	ADD_TO_CART,
	APPLY_COUPON,
	CHECKOUT,
];

/** The names an agent will see, in listing order. Used by the tests. */
export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map(
	(tool) => tool.name,
);
