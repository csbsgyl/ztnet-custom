import type { Session } from "~/lib/authTypes";
import { settingsRouter } from "~/server/api/routers/settingsRouter";

const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "user-1", role: "USER" },
} as Session;

test("global settings expose only Alipay key configuration states", async () => {
	const options = {
		id: 1,
		siteName: "ZTNET",
		smtpPassword: "encrypted-smtp",
		alipayPublicKey: "stored-alipay-public-key",
		alipayPrivateKeyEncrypted: "v1:secret-ciphertext",
	};
	const caller = settingsRouter.createCaller({
		session,
		prisma: {
			user: {
				findUnique: jest.fn().mockResolvedValue({
					id: "user-1",
					role: "USER",
					isActive: true,
					suspensionReason: "NONE",
					expiresAt: null,
				}),
			},
			globalOptions: { findFirst: jest.fn().mockResolvedValue(options) },
		},
		wss: null,
		res: null,
	} as never);

	const result = await caller.getAllOptions();

	expect(result).toMatchObject({
		siteName: "ZTNET",
		smtpPassword: null,
		hasSmtpPassword: true,
		hasAlipayPublicKey: true,
		hasAlipayPrivateKey: true,
	});
	expect(result).not.toHaveProperty("alipayPublicKey");
	expect(result).not.toHaveProperty("alipayPrivateKeyEncrypted");
});
