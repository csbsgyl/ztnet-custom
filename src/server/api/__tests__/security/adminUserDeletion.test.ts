jest.mock("~/utils/ztApi", () => ({
	ZT_FOLDER: "/tmp/ztnet-test",
	network_members: jest.fn(),
	member_update: jest.fn(),
	network_delete: jest.fn(),
}));
jest.mock("~/cronTasks", () => ({ checkAndDeactivateExpiredUsers: jest.fn() }));
jest.mock("~/server/systemUpdate", () => ({
	getSystemUpdateStatus: jest.fn(),
	triggerSystemUpdate: jest.fn(),
}));
jest.mock("~/server/socketRegistry", () => ({ disconnectUserSockets: jest.fn() }));

import type { Session } from "~/lib/authTypes";
import { adminRouter } from "~/server/api/routers/adminRoute";
import { disconnectUserSockets } from "~/server/socketRegistry";
import * as ztController from "~/utils/ztApi";

const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "admin-1", role: "ADMIN" },
} as Session;

const admin = {
	id: "admin-1",
	role: "ADMIN",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

const target = {
	id: "user-1",
	name: "Customer",
	email: "customer@example.com",
	role: "USER",
};

function createDeletionCaller(targetUser = target) {
	const userFindUnique = jest.fn(async ({ where }) =>
		where.id === admin.id ? admin : targetUser,
	);
	const userDelete = jest.fn(async () => targetUser);
	const verificationDeleteMany = jest.fn(async () => ({ count: 2 }));
	const transaction = {
		user: { delete: userDelete },
		verification: { deleteMany: verificationDeleteMany },
	};
	const prisma = {
		user: { findUnique: userFindUnique },
		network: {
			findMany: jest.fn(async () => [{ nwid: "network-1" }]),
		},
		$transaction: jest.fn(async (operation) => operation(transaction)),
	};
	const caller = adminRouter.createCaller({
		session,
		prisma,
		wss: null,
		res: null,
	} as never);
	return { caller, prisma, userDelete, verificationDeleteMany };
}

beforeEach(() => {
	jest.mocked(ztController.network_members).mockResolvedValue({ member1: 1 });
	jest.mocked(ztController.member_update).mockResolvedValue({ ok: true } as never);
	jest.mocked(ztController.network_delete).mockResolvedValue({
		status: 200,
		data: undefined,
	});
});

test("administrator deletion removes controller networks before deleting all user data", async () => {
	const harness = createDeletionCaller();
	let controllerDeletionFinished = false;
	jest.mocked(ztController.network_delete).mockImplementation(async () => {
		await Promise.resolve();
		controllerDeletionFinished = true;
		return { status: 200, data: undefined };
	});
	harness.userDelete.mockImplementation(async () => {
		expect(controllerDeletionFinished).toBe(true);
		return target;
	});

	await expect(harness.caller.deleteUser({ id: target.id })).resolves.toEqual({
		status: "success",
	});

	expect(ztController.network_members).toHaveBeenCalledWith(
		expect.objectContaining({
			session: expect.objectContaining({
				user: expect.objectContaining({ id: target.id }),
			}),
		}),
		"network-1",
		false,
	);
	expect(ztController.member_update).toHaveBeenCalledWith(
		expect.objectContaining({
			nwid: "network-1",
			memberId: "member1",
			central: false,
			updateParams: { authorized: false },
		}),
	);
	expect(harness.verificationDeleteMany).toHaveBeenCalledWith({
		where: { identifier: { in: [target.id, target.email] } },
	});
	expect(harness.userDelete).toHaveBeenCalledWith({
		where: { id: target.id },
		select: { id: true },
	});
	expect(disconnectUserSockets).toHaveBeenCalledWith(target.id);
});

test("administrator cannot delete their own account", async () => {
	const harness = createDeletionCaller();

	await expect(harness.caller.deleteUser({ id: admin.id })).rejects.toThrow(
		"You can't delete your own account",
	);
	expect(harness.userDelete).not.toHaveBeenCalled();
});

test("administrator cannot delete another administrator", async () => {
	const harness = createDeletionCaller({ ...target, role: "ADMIN" });

	await expect(harness.caller.deleteUser({ id: target.id })).rejects.toThrow(
		"You can't delete admin users",
	);
	expect(harness.userDelete).not.toHaveBeenCalled();
});
