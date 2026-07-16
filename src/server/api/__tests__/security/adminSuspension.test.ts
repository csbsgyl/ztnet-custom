jest.mock("~/utils/ztApi", () => ({ ZT_FOLDER: "/tmp/ztnet-test" }));
jest.mock("~/cronTasks", () => ({ checkAndDeactivateExpiredUsers: jest.fn() }));
jest.mock("~/server/systemUpdate", () => ({
	getSystemUpdateStatus: jest.fn(),
	triggerSystemUpdate: jest.fn(),
}));
jest.mock("~/server/socketRegistry", () => ({ disconnectUserSockets: jest.fn() }));

import type { Session } from "~/lib/authTypes";
import { adminRouter } from "~/server/api/routers/adminRoute";
import { disconnectUserSockets } from "~/server/socketRegistry";

const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "admin-1", role: "ADMIN" },
} as Session;

function createCaller(
	target: Record<string, unknown> = {
		id: "user-1",
		role: "USER",
		suspensionReason: "NONE",
		expiresAt: null,
		userGroup: null,
		subscription: null,
	},
) {
	const userUpdate = jest.fn(async ({ data }) => ({ id: "user-1", ...data }));
	const sessionDeleteMany = jest.fn(async () => ({ count: 2 }));
	const tokenUpdateMany = jest.fn(async () => ({ count: 3 }));
	const executeRaw = jest.fn(async () => 1);
	const transaction = {
		$executeRaw: executeRaw,
		user: { findUnique: jest.fn(async () => target), update: userUpdate },
		session: { deleteMany: sessionDeleteMany },
		aPIToken: { updateMany: tokenUpdateMany },
	};
	const userFindUnique = jest.fn().mockResolvedValue({
		id: "admin-1",
		role: "ADMIN",
		isActive: true,
		suspensionReason: "NONE",
		expiresAt: null,
	});
	const caller = adminRouter.createCaller({
		session,
		prisma: {
			user: { findUnique: userFindUnique },
			$transaction: jest.fn(async (operation) => operation(transaction)),
		},
		wss: null,
		res: null,
	} as never);
	return { caller, userUpdate, sessionDeleteMany, tokenUpdateMany, executeRaw };
}

test("administrator suspension immediately revokes every access path", async () => {
	const harness = createCaller();

	await harness.caller.updateUser({ id: "user-1", params: { isActive: false } });

	expect(harness.userUpdate).toHaveBeenCalledWith({
		where: { id: "user-1" },
		data: { isActive: false, suspensionReason: "ADMIN" },
	});
	expect(harness.sessionDeleteMany).toHaveBeenCalledWith({
		where: { userId: "user-1" },
	});
	expect(harness.tokenUpdateMany).toHaveBeenCalledWith({
		where: { userId: "user-1", isActive: true },
		data: { isActive: false },
	});
	expect(disconnectUserSockets).toHaveBeenCalledWith("user-1");
	expect(harness.executeRaw).toHaveBeenCalled();
});

test("administrator reactivation does not silently reactivate old API tokens", async () => {
	const harness = createCaller();

	await harness.caller.updateUser({ id: "user-1", params: { isActive: true } });

	expect(harness.userUpdate).toHaveBeenCalledWith({
		where: { id: "user-1" },
		data: { isActive: true, suspensionReason: "NONE" },
	});
	expect(harness.sessionDeleteMany).not.toHaveBeenCalled();
	expect(harness.tokenUpdateMany).not.toHaveBeenCalled();
	expect(disconnectUserSockets).not.toHaveBeenCalled();
});

test("administrator cannot bypass subscription expiration with the active toggle", async () => {
	const harness = createCaller({
		id: "user-1",
		role: "USER",
		suspensionReason: "SUBSCRIPTION_EXPIRED",
		expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		userGroup: null,
		subscription: {
			status: "EXPIRED",
			startsAt: new Date("2026-06-01T00:00:00.000Z"),
			expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		},
	});

	await expect(
		harness.caller.updateUser({ id: "user-1", params: { isActive: true } }),
	).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	expect(harness.userUpdate).not.toHaveBeenCalled();
});

test("administrator settings responses expose only Alipay key states", async () => {
	const storedOptions = {
		id: 1,
		siteName: "ZTNET",
		smtpPassword: "v1:stored-smtp-password",
		alipayPublicKey: "stored-alipay-public-key",
		alipayPrivateKeyEncrypted: "v1:stored-alipay-private-key",
	};
	const globalOptions = {
		findFirst: jest.fn(async () => storedOptions),
		update: jest.fn(async ({ data }) => ({ ...storedOptions, ...data })),
	};
	const caller = adminRouter.createCaller({
		session,
		prisma: {
			user: {
				findUnique: jest.fn(async () => ({
					id: "admin-1",
					role: "ADMIN",
					isActive: true,
					suspensionReason: "NONE",
					expiresAt: null,
				})),
			},
			globalOptions,
		},
		wss: null,
		res: null,
	} as never);

	const queried = await caller.getAllOptions();
	const updated = await caller.updateGlobalOptions({ siteName: "ZTNET Custom" });

	for (const result of [queried, updated]) {
		expect(result).toMatchObject({
			hasAlipayPublicKey: true,
			hasAlipayPrivateKey: true,
		});
		expect(result).not.toHaveProperty("alipayPublicKey");
		expect(result).not.toHaveProperty("alipayPrivateKeyEncrypted");
	}

	await expect(
		caller.getMailTemplates({ template: "alipayPublicKey" } as never),
	).rejects.toThrow();
	await expect(
		caller.setMailTemplates({
			type: "alipayPublicKey",
			template: "replacement-key",
		} as never),
	).rejects.toThrow();
	expect(globalOptions.update).toHaveBeenCalledTimes(1);
});
