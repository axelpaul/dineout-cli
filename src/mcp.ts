import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Dineout } from "./api.ts";
import { authDoctor, me, safeError } from "./auth.ts";
import {
	availabilitySchema,
	stepsSchema,
	holdSchema,
	completeSchema,
	guid,
	searchSchema,
} from "./schemas.ts";
export const toolNames = {
	read: [
		"dineout_doctor",
		"dineout_me",
		"dineout_restaurants",
		"dineout_restaurant",
		"dineout_filters",
		"dineout_availability",
		"dineout_waiting_times",
		"dineout_steps",
		"dineout_plan",
		"dineout_bookings",
		"dineout_booking",
		"dineout_checkout",
		"dineout_cancellation_allowed",
	],
	write: [
		"dineout_reserve",
		"dineout_complete",
		"dineout_cancel",
		"dineout_resend_verification",
	],
};
export function makeServer(allowWrites = false, api = new Dineout()) {
	const server = new McpServer({ name: "dineout", version: "0.2.0" });
	const annotations = {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: true,
	};
	const wrap = (fn: (args: any) => unknown) => async (args: any) => {
		try {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(await fn(args), null, 2),
					},
				],
			};
		} catch (e) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: safeError(e) }),
					},
				],
			};
		}
	};
	const read = (
		name: string,
		description: string,
		schema: z.ZodObject<any>,
		fn: (a: any) => unknown,
	) =>
		server.registerTool(
			name,
			{ description, inputSchema: schema, annotations },
			wrap(fn),
		);
	read(
		"dineout_doctor",
		"Refresh saved session and check the authenticated customer endpoint. No credentials returned.",
		z.object({}),
		() => authDoctor(),
	);
	read("dineout_me", "Read authenticated customer details.", z.object({}), () =>
		me(),
	);
	read(
		"dineout_restaurants",
		"Search restaurants from the public catalog.",
		searchSchema,
		(a) => api.restaurants(a),
	);
	read(
		"dineout_restaurant",
		"Find a restaurant by ID or slug.",
		z.object({ idOrSlug: z.string().min(1) }),
		(a) => api.restaurant(a.idOrSlug),
	);
	read(
		"dineout_filters",
		"Read available restaurant filters.",
		z.object({}),
		() => api.filters(),
	);
	read(
		"dineout_availability",
		"Read available times. Date/time uses Iceland local time, YYYY-MM-DDTHH:mm.",
		availabilitySchema,
		(a) => api.availability(a),
	);
	read(
		"dineout_waiting_times",
		"Read waiting-list times; does not join a waiting list.",
		availabilitySchema,
		(a) => api.waitingTimes(a),
	);
	read(
		"dineout_steps",
		"Read booking requirements and process steps without creating a hold.",
		stepsSchema,
		(a) => api.steps(a),
	);
	read(
		"dineout_plan",
		"Combine restaurant, available times and requirements. Does not create a hold.",
		availabilitySchema,
		(a) => api.plan(a),
	);
	read(
		"dineout_bookings",
		"Read upcoming and past bookings visible to the saved session.",
		z.object({}),
		() => api.bookings(),
	);
	read(
		"dineout_booking",
		"Read booking confirmation details by private booking GUID.",
		z.object({ guid }),
		(a) => api.booking(a.guid),
	);
	read(
		"dineout_checkout",
		"Read hold checkout details and payment requirements without completing the booking.",
		z.object({ guid, waitingList: z.boolean().default(false) }),
		(a) => api.checkout(a.guid, a.waitingList),
	);
	read(
		"dineout_cancellation_allowed",
		"Read whether online cancellation is allowed.",
		z.object({ guid }),
		(a) => api.cancellationAllowed(a.guid),
	);
	if (allowWrites) {
		const write = (
			name: string,
			description: string,
			schema: z.ZodObject<any>,
			fn: (a: any) => unknown,
		) =>
			server.registerTool(
				name,
				{
					description,
					inputSchema: schema,
					annotations: {
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: false,
						openWorldHint: true,
					},
				},
				wrap(fn),
			);
		write(
			"dineout_reserve",
			"Create a temporary hold through the normal browser/reCAPTCHA flow ONLY after explicit approval of restaurant, date/time and guests. Dry-run unless confirm=true; a hold is not a completed booking.",
			holdSchema.extend({ confirm: z.boolean().default(false) }),
			(a) => {
				const { confirm, ...input } = a;
				return api.reserve(input, confirm);
			},
		);
		write(
			"dineout_complete",
			"Complete an approved no-payment booking/hold. Requires acceptTerms=true. Dry-run unless confirm=true. Refuses card-required or unknown payment requirements; use website checkout for these.",
			completeSchema.extend({ confirm: z.boolean().default(false) }),
			(a) => {
				const { confirm, ...input } = a;
				return api.complete(input, confirm);
			},
		);
		write(
			"dineout_cancel",
			"Cancel an approved booking. Dry-run unless confirm=true; checks cancellation eligibility before writing.",
			z.object({ guid, confirm: z.boolean().default(false) }),
			(a) => api.cancel(a.guid, a.confirm),
		);
		write(
			"dineout_resend_verification",
			"Request another booking-completion email code after user approval. Dry-run unless confirm=true.",
			z.object({ guid, confirm: z.boolean().default(false) }),
			(a) => api.resendVerification(a.guid, a.confirm),
		);
	}
	return server;
}
export async function startMcp(allowWrites = false) {
	await makeServer(allowWrites).connect(new StdioServerTransport());
}
