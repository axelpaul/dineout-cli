#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Dineout } from "./api.ts";
import { authDoctor, me, refreshSession, logout, safeError } from "./auth.ts";
const help = `Dineout CLI 0.2.0\n\nCommands:\n  restaurants [--query TEXT --category TEXT]\n  restaurant <id-or-slug>\n  filters\n  availability <restaurant-id> <YYYY-MM-DDTHH:mm> [guests]\n  waiting-times <restaurant-id> <YYYY-MM-DDTHH:mm> [guests]\n  steps <restaurant-id> <YYYY-MM-DDTHH:mm> [--event-id ID --waiting-list]\n  plan <restaurant-id> <YYYY-MM-DDTHH:mm> [guests]\n  bookings\n  booking <guid>\n  checkout <guid> [--waiting-list]\n  cancellation-allowed <guid>\n  reserve --file INPUT.json [--dry-run | --yes]\n  complete --file INPUT.json [--dry-run | --yes]\n  cancel <guid> [--dry-run | --yes]\n  resend-verification <guid> [--dry-run | --yes]\n  login start --phone <international-number> [--headed --cdp URL]\n  login verify --stdin [--cdp URL]\n  login refresh | login close | me | doctor | logout\n  mcp [--allow-writes]\n  schema | version\n\nAll output is JSON. Writes default to dry-run; --yes is required to execute.\nLogin and reserve use headless Chrome; completion requiring cards stays on the website.\n`;
export async function main(argv = process.argv.slice(2)) {
	const { values: v, positionals: p } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			"allow-writes": { type: "boolean" },
			yes: { type: "boolean" },
			"dry-run": { type: "boolean" },
			stdin: { type: "boolean" },
			headed: { type: "boolean" },
			file: { type: "string" },
			phone: { type: "string" },
			cdp: { type: "string" },
			query: { type: "string" },
			category: { type: "string" },
			"event-id": { type: "string" },
			"waiting-list": { type: "boolean" },
		},
	});
	const [command, arg, date, guests = "2"] = p;
	const api = new Dineout();
	let out: unknown;
	if (v.help || !command) {
		console.log(help);
		return;
	}
	if (v.yes && v["dry-run"])
		throw Error("Choose --yes or --dry-run, not both.");
	const confirmed = !!v.yes;
	const requireArg = () => {
		if (!arg) throw Error("Missing ID/GUID");
		return arg;
	};
	const input = () => {
		if (!v.file) throw Error("Supply --file INPUT.json");
		return JSON.parse(readFileSync(v.file, "utf8"));
	};
	const availability = () => ({
		restaurantId: Number(requireArg()),
		dateTime: date,
		guests: Number(guests),
	});
	switch (command) {
		case "version":
			out = { version: "0.2.0" };
			break;
		case "mcp": {
			const { startMcp } = await import("./mcp.ts");
			await startMcp(v["allow-writes"]);
			return;
		}
		case "restaurants":
			out = await api.restaurants({ query: v.query, category: v.category });
			break;
		case "restaurant":
			out = await api.restaurant(requireArg());
			break;
		case "filters":
			out = await api.filters();
			break;
		case "availability":
			out = await api.availability(availability());
			break;
		case "waiting-times":
			out = await api.waitingTimes(availability());
			break;
		case "steps":
			out = await api.steps({
				restaurantId: Number(requireArg()),
				dateTime: date,
				eventId: v["event-id"] ? Number(v["event-id"]) : undefined,
				waitingList: v["waiting-list"],
			});
			break;
		case "plan":
			out = await api.plan(availability());
			break;
		case "bookings":
			out = await api.bookings();
			break;
		case "booking":
			out = await api.booking(requireArg());
			break;
		case "checkout":
			out = await api.checkout(requireArg(), v["waiting-list"]);
			break;
		case "cancellation-allowed":
			out = await api.cancellationAllowed(requireArg());
			break;
		case "reserve":
			out = await api.reserve(input(), confirmed);
			break;
		case "complete":
			out = await api.complete(input(), confirmed);
			break;
		case "cancel":
			out = await api.cancel(requireArg(), confirmed);
			break;
		case "resend-verification":
			out = await api.resendVerification(requireArg(), confirmed);
			break;
		case "doctor":
			out = await authDoctor();
			break;
		case "me":
			out = await me();
			break;
		case "logout":
			out = logout();
			break;
		case "login":
			if (arg === "refresh") {
				await refreshSession(true);
				out = { authenticated: true, refreshed: true };
				break;
			}
			if (!["start", "verify", "close"].includes(arg ?? ""))
				throw Error("Expected login start, verify, refresh, or close");
			if (arg === "verify" && !v.stdin)
				throw Error("Pass the SMS code through --stdin");
			{
				const { browserAction } = await import("./browser-bridge.ts");
				out = await browserAction(arg!, {
					phone: v.phone,
					code: arg === "verify" ? readFileSync(0, "utf8").trim() : undefined,
					headed: v.headed,
					cdp: v.cdp,
				});
				if (arg === "verify")
					out = {
						...(out as Record<string, unknown>),
						verification: await authDoctor(),
					};
			}
			break;
		case "schema": {
			const { toolNames } = await import("./mcp.ts");
			out = {
				version: "0.2.0",
				mcp: toolNames,
				writes: {
					default: "dry-run",
					cliConfirmation: "--yes",
					mcpConfirmation: "--allow-writes and confirm:true",
					reserve: "temporary hold only; requires browser/reCAPTCHA",
					complete: "no-payment bookings only; acceptTerms:true required",
				},
				dateTime: "YYYY-MM-DDTHH:mm (Iceland local time)",
			};
			break;
		}
		default:
			throw Error(`Unknown command: ${command}`);
	}
	console.log(JSON.stringify(out, null, 2));
}
if (import.meta.main)
	main().catch((e) => {
		console.error(JSON.stringify({ error: safeError(e) }));
		process.exitCode = 1;
	});
