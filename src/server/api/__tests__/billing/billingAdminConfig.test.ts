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
		alipayNotifyUrl: null,
		alipayReturnUrl: null,
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
		notifyOrigin: "https://billing.example.test",
		returnOrigin: "https://billing.example.test",
	});

	expect(harness.upsert).toHaveBeenCalledWith(
		expect.objectContaining({
			update: expect.objectContaining({
				alipayEnabled: true,
				alipayAppId: "2026071500000001",
				alipayFeeRateBps: 60,
				alipayPublicKey: credentials.alipayPublicKey,
				alipayPrivateKeyEncrypted: expect.stringMatching(/^v1:/),
				alipayNotifyUrl: "https://billing.example.test/api/billing/alipay/notify",
				alipayReturnUrl: "https://billing.example.test/billing/return",
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
		notifyOrigin: "https://billing.example.test",
		returnOrigin: "https://billing.example.test",
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
		notifyOrigin: "https://billing.example.test",
		returnOrigin: "https://billing.example.test",
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
			notifyOrigin: "https://billing.example.test",
			returnOrigin: "https://billing.example.test",
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
			notifyOrigin: "https://billing.example.test",
			returnOrigin: "https://billing.example.test",
		}),
	).rejects.toThrow("merchant application private key format is invalid");

	expect(harness.upsert).not.toHaveBeenCalled();
});

test("rejects callback paths when only an origin is allowed", async () => {
	const harness = createHarness();

	await expect(
		harness.caller.saveAlipayConfig({
			enabled: false,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			feeRateBps: 0,
			notifyOrigin: "https://billing.example.test/custom/notify",
			returnOrigin: "https://billing.example.test",
		}),
	).rejects.toThrow("asynchronous notification domain");
	await expect(
		harness.caller.saveAlipayConfig({
			enabled: false,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			feeRateBps: 0,
			notifyOrigin: "https://billing.example.test",
			returnOrigin: "https://billing.example.test/billing/return",
		}),
	).rejects.toThrow("browser return domain");
	expect(harness.upsert).not.toHaveBeenCalled();
});

test("requires manually configured callback domains before enabling Alipay", async () => {
	const harness = createHarness({
		alipayAppId: "2026071500000001",
		alipayPublicKey: "stored-public-key",
		alipayPrivateKeyEncrypted: "v1:stored-private-key",
	});

	await expect(
		harness.caller.saveAlipayConfig({
			enabled: true,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			feeRateBps: 0,
			notifyOrigin: "",
			returnOrigin: "",
		}),
	).rejects.toThrow("Both Alipay callback domains are required");
	expect(harness.upsert).not.toHaveBeenCalled();
});

test("keeps callback domains when payments are disabled without replacement values", async () => {
	const harness = createHarness({
		alipayEnabled: true,
		alipayAppId: "2026071500000001",
		alipayPublicKey: "stored-public-key",
		alipayPrivateKeyEncrypted: "v1:stored-private-key",
		alipayNotifyUrl: "https://billing.example.test/api/billing/alipay/notify",
		alipayReturnUrl: "https://billing.example.test/billing/return",
	});

	const result = await harness.caller.saveAlipayConfig({
		enabled: false,
		appId: "2026071500000001",
		gateway: "https://openapi.alipay.com/gateway.do",
		feeRateBps: 0,
		notifyOrigin: "",
		returnOrigin: "",
	});

	const update = harness.upsert.mock.calls[0]?.[0].update;
	expect(update).toMatchObject({ alipayEnabled: false });
	expect(update).not.toHaveProperty("alipayNotifyUrl");
	expect(update).not.toHaveProperty("alipayReturnUrl");
	expect(result).toMatchObject({
		notifyOrigin: "https://billing.example.test",
		returnOrigin: "https://billing.example.test",
	});
});

test("does not enable Alipay with invalid callback URLs already stored in the database", async () => {
	const harness = createHarness({
		alipayAppId: "2026071500000001",
		alipayPublicKey: "stored-public-key",
		alipayPrivateKeyEncrypted: "v1:stored-private-key",
		alipayNotifyUrl: "https://user:password@billing.example.test/notify",
		alipayReturnUrl: "https://billing.example.test/billing/return#fragment",
	});

	await expect(
		harness.caller.saveAlipayConfig({
			enabled: true,
			appId: "2026071500000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			feeRateBps: 0,
			notifyOrigin: "",
			returnOrigin: "",
		}),
	).rejects.toThrow("Both Alipay callback domains are required");
	expect(harness.upsert).not.toHaveBeenCalled();
});

test("returns empty callback fields instead of deriving them from the server URL", async () => {
	const harness = createHarness();
	const originalNextAuthUrl = process.env.NEXTAUTH_URL;
	process.env.NEXTAUTH_URL = "https://must-not-be-used.example.test";

	try {
		await expect(harness.caller.getAlipayConfig()).resolves.toMatchObject({
			notifyOrigin: "",
			returnOrigin: "",
		});
	} finally {
		process.env.NEXTAUTH_URL = originalNextAuthUrl;
	}
});
