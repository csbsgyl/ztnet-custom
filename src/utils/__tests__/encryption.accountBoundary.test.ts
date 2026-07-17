jest.mock("~/server/db", () => ({
	prisma: {
		aPIToken: {
			findUnique: jest.fn(),
			findMany: jest.fn(),
			update: jest.fn(),
			updateMany: jest.fn(),
		},
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
	hashApiToken,
	migrateLegacyApiTokenDigests,
} from "~/utils/encryption";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const tokenLookup = prisma.aPIToken.findUnique as jest.Mock;
const tokenUpdate = prisma.aPIToken.update as jest.Mock;
const tokenMigrationLookup = prisma.aPIToken.findMany as jest.Mock;
const tokenMigrationUpdate = prisma.aPIToken.updateMany as jest.Mock;
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
		token: hashApiToken(apiKey),
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
		tokenUpdate.mockResolvedValue({});
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

	it("migrates a valid legacy bearer-token row to a digest", async () => {
		const apiKey = createApiKey();
		arrangeValidToken(apiKey, { token: apiKey });

		await expect(verify(apiKey)).resolves.toBeTruthy();
		expect(tokenUpdate).toHaveBeenCalledWith({
			where: { id: "token-1" },
			data: { token: hashApiToken(apiKey) },
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

		tokenLookup.mockResolvedValue({
			token: hashApiToken(apiKey),
			isActive: false,
			expiresAt: null,
		});
		await expect(verify(apiKey, true)).rejects.toThrow("Invalid token");
	});
});

describe("legacy API token digest migration", () => {
	beforeEach(() => {
		tokenMigrationLookup.mockReset();
		tokenMigrationUpdate.mockReset();
	});

	it("hashes legacy values and skips rows that are already digests", async () => {
		const legacyToken = "legacy-iv:legacy-ciphertext";
		tokenMigrationLookup.mockResolvedValue([
			{ id: "token-1", token: legacyToken },
			{ id: "token-2", token: hashApiToken("already-migrated") },
		]);
		tokenMigrationUpdate.mockResolvedValue({ count: 1 });

		await expect(migrateLegacyApiTokenDigests()).resolves.toBe(1);

		expect(tokenMigrationUpdate).toHaveBeenCalledTimes(1);
		expect(tokenMigrationUpdate).toHaveBeenCalledWith({
			where: { id: "token-1", token: legacyToken },
			data: { token: hashApiToken(legacyToken) },
		});
	});

	it("paginates and does not overwrite a token changed by another request", async () => {
		const firstLegacy = "first-iv:first-ciphertext";
		const secondLegacy = "second-iv:second-ciphertext";
		tokenMigrationLookup
			.mockResolvedValueOnce([
				{ id: "token-1", token: firstLegacy },
				{ id: "token-2", token: hashApiToken("already-migrated") },
			])
			.mockResolvedValueOnce([{ id: "token-3", token: secondLegacy }]);
		tokenMigrationUpdate
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		await expect(migrateLegacyApiTokenDigests(prisma, 2)).resolves.toBe(1);

		expect(tokenMigrationLookup).toHaveBeenNthCalledWith(2, {
			cursor: { id: "token-2" },
			skip: 1,
			orderBy: { id: "asc" },
			take: 2,
			select: { id: true, token: true },
		});
		expect(tokenMigrationUpdate).toHaveBeenNthCalledWith(1, {
			where: { id: "token-1", token: firstLegacy },
			data: { token: hashApiToken(firstLegacy) },
		});
	});
});
