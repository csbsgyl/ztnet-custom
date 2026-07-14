import { z } from "zod";
import { passwordSchema } from "~/server/api/routers/_schema";
import { normalizeEmail } from "~/utils/email";

// Input validation schema
export const createUserSchema = z.object({
	email: z.string().email().transform(normalizeEmail),
	password: passwordSchema("password does not meet the requirements!"),
	name: z.string().min(3, "Name must contain at least 3 character(s)").max(40),
	expiresAt: z.string().datetime().optional(),
	generateApiToken: z.boolean().optional(),
});
