import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
	configDir,
	webOrigin,
	saveSession,
	safeError,
	loadSession,
} from "./auth.ts";
import { holdSchema } from "./schemas.ts";
const cdp = process.argv[3] ?? "http://127.0.0.1:9335";
const options = JSON.parse(readFileSync(0, "utf8"));
async function connect(start = false) {
	const u = new URL(cdp);
	if (
		u.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
		!u.port
	)
		throw Error("CDP must be a loopback HTTP endpoint with a port.");
	try {
		return await chromium.connectOverCDP(cdp, { timeout: 2000 });
	} catch {
		if (!start)
			throw Error("No pending login browser. Run dineout login start first.");
	}
	let configured: string | undefined, configuredProfile: string | undefined;
	try {
		const cfg = JSON.parse(
			readFileSync(join(configDir(), "browser.json"), "utf8"),
		);
		configured = cfg.executablePath;
		configuredProfile = cfg.profilePath;
	} catch {}
	const executable =
		process.env.DINEOUT_CHROME ??
		configured ??
		["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
	if (!executable)
		throw Error(
			"Set DINEOUT_CHROME to an installed Chrome/Chromium executable.",
		);
	const profile = configuredProfile ?? join(configDir(), "browser-profile");
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	chmodSync(profile, 0o700);
	const child = spawn(
		executable,
		[
			...(options.headed ? [] : ["--headless"]),
			"--no-sandbox",
			`--remote-debugging-port=${u.port}`,
			`--user-data-dir=${profile}`,
			webOrigin + "/login",
		],
		{ detached: true, stdio: "ignore" },
	);
	let error: Error | undefined;
	child.on("error", (e) => {
		error = e;
	});
	child.unref();
	for (let i = 0; i < 30; i++) {
		if (error) throw error;
		await new Promise((r) => setTimeout(r, 200));
		try {
			return await chromium.connectOverCDP(cdp, { timeout: 1000 });
		} catch {}
	}
	throw Error("Could not launch login browser.");
}
async function main() {
	const action = process.argv[2];
	if (action === "verify" && !/^\d{6}$/.test(options.code ?? ""))
		throw Error("Expected a six-digit SMS code.");
	if (action === "start" && !/^\+\d{8,15}$/.test(options.phone ?? ""))
		throw Error(
			'Supply a mobile number with country code, e.g. through --phone "$DINEOUT_PHONE".',
		);
	const b = await connect(action === "start" || action === "reserve");
	try {
		if (action === "close") {
			const c = await b.newBrowserCDPSession();
			await c.send("Browser.close");
			return { closed: true };
		}
		const context = b.contexts()[0];
		if (!context) throw Error("No browser context");
		const p =
			context.pages().find((p) => p.url().startsWith(webOrigin)) ??
			(await context.newPage());
		if (action === "reserve") {
			const a = holdSchema.parse(options.input);
			await p.goto(webOrigin + "/login", { waitUntil: "domcontentloaded" });
			const token = loadSession().idToken;
			let expectedUid: string;
			try {
				expectedUid = JSON.parse(
					Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
				).sub;
			} catch {
				throw Error("Saved authentication identity is invalid.");
			}
			if (!expectedUid)
				throw Error("Saved authentication identity is unavailable.");
			const sameUser = await p.evaluate(async (uid) => {
				if (
					!(await indexedDB.databases()).some(
						(d) => d.name === "firebaseLocalStorageDb",
					)
				)
					return false;
				const db = await new Promise<IDBDatabase>((r, j) => {
					const q = indexedDB.open("firebaseLocalStorageDb");
					q.onsuccess = () => r(q.result);
					q.onerror = () => j(q.error);
				});
				try {
					if (!db.objectStoreNames.contains("firebaseLocalStorage"))
						return false;
					const rows = await new Promise<any[]>((r, j) => {
						const q = db
							.transaction("firebaseLocalStorage", "readonly")
							.objectStore("firebaseLocalStorage")
							.getAll();
						q.onsuccess = () => r(q.result);
						q.onerror = () => j(q.error);
					});
					return rows.some(
						(x) =>
							x.fbase_key?.startsWith("firebase:authUser:") &&
							x.value?.uid === uid &&
							!x.value.isAnonymous,
					);
				} finally {
					db.close();
				}
			}, expectedUid);
			if (!sameUser)
				throw Error(
					"The browser is not logged in as the saved customer. Complete CLI browser login before creating a hold.",
				);
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
			const plan = { url: webOrigin + "/book/reserve?" + query };
			const responsePromise = p.waitForResponse(
				(r) => {
					const u = new URL(r.url());
					return (
						u.origin === "https://api.dineout.is" &&
						u.pathname.replace(/\/$/, "") === "/api/web/booking/reserve" &&
						r.request().method() === "POST"
					);
				},
				{ timeout: 30000 },
			);
			responsePromise.catch(() => {});
			await p.goto(plan.url, { waitUntil: "domcontentloaded" });
			let response;
			try {
				response = await responsePromise;
			} catch {
				throw Error(
					"No reservation response observed; inspect bookings before retrying. A browser challenge may need interaction.",
				);
			}
			const data = await response.json();
			if (!response.ok() || !data?.success || !data.guid)
				throw Error(
					"Dineout did not confirm a temporary hold. Do not automatically retry.",
				);
			return {
				holdCreated: true,
				bookingConfirmed: false,
				result: data,
				next: "Read checkout requirements, then explicitly complete the booking.",
			};
		}
		if (action === "start") {
			await p.goto(webOrigin + "/login", { waitUntil: "domcontentloaded" });
			await p.locator("input[type=tel]").fill(options.phone);
			await p.locator("#submit-btn").click();
			await p
				.getByPlaceholder("SMS code")
				.waitFor({ state: "visible", timeout: 25000 })
				.catch(() => {});
			if (!(await p.getByPlaceholder("SMS code").isVisible()))
				throw Error(
					"Login did not advance to SMS verification; complete any interactive challenge in a headed browser. No automatic retry was made.",
				);
			return {
				codeRequested: true,
				codeLength: 6,
				next: "dineout login verify --stdin",
			};
		}
		if (action !== "verify") throw Error("Unknown browser action");
		const responsePromise = p.waitForResponse(
			(r) => {
				const u = new URL(r.url());
				return (
					u.hostname === "identitytoolkit.googleapis.com" &&
					u.pathname === "/v1/accounts:signInWithPhoneNumber"
				);
			},
			{ timeout: 30000 },
		);
		await p.getByPlaceholder("SMS code").fill(options.code);
		await p.locator("#confirm-btn").click();
		const response = await responsePromise;
		const data = await response.json();
		if (!response.ok() || !data.idToken || !data.refreshToken)
			throw Error(
				"SMS verification failed; check the latest code. No request was retried.",
			);
		const apiKey = new URL(response.url()).searchParams.get("key");
		if (!apiKey) throw Error("Firebase configuration unavailable.");
		saveSession({
			idToken: data.idToken,
			refreshToken: data.refreshToken,
			expiresAt: Date.now() + Number(data.expiresIn) * 1000,
			apiKey,
		});
		return { authenticated: true, method: "browser-assisted" };
	} finally {
		await b.close().catch(() => {});
	}
}
if (import.meta.main)
	main()
		.then((x) => console.log(JSON.stringify(x)))
		.catch((e) => {
			console.error(JSON.stringify({ error: safeError(e) }));
			process.exitCode = 1;
		});
