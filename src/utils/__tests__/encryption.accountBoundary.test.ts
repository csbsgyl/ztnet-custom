jest.mock("~/server/db", () => ({
	prisma: {
		aPIToken: { findUnique: jest.fn() },
		user: { findUnique: jest.fn() },
	},
}));

import { prisma } from "~/server/db";
import { AuthorizationType } from "~/types/apiTypes";
import {
	API_TOKEN_SECRET,
	decryptAndVerifyToken,
	encrypt,
	generateInstanceSecret,
} from "~/utils/encryption";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const tokenLookup = prisma.aPIToken.findUnique as jest.Mock;
const userLookup = prisma.user.findUnique as jest.Mock;

const activeUser = {
	id: "user-1",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

function createApiKey(): string {
	return encrypt(
		JSON.stringify({
			userId: "user-1",
			name: "test-token",
			tokenId: "token-1",
			apiAuthorizationType: [AuthorizationType.PERSONAL],
		}),
		generateInstanceSecret(API_TOKEN_SECRET),
	);
}

function arrangeValidToken(
	apiKey: string,
	tokenOverrides: Record<string, unknown> = {},
	userOverrides: Record<string, unknown> = {},
): void {
	tokenLookup.mockResolvedValue({
		token: apiKey,
		isActive: true,
		expiresAt: new Date("2026-07-15T12:00:00.000Z"),
		...tokenOverrides,
	});
	userLookup.mockResolvedValue({ ...activeUser, ...userOverrides });
}

function verify(apiKey: string, requireAdmin = false) {
	return decryptAndVerifyToken({
		apiKey,
		requireAdmin,
		apiAuthorizationType: AuthorizationType.PERSONAL,
	});
}

describe("API token account boundary", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("accepts an active token owned by an active user", async () => {
		const apiKey = createApiKey();
		arrangeValidToken(apiKey);

		await expect(verify(apiKey)).resolves.toMatchObject({
			userId: "user-1",
			tokenId: "token-1",
		});
	});

	it.each([
		["inactive token", { isActive: false }],
		["token expiring now", { expiresAt: NOW }],
	])("rejects an %s", async (_name, tokenOverrides) => {
		const apiKey = createApiKey();
		arrangeValidToken(apiKey, tokenOverrides);

		await expect(verify(apiKey)).rejects.toThrow("Invalid token");
		expect(userLookup).not.toHaveBeenCalled();
	});

	it.each([
		["inactive account", { isActive: false }],
		["subscription-expired account", { suspensionReason: "SUBSCRIPTION_EXPIRED" }],
		["account expiring now", { expiresAt: NOW }],
	])("rejects an active token for an %s", async (_name, userOverrides) => {
		const apiKey = createApiKey();
		arrangeValidToken(apiKey, {}, userOverrides);

		await expect(verify(apiKey)).rejects.toThrow("Invalid token");
	});

	it("allows an administrator account but still requires an active token", async () => {
		const apiKey = createApiKey();
		arrangeValidToken(
			apiKey,
			{},
			{
				role: "ADMIN",
				isActive: false,
				suspensionReason: "SUBSCRIPTION_EXPIRED",
				expiresAt: new Date("2020-01-01T00:00:00.000Z"),
			},
		);

		await expect(verify(apiKey, true)).resolves.toMatchObject({ userId: "user-1" });

		tokenLookup.mockResolvedValue({ token: apiKey, isActive: false, expiresAt: null });
		await expect(verify(apiKey, true)).rejects.toThrow("Invalid token");
	});
});
