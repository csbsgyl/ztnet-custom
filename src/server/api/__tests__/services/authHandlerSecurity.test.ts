import { makeSignature } from "better-auth/crypto";
import { auth } from "~/lib/auth";

const TOKEN = "handler-security-session-token";
const USER_ID = "handler-security-user";

async function authenticatedHeaders(): Promise<Headers> {
	const context = await auth.$context;
	const signature = await makeSignature(TOKEN, context.secret);
	const headers = new Headers({
		cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(
			`${TOKEN}.${signature}`,
		)}`,
		origin: new URL(context.baseURL).origin,
	});
	return headers;
}

function sessionWithSensitiveUserFields() {
	const now = new Date();
	return {
		session: {
			id: "handler-security-session",
			token: TOKEN,
			userId: USER_ID,
			createdAt: now,
			updatedAt: now,
			expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
			ipAddress: "127.0.0.1",
			userAgent: "security-test",
		},
		user: {
			id: USER_ID,
			name: "Normal User",
			email: "normal@example.com",
			emailVerified: true,
			image: null,
			createdAt: now,
			updatedAt: now,
			role: "USER",
			hash: "password-hash-must-not-leak",
			tempPassword: "temporary-password-must-not-leak",
			twoFactorSecret: "mfa-secret-must-not-leak",
			failedLoginAttempts: 3,
			isActive: true,
		},
	};
}

describe("Better Auth HTTP security boundaries", () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("rejects server-managed fields on /update-user before the adapter writes", async () => {
		const context = await auth.$context;
		jest
			.spyOn(context.internalAdapter, "findSession")
			.mockResolvedValue(sessionWithSensitiveUserFields() as never);
		const updateUser = jest
			.spyOn(context.internalAdapter, "updateUser")
			.mockResolvedValue(null);
		const headers = await authenticatedHeaders();
		headers.set("content-type", "application/json");

		const response = await auth.handler(
			new Request(`${context.baseURL}/update-user`, {
				method: "POST",
				headers,
				body: JSON.stringify({ role: "ADMIN", isActive: true, userGroupId: 1 }),
			}),
		);

		expect(response.status).toBe(400);
		expect(updateUser).not.toHaveBeenCalled();
	});

	it("keeps role but removes account secrets from /get-session", async () => {
		const context = await auth.$context;
		jest
			.spyOn(context.internalAdapter, "findSession")
			.mockResolvedValue(sessionWithSensitiveUserFields() as never);

		const response = await auth.handler(
			new Request(`${context.baseURL}/get-session`, {
				headers: await authenticatedHeaders(),
			}),
		);
		const payload = (await response.json()) as { user: Record<string, unknown> };

		expect(response.status).toBe(200);
		expect(payload.user.role).toBe("USER");
		expect(payload.user).not.toHaveProperty("hash");
		expect(payload.user).not.toHaveProperty("tempPassword");
		expect(payload.user).not.toHaveProperty("twoFactorSecret");
		expect(payload.user).not.toHaveProperty("failedLoginAttempts");
		expect(payload.user).not.toHaveProperty("isActive");
	});

	it("does not expose Better Auth's parallel email sign-up workflow", async () => {
		const context = await auth.$context;
		const createUser = jest.spyOn(context.internalAdapter, "createUser");

		const response = await auth.handler(
			new Request(`${context.baseURL}/sign-up/email`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: new URL(context.baseURL).origin,
				},
				body: JSON.stringify({
					name: "Bypass User",
					email: "bypass@example.com",
					password: "weakpass",
				}),
			}),
		);

		expect(response.status).toBe(403);
		expect(createUser).not.toHaveBeenCalled();
	});
});
