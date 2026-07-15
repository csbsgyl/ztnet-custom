import { generateKeyPairSync } from "node:crypto";
import type { Session } from "~/lib/authTypes";
import { billingAdminRouter } from "~/server/api/routers/billingAdminRouter";

const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "admin-1", role: "ADMIN" },
} as Session;

const adminAccount = {
	id: "admin-1",
	role: "ADMIN",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

function createHarness(current: Record<string, unknown> | null = null) {
	const upsert = jest.fn(async ({ update }: { update: Record<string, unknown> }) => ({
		id: 1,
		alipayEnabled: false,
		alipayAppId: null,
		alipaySellerId: null,
		alipayGateway: "https://openapi.alipay.com/gateway.do",
		alipayPrivateKeyEncrypted: null,
		alipayPublicKey: null,
		alipayFeeRateBps: 0,
		...current,
		...update,
	}));
	const activityCreate = jest.fn(async () => ({}));
	const transaction = {
		globalOptions: { upsert },
		activityLog: { create: activityCreate },
	};
	const prisma = {
		user: { findUnique: jest.fn(async () => adminAccount) },
		globalOptions: { findUnique: jest.fn(async () => current) },
		$transaction: jest.fn(async (operation) => operation(transaction)),
	};
	const caller = billingAdminRouter.createCaller({
		session,
		prisma,
		wss: null,
		res: null,
	} as never);
	return { caller, upsert, activityCreate };
}

function rsaCredentials() {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return {
		privateKey: keys.privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64"),
		alipayPublicKey: keys.publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64"),
	};
}

test("saves the three Alipay credentials and fee without requiring a seller ID", async () => {
	const harness = createHarness();
	const credentials = rsaCredentials();

	const result = await harness.caller.saveAlipayConfig({
		enabled: true,
		appId: "2026071500000001",
		gateway: "https://openapi.alipay.com/gateway.do",
		alipayPublicKey: credentials.alipayPublicKey,
		privateKey: credentials.privateKey,
		feeRateBps: 60,
	});

	expect(harness.upsert).toHaveBeenCalledWith(
		expect.objectContaining({
			update: expect.objectContaining({
				alipayEnabled: true,
				alipayAppId: "2026071500000001",
				alipayFeeRateBps: 60,
				alipayPublicKey: credentials.alipayPublicKey,
				alipayPrivateKeyEncrypted: expect.stringMatching(/^v1:/),
			}),
		}),
	);
	expect(harness.upsert.mock.calls[0]?.[0].update).toMatchObject({
		alipaySellerId: null,
	});
	expect(harness.activityCreate).toHaveBeenCalledTimes(1);
	expect(result).toMatchObject({
		enabled: true,
		feeRateBps: 60,
		hasPublicKey: true,
		hasPrivateKey: true,
	});
	expect(result).not.toHaveProperty("alipayPublicKey");
	expect(result).not.toHaveProperty("alipayPrivateKeyEncrypted");
});

test("keeps both stored Alipay keys when the key fields are left empty", async () => {
	const harness = createHarness({
		alipayEnabled: true,
		alipayAppId: "2026071500000001",
		alipayPublicKey: "stored-public-key",
		alipayPrivateKeyEncrypted: "v1:stored-private-key",
	});

	const result = await harness.caller.saveAlipayConfig({
		enabled: true,
		appId: "2026071500000001",
		gateway: "https://openapi.alipay.com/gateway.do",
		feeRateBps: 60,
	});

	const update = harness.upsert.mock.calls[0]?.[0].update;
	expect(update).not.toHaveProperty("alipayPublicKey");
	expect(update).not.toHaveProperty("alipayPrivateKeyEncrypted");
	expect(result).toMatchObject({ hasPublicKey: true, hasPrivateKey: true });
	expect(result).not.toHaveProperty("alipayPublicKey");
});

test("reports which Alipay key has an invalid format", async () => {
	const credentials = rsaCredentials();
	const harness = createHarness({ alipayPrivateKeyEncrypted: "v1:existing" });

	await expect(
		harness.caller.saveAlipayConfig({
			enabled: true,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			alipayPublicKey: "not-a-public-key",
			feeRateBps: 0,
		}),
	).rejects.toThrow("Alipay public key format is invalid");

	await expect(
		harness.caller.saveAlipayConfig({
			enabled: true,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			alipayPublicKey: credentials.alipayPublicKey,
			privateKey: "not-a-private-key",
			feeRateBps: 0,
		}),
	).rejects.toThrow("merchant application private key format is invalid");

	expect(harness.upsert).not.toHaveBeenCalled();
});
