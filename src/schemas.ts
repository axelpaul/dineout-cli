import { z } from "zod";
export const restaurantId = z.coerce.number().int().positive();
export const dateTime = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:mm")
	.refine((s) => {
		try {
			return new Date(s + "Z").toISOString().slice(0, 16) === s;
		} catch {
			return false;
		}
	}, "Invalid date/time");
export const guid = z
	.string()
	.min(8)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
export const searchSchema = z
	.object({ query: z.string().optional(), category: z.string().optional() })
	.strict();
export const availabilitySchema = z
	.object({
		restaurantId,
		dateTime,
		guests: z.number().int().min(1).max(100).default(2),
	})
	.strict();
export const stepsSchema = z
	.object({
		restaurantId,
		dateTime,
		eventId: z.number().int().positive().optional(),
		waitingList: z.boolean().default(false),
	})
	.strict();
export const holdSchema = availabilitySchema
	.extend({
		eventId: z.number().int().positive().optional(),
		menus: z
			.array(
				z
					.object({
						menuId: z.number().int().positive(),
						count: z.number().int().min(1).max(100),
					})
					.strict(),
			)
			.default([]),
		waitingList: z.boolean().default(false),
	})
	.strict();
export const completeSchema = z
	.object({
		guid,
		bookingName: z.string().trim().min(1).max(200),
		bookingPhone: z.string().regex(/^\+?[\d ()-]{7,25}$/),
		phoneNumberRegion: z.string().length(2).default("IS"),
		bookingEmail: z.email(),
		bookingSpecialRequest: z.string().max(4000).default(""),
		allowSMSMarketing: z.boolean().default(false),
		allowRestaurantEmails: z.boolean().default(false),
		isWaitingList: z.boolean().default(false),
		bookingDietaryRestrictions: z.string().max(4000).default(""),
		hasAllergies: z.boolean().default(false),
		verificationCode: z.string().min(1).max(20).optional(),
		acceptTerms: z.literal(true),
	})
	.strict();
export type HoldInput = z.input<typeof holdSchema>;
