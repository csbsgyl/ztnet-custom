import type { Session } from "~/lib/authTypes";
import { settingsRouter } from "~/server/api/routers/settingsRouter";

const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "user-1", role: "USER" },
} as Session;

test("global settings never expose the encrypted Alipay private key", async () => {
	const options = {
		id: 1,
		siteName: "ZTNET",
		smtpPassword: "encrypted-smtp",
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
		hasAlipayPrivateKey: true,
	});
	expect(result).not.toHaveProperty("alipayPrivateKeyEncrypted");
});
