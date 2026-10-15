import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dineout } from "./api.ts";
import { saveSession } from "./auth.ts";
let dir: string, old: string | undefined;
beforeEach(() => {
	old = process.env.DINEOUT_CONFIG_DIR;
	dir = mkdtempSync(join(tmpdir(), "dineout-api-"));
	process.env.DINEOUT_CONFIG_DIR = dir;
	saveSession({
		idToken: "fixture-token",
		refreshToken: "fixture-refresh",
		apiKey: "fixture-public-key",
		expiresAt: Date.now() + 3600000,
	});
});
afterEach(() => {
	if (old === undefined) delete process.env.DINEOUT_CONFIG_DIR;
	else process.env.DINEOUT_CONFIG_DIR = old;
	rmSync(dir, { recursive: true, force: true });
});
function fixture(
	handler: (url: string, init: any) => Response | Promise<Response>,
) {
	return new Dineout((async (url: any, init: any) =>
		handler(String(url), init)) as unknown as typeof fetch);
}
const completeInput = {
	guid: "fixture-guid",
	bookingName: "Fixture Customer",
	bookingPhone: "+3540000000",
	bookingEmail: "fixture@example.invalid",
	acceptTerms: true,
};
test("catalog merges duplicate restaurants and supports city/category search", async () => {
	const api = fixture(() =>
		Response.json({
			taHeroRestaurants: [{ id: 1, name: "Fixture" }],
			categoriesWithRestaurants: [
				{
					name: "Brunch",
					restaurants: [{ id: 1, name: "Fixture", cityName: "Example City" }],
				},
			],
		}),
	);
	const r = await api.restaurants({ query: "example", category: "brunch" });
	expect(r.count).toBe(1);
	expect(r.restaurants[0]!.categories).toEqual(["Brunch"]);
});
test("availability validates dates and guests before transport", async () => {
	let count = 0;
	const api = fixture(() => {
		count++;
		return Response.json([]);
	});
	await expect(
		api.availability({
			restaurantId: 1,
			dateTime: "2026-02-30T19:00",
			guests: 2,
		}),
	).rejects.toThrow();
	await expect(
		api.availability({
			restaurantId: 1,
			dateTime: "2026-10-17T19:00",
			guests: 0,
		}),
	).rejects.toThrow();
	expect(count).toBe(0);
});
test("all writes default to dry-run and never contact transport", async () => {
	let count = 0;
	const api = fixture(() => {
		count++;
		throw Error("Should not execute");
	});
	expect(
		(
			await api.reserve({
				restaurantId: 1,
				dateTime: "2099-01-01T19:00",
				guests: 2,
			})
		).dryRun,
	).toBe(true);
	expect((await api.complete(completeInput)).dryRun).toBe(true);
	expect((await api.cancel("fixture-guid")).dryRun).toBe(true);
	expect((await api.resendVerification("fixture-guid")).dryRun).toBe(true);
	expect(count).toBe(0);
});
test("hold plan preserves explicit event/menu/waitlist choices and cannot inject query parameters", () => {
	const api = new Dineout();
	const p = api.reservePlan({
		restaurantId: 1,
		dateTime: "2099-01-01T19:00",
		guests: 2,
		eventId: 7,
		menus: [{ menuId: 3, count: 2 }],
		waitingList: true,
	});
	const u = new URL(p.url);
	expect(u.origin).toBe("https://bookings.dineout.is");
	expect(u.searchParams.get("menuSelection")).toBe("3;2");
	expect(u.searchParams.get("isWaitingList")).toBe("true");
});
test("completion rejects card-required or unknown requirements before writing", async () => {
	for (const data of [
		{ paymentRequirements: { totalNoShow: 100, totalPrepaid: 0 } },
		{ paymentRequirements: { totalNoShow: 0, totalPrepaid: 200 } },
		{},
	]) {
		let writes = 0;
		const api = fixture((_url, init) => {
			if (init.method !== "GET") writes++;
			return Response.json(data);
		});
		await expect(api.complete(completeInput, true)).rejects.toThrow();
		expect(writes).toBe(0);
	}
});
test("no-payment completion preflights and writes only approved fields once", async () => {
	const calls: any[] = [];
	const api = fixture((url, init) => {
		calls.push({ url, init });
		if (init.method === "GET")
			return Response.json({
				paymentRequirements: { totalNoShow: 0, totalPrepaid: 0 },
			});
		return Response.json({ success: true });
	});
	expect(await api.complete(completeInput, true)).toEqual({ success: true });
	expect(calls).toHaveLength(2);
	const body = JSON.parse(calls[1].init.body);
	expect(body.acceptTerms).toBeUndefined();
	expect(body.allowSMSMarketing).toBe(false);
	expect(calls[1].url).toEndWith("/web/booking/complete/v2");
});
test("completion rejects unsupported card fields and absent terms acceptance", async () => {
	const api = new Dineout();
	await expect(
		api.complete({ ...completeInput, cardNumber: "fixture-card" }),
	).rejects.toThrow();
	await expect(
		api.complete({ ...completeInput, acceptTerms: false }),
	).rejects.toThrow();
});
test("cancellation requires positive eligibility and never retries failed writes", async () => {
	let writes = 0;
	const denied = fixture(() => Response.json(false));
	await expect(denied.cancel("fixture-guid", true)).rejects.toThrow(
		"not explicitly allowed",
	);
	const failing = fixture((_url, init) => {
		if (init.method === "GET") return Response.json(true);
		writes++;
		throw Error("fixture-disconnect");
	});
	await expect(failing.cancel("fixture-guid", true)).rejects.toThrow(
		"No write was automatically retried",
	);
	expect(writes).toBe(1);
});
