/**
 * The storefront's state, and the logic behind each tool.
 *
 * Deliberately framework-free and framework-independent: this is plain data and
 * plain functions, so the tool behaviour can be tested without a browser and a
 * renderer, and so the reference example does not demonstrate a React
 * particular as though it were part of the proposal.
 *
 * Everything here is ours. Nothing in this file is draft-defined, and the
 * distinction matters for a reference implementation: a reader should be able to
 * tell at a glance which lines are the specification's and which are a shop's.
 */

import type { Cart, Product } from "./tools";
import { PRODUCTS } from "./tools";

/**
 * Mutable store internals.
 *
 * Deliberately *not* readonly. The draft of this project's own standards says
 * "zero `any`" and prefers immutable shapes for values that cross a boundary —
 * but this state never crosses one: it is read by the tool handlers in this file
 * and rendered by the page, and nothing outside mutates it. Declaring a
 * `ReadonlyMap` and then calling `.set()` on it would either not typecheck or,
 * worse, typecheck via a cast that hides the mutation. The type describes what
 * is true, which is that these are the store's own fields.
 */
interface StoreState {
	lines: Map<string, number>;
	coupon: string | null;
	/** Orders already placed. An example that cannot show a receipt cannot show why checkout is irreversible. */
	placedOrders: Array<{ orderId: string }>;
}

/**
 * A fresh, empty shop.
 *
 * Module-level because a page has one storefront, and because the point of the
 * cart is that state survives between tool calls — an agent that reads the cart
 * and then adds to it expects the second call to see the first one's work.
 */
export const state: StoreState = {
	lines: new Map(),
	coupon: null,
	placedOrders: [],
};

/**
 * Discount codes this shop honours.
 *
 * A percentage and a flat amount, so the arithmetic is exercised in both
 * directions. Written as an explicit kind rather than the numeric-over-100
 * convention it started as: "a number above 100 means ten percent" reads as a
 * magic constant and is wrong the first time someone adds a coupon worth more
 * than a pound.
 */
interface Coupon {
	readonly kind: "percent" | "flat";
	/** A whole percentage, or minor units for a flat discount. */
	readonly value: number;
}

/** An example cannot demonstrate rejection without a code to reject. */
const COUPONS: Readonly<Record<string, Coupon>> = {
	AXKIT10: { kind: "percent", value: 10 },
	WELCOME5: { kind: "flat", value: 500 },
};

function product(sku: string): Product {
	const found = PRODUCTS.find((entry) => entry.sku === sku);
	if (found === undefined) {
		throw new Error(`no product with SKU ${sku}`);
	}
	return found;
}

function quantityOf(sku: string): number {
	return state.lines.get(sku) ?? 0;
}

/** Prices are integer minor units, so summing them is exact. */
function subtotalOf(): number {
	let total = 0;
	for (const [sku, quantity] of state.lines) {
		total += product(sku).price * quantity;
	}
	return total;
}

function discountOf(subtotal: number): number {
	if (state.coupon === null) {
		return 0;
	}
	const coupon = COUPONS[state.coupon];
	if (coupon === undefined) {
		return 0;
	}
	// Neither kind can take a shopper below zero: a percentage is clamped at the
	// subtotal, and a flat discount at the subtotal too. One clamp in one place,
	// rather than one per kind that can drift apart.
	const raw =
		coupon.kind === "percent"
			? Math.round((subtotal * coupon.value) / 100)
			: coupon.value;
	return Math.min(raw, subtotal);
}

/**
 * The cart read's result.
 *
 * A named function rather than a bare `currentCart` alias so the tools table
 * reads as five named operations rather than five implementation details.
 */
export function viewCartResult(): Cart {
	return currentCart();
}

export function currentCart(): Cart {
	const subtotal = subtotalOf();
	const discount = discountOf(subtotal);
	return {
		lines: [...state.lines].map(([sku, quantity]) => ({ sku, quantity })),
		coupon: state.coupon,
		subtotal,
		discount,
		total: Math.max(0, subtotal - discount),
	};
}

export interface SearchInput {
	readonly query: string;
	readonly maxPrice?: number | undefined;
}

/**
 * Match on name and summary, case-insensitively, and rank exact and prefix
 * matches first so a search for "mug" does not return the hoodie.
 *
 * `maxPrice` is a bound, not a filter on the match text, so combining the two
 * narrows rather than replaces.
 */
export function searchProducts(input: SearchInput): Product[] {
	const needle = input.query.trim().toLowerCase();
	const bound = input.maxPrice ?? Number.POSITIVE_INFINITY;
	const scored = PRODUCTS.filter((entry) => entry.price <= bound)
		.filter(
			(entry) =>
				needle === "" ||
				entry.name.toLowerCase().includes(needle) ||
				entry.summary.toLowerCase().includes(needle) ||
				entry.sku.toLowerCase() === needle,
		)
		.map((entry) => {
			const name = entry.name.toLowerCase();
			let score = 1;
			if (name === needle || entry.sku.toLowerCase() === needle) {
				score = 0;
			} else if (name.startsWith(needle)) {
				score = 1;
			}
			return { entry, score };
		})
		.sort((first, second) =>
			first.score === second.score
				? first.entry.name.localeCompare(second.entry.name)
				: first.score - second.score,
		);
	return scored.map((scored_) => scored_.entry);
}

export function addToCart(input: { sku: string; quantity: number }): Cart {
	// The schema has already refused a non-integer or a value below 1 by the
	// time this runs, so these checks are the handler's own contract rather than
	// a second validation layer. A handler that trusts its schema entirely is a
	// handler that breaks when the schema and the call site disagree.
	if (!Number.isInteger(input.quantity) || input.quantity < 1) {
		throw new Error("quantity must be a whole number of at least 1");
	}
	const target = product(input.sku);
	state.lines.set(target.sku, quantityOf(target.sku) + input.quantity);
	return currentCart();
}

export function applyCouponCode(input: { code: string }): Cart {
	const code = input.code.trim().toUpperCase();
	if (Object.hasOwn(COUPONS, code) === false) {
		// Rejected without touching the cart. A bad code that silently empties
		// the discount would be the more surprising behaviour.
		throw new Error(`no coupon with code ${code}`);
	}
	state.coupon = code;
	return currentCart();
}

/**
 * Place the order. Returns an order identifier and empties the cart.
 *
 * The order is recorded rather than discarded, because an example whose checkout
 * returns nothing gives a reader no way to see that the action was irreversible
 * — which is the entire justification for annotating this one and not the
 * other four.
 */
export function proceedToCheckout(): { orderId: string; total: number } {
	const cart = currentCart();
	if (cart.lines.length === 0) {
		throw new Error("the cart is empty");
	}
	const orderId = `AX-${String(state.placedOrders.length + 1).padStart(4, "0")}`;
	state.placedOrders.push({ orderId });
	state.lines.clear();
	state.coupon = null;
	return { orderId, total: cart.total };
}

/**
 * Put the shop back to its opening state.
 *
 * Exists for the tests and for the browser harness, which drives the same
 * surface more than once. It is not a tool and is not exposed as one — a
 * "reset" an agent can call is not something a real shop publishes.
 */
export function resetStore(): void {
	state.lines.clear();
	state.coupon = null;
	state.placedOrders.length = 0;
}
