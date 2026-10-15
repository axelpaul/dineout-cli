import { apiOrigin, refreshSession } from "./auth.ts";
import {
	availabilitySchema,
	stepsSchema,
	holdSchema,
	completeSchema,
	guid,
	searchSchema,
} from "./schemas.ts";
export type Restaurant = {
	id: number;
	name: string;
	slug?: string;
	cityName?: string;
	cityNames?: string[];
	categories?: string[];
	[key: string]: unknown;
};
const enc = encodeURIComponent;
export class Dineout {
	constructor(private transport: typeof fetch = fetch) {}
	async request(
		path: string,
		options: { auth?: boolean; method?: string; body?: unknown } = {},
	) {
		if (!path.startsWith("/") || path.includes("://") || path.includes(".."))
			throw Error("Invalid API path");
		const headers: Record<string, string> = { Accept: "application/json" };
		if (options.auth)
			headers.Authorization =
				"Bearer " + (await refreshSession(false, this.transport)).idToken;
		if (options.body !== undefined)
			headers["Content-Type"] = "application/json";
		let response: Response;
		try {
			response = await this.transport(apiOrigin + path, {
				method: options.method ?? "GET",
				headers,
				body:
					options.body !== undefined ? JSON.stringify(options.body) : undefined,
				signal: AbortSignal.timeout(25000),
				redirect: "error",
			});
		} catch {
			throw Error(
				"Dineout request failed or timed out. No write was automatically retried; check its status before trying again.",
			);
		}
		const text = await response.text();
		let data: any;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			throw Error(`Invalid API response (HTTP ${response.status}).`);
		}
		if (!response.ok) throw Error(`Dineout API HTTP ${response.status}`);
		return data;
	}
	async restaurants(input: unknown = {}) {
		const args = searchSchema.parse(input);
		const home = await this.request("/app/home");
		const byId = new Map<number, Restaurant>();
		for (const r of home.taHeroRestaurants ?? []) byId.set(r.id, r);
		for (const category of home.categoriesWithRestaurants ?? [])
			for (const r of category.restaurants ?? []) {
				const prev = byId.get(r.id);
				byId.set(r.id, {
					...prev,
					...r,
					categories: [
						...new Set([
							...(prev?.categories ?? []),
							...(r.categories ?? []),
							category.name,
						]),
					],
				});
			}
		const restaurants = [...byId.values()]
			.filter((r) => {
				const haystack = [
					r.name,
					r.slug,
					r.cityName,
					...(r.cityNames ?? []),
					...(r.categories ?? []),
				]
					.join(" ")
					.toLowerCase();
				return (
					(!args.query || haystack.includes(args.query.toLowerCase())) &&
					(!args.category ||
						r.categories?.some((c) =>
							c.toLowerCase().includes(args.category!.toLowerCase()),
						))
				);
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		return { count: restaurants.length, restaurants };
	}
	async restaurant(idOrSlug: string) {
		const { restaurants } = await this.restaurants();
		const found = restaurants.find(
			(r) =>
				String(r.id) === idOrSlug ||
				r.slug?.toLowerCase() === idOrSlug.toLowerCase(),
		);
		if (!found) throw Error("Restaurant not found in public catalog.");
		return found;
	}
	async filters() {
		return this.request("/web/filter/inuse");
	}
	async availability(input: unknown) {
		const a = availabilitySchema.parse(input);
		const all = await this.request(
			`/web/suggestion/restaurant/${a.restaurantId}/${enc(a.dateTime)}/${a.guests}/all`,
		);
		return {
			...a,
			available: Array.isArray(all)
				? all.filter(
						(x) => x.isAvailable || x.isTableAvailable || x.isEventAvailable,
					)
				: [],
			all,
		};
	}
	async waitingTimes(input: unknown) {
		const a = availabilitySchema.parse(input);
		return this.request(
			`/web/suggestion/restaurant/${a.restaurantId}/${enc(a.dateTime)}/${a.guests}/waitinglisttimes/v2`,
		);
	}
	async steps(input: unknown) {
		const a = stepsSchema.parse(input);
		return this.request(
			`/web/booking/v4/processsteps/${a.restaurantId}/${a.eventId ?? "null"}/${a.waitingList}/${enc(a.dateTime)}`,
		);
	}
	async plan(input: unknown) {
		const a = availabilitySchema.parse(input);
		const results = await Promise.allSettled([
			this.restaurant(String(a.restaurantId)),
			this.availability(a),
			this.steps({ restaurantId: a.restaurantId, dateTime: a.dateTime }),
		]);
		const values = results.map((r) => {
			if (r.status === "rejected") throw r.reason;
			return r.value;
		});
		return {
			restaurant: values[0],
			requested: a,
			availability: values[1],
			bookingProcessSteps: values[2],
			bookingCreated: false,
			next: "reserve creates a temporary hold; complete finalizes it. Both require explicit confirmation.",
		};
	}
	async bookings() {
		return this.request("/app/booking", { auth: true });
	}
	async booking(bookingGuid: string) {
		return this.request(
			"/web/booking/bookinginfoforconfirmation/" + enc(guid.parse(bookingGuid)),
			{ auth: true },
		);
	}
	async checkout(bookingGuid: string, waitingList = false) {
		return this.request(
			`/web/booking/v3/bookinginfoforcomplete/${enc(guid.parse(bookingGuid))}/${waitingList}`,
			{ auth: true },
		);
	}
	async cancellationAllowed(bookingGuid: string) {
		return this.request(
			"/web/booking/iscancelallowed/" + enc(guid.parse(bookingGuid)),
			{ auth: true },
		);
	}
	reservePlan(input: unknown) {
		const a = holdSchema.parse(input);
		const query = new URLSearchParams({
			dateTime: a.dateTime,
			guests: String(a.guests),
			restaurantId: String(a.restaurantId),
			currentStep: "reserve",
			lng: "en",
		});
		if (a.eventId) query.set("eventId", String(a.eventId));
		if (a.menus.length)
			query.set(
				"menuSelection",
				a.menus.map((x) => `${x.menuId};${x.count}`).join(","),
			);
		if (a.waitingList) query.set("isWaitingList", "true");
		return {
			dryRun: true,
			action: "create-temporary-hold",
			requested: a,
			url: "https://bookings.dineout.is/book/reserve?" + query,
			requiresBrowser: true,
			bookingConfirmed: false,
		};
	}
	async reserve(input: unknown, confirm = false) {
		const plan = this.reservePlan(input);
		if (!confirm) return plan;
		await refreshSession(false, this.transport);
		const { browserAction } = await import("./browser-bridge.ts");
		return browserAction("reserve", { input: plan.requested });
	}
	async complete(input: unknown, confirm = false) {
		const args = completeSchema.parse(input);
		const { acceptTerms, ...body } = args;
		const plan = {
			dryRun: true,
			action: "complete-booking",
			method: "PUT",
			path: "/web/booking/complete/v2",
			body,
			termsAccepted: acceptTerms,
			requiresPaymentPreflight: true,
		};
		if (!confirm) return plan;
		const info = await this.checkout(args.guid, args.isWaitingList);
		const payment = info?.paymentRequirements;
		if (
			!payment ||
			typeof payment.totalNoShow !== "number" ||
			typeof payment.totalPrepaid !== "number"
		)
			throw Error(
				"Payment requirements are unknown; review and complete this booking in the website checkout.",
			);
		if (payment.totalNoShow !== 0 || payment.totalPrepaid !== 0)
			throw Error(
				"This booking requires a payment/card guarantee; complete it through the website checkout.",
			);
		return this.request(plan.path, { auth: true, method: "PUT", body });
	}
	async cancel(bookingGuid: string, confirm = false) {
		const id = guid.parse(bookingGuid);
		const plan = {
			dryRun: true,
			action: "cancel-booking",
			method: "PUT",
			path: "/web/booking/cancel/" + enc(id),
		};
		if (!confirm) return plan;
		const allowed = await this.cancellationAllowed(id);
		if (allowed !== true)
			throw Error(
				"Online cancellation is not explicitly allowed; contact the restaurant.",
			);
		return this.request(plan.path, { auth: true, method: "PUT", body: {} });
	}
	async resendVerification(bookingGuid: string, confirm = false) {
		const id = guid.parse(bookingGuid);
		const plan = {
			dryRun: true,
			action: "resend-booking-email-verification",
			method: "POST",
			path: "/web/booking/verification/resend",
			body: { guid: id },
		};
		if (!confirm) return plan;
		return this.request(plan.path, {
			auth: true,
			method: "POST",
			body: plan.body,
		});
	}
}
