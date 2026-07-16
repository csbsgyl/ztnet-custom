jest.mock("cron", () => ({ CronJob: jest.fn() }));
jest.mock("~/server/db", () => ({
	prisma: {
		$transaction: jest.fn(),
		$executeRaw: jest.fn(),
		user: {
			findMany: jest.fn(),
			findUnique: jest.fn(),
			update: jest.fn(),
		},
		subscriptionSuspensionSnapshot: {
			upsert: jest.fn(),
			findMany: jest.fn(),
			update: jest.fn(),
		},
		aPIToken: { updateMany: jest.fn() },
		session: { deleteMany: jest.fn() },
		networkQuotaReservation: {
			deleteMany: jest.fn(),
		},
		network_members: {
			updateMany: jest.fn(),
		},
		billingOrder: {
			updateMany: jest.fn(),
			findMany: jest.fn(),
		},
		globalOptions: {
			findUnique: jest.fn(),
		},
		network: { findMany: jest.fn() },
	},
}));
jest.mock("~/server/billing/suspension", () => ({
	reconcileExpiredSubscriptions: jest.fn(),
}));
jest.mock("~/server/api/services/memberService", () => ({
	reconcileNetworkMembers: jest.fn(),
}));
jest.mock("~/utils/ztApi", () => ({
	network_members: jest.fn(),
	member_update: jest.fn(),
}));
jest.mock("~/server/billing/runtime", () => ({
	fulfilPaidOrder: jest.fn(),
}));
jest.mock("~/server/billing/payment", () => ({
	queryAndReconcileAlipayOrder: jest.fn(),
}));
jest.mock("~/server/billing/config", () => ({
	getAlipayRuntimeConfig: jest.fn(),
}));
jest.mock("~/server/socketRegistry", () => ({
	disconnectUserSockets: jest.fn(),
}));

import * as cron from "cron";
import {
	CheckExpiredUsers,
	checkAndDeactivateExpiredUsers,
	runExpirationMaintenance,
	runExpirationMaintenanceOnce,
} from "~/cronTasks";
import { prisma } from "~/server/db";
import { reconcileExpiredSubscriptions } from "~/server/billing/suspension";
import * as ztController from "~/utils/ztApi";
import { fulfilPaidOrder } from "~/server/billing/runtime";
import { queryAndReconcileAlipayOrder } from "~/server/billing/payment";
import { getAlipayRuntimeConfig } from "~/server/billing/config";
import { disconnectUserSockets } from "~/server/socketRegistry";

const mockPrisma = prisma as unknown as {
	$transaction: jest.Mock;
	$executeRaw: jest.Mock;
	user: {
		findMany: jest.Mock;
		findUnique: jest.Mock;
		update: jest.Mock;
	};
	subscriptionSuspensionSnapshot: {
		upsert: jest.Mock;
		findMany: jest.Mock;
		update: jest.Mock;
	};
	aPIToken: { updateMany: jest.Mock };
	session: { deleteMany: jest.Mock };
	networkQuotaReservation: { deleteMany: jest.Mock };
	network_members: { updateMany: jest.Mock };
	billingOrder: { updateMany: jest.Mock; findMany: jest.Mock };
	globalOptions: { findUnique: jest.Mock };
	network: { findMany: jest.Mock };
};

const NOW = new Date("2026-07-14T08:00:00.000Z");
const EMPTY_RECONCILIATION = {
	scanned: 0,
	suspended: 0,
	alreadySuspended: 0,
	partialFailures: 0,
	skipped: 0,
	errors: [],
};

beforeEach(() => {
	mockPrisma.$transaction.mockReset();
	mockPrisma.$transaction.mockImplementation(async (operation) => operation(mockPrisma));
	mockPrisma.$executeRaw.mockReset();
	mockPrisma.$executeRaw.mockResolvedValue(1);
	mockPrisma.user.findMany.mockReset();
	mockPrisma.user.findUnique.mockReset();
	mockPrisma.user.update.mockReset();
	mockPrisma.subscriptionSuspensionSnapshot.upsert.mockReset();
	mockPrisma.subscriptionSuspensionSnapshot.findMany.mockReset();
	mockPrisma.subscriptionSuspensionSnapshot.findMany.mockResolvedValue([]);
	mockPrisma.subscriptionSuspensionSnapshot.update.mockReset();
	mockPrisma.aPIToken.updateMany.mockReset();
	mockPrisma.aPIToken.updateMany.mockResolvedValue({ count: 0 });
	mockPrisma.session.deleteMany.mockReset();
	mockPrisma.session.deleteMany.mockResolvedValue({ count: 0 });
	mockPrisma.networkQuotaReservation.deleteMany.mockReset();
	mockPrisma.network_members.updateMany.mockReset();
	mockPrisma.billingOrder.updateMany.mockReset();
	mockPrisma.billingOrder.findMany.mockReset();
	mockPrisma.billingOrder.findMany.mockResolvedValue([]);
	mockPrisma.globalOptions.findUnique.mockReset();
	mockPrisma.globalOptions.findUnique.mockResolvedValue(null);
	jest.mocked(reconcileExpiredSubscriptions).mockReset();
	jest.mocked(ztController.network_members).mockReset();
	jest.mocked(ztController.member_update).mockReset();
	jest.mocked(cron.CronJob).mockClear();
	jest.mocked(fulfilPaidOrder).mockReset();
	jest.mocked(queryAndReconcileAlipayOrder).mockReset();
	jest.mocked(getAlipayRuntimeConfig).mockReset();
	jest.mocked(disconnectUserSockets).mockReset();
});

describe("expiration maintenance", () => {
	test("runs subscription expiry and reservation cleanup without blindly closing orders", async () => {
		jest.mocked(reconcileExpiredSubscriptions).mockResolvedValue({
			...EMPTY_RECONCILIATION,
			scanned: 2,
			suspended: 2,
		});
		mockPrisma.user.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 3 });
		mockPrisma.billingOrder.updateMany.mockResolvedValue({ count: 0 });

		const result = await runExpirationMaintenance(NOW);
		expect(result).toEqual({
			subscriptions: { ...EMPTY_RECONCILIATION, scanned: 2, suspended: 2 },
			legacyUsersDeactivated: 0,
			expiredReservationsDeleted: 3,
			pendingBillingOrdersClosed: 0,
			billingOrdersReconciled: 0,
		});

		expect(reconcileExpiredSubscriptions).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: mockPrisma,
				controllerUpdate: expect.any(Function),
				now: expect.any(Function),
			}),
			{ batchSize: 100 },
		);
		const dependencies = jest.mocked(reconcileExpiredSubscriptions).mock.calls[0]?.[0];
		expect(dependencies?.now?.()).toEqual(NOW);
		expect(
			jest.mocked(reconcileExpiredSubscriptions).mock.invocationCallOrder[0],
		).toBeLessThan(
			mockPrisma.user.findMany.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
		expect(mockPrisma.networkQuotaReservation.deleteMany).toHaveBeenCalledWith({
			where: { expiresAt: { lte: NOW } },
		});
		expect(mockPrisma.billingOrder.updateMany).not.toHaveBeenCalled();

		jest.mocked(ztController.member_update).mockResolvedValue({ ok: true } as never);
		mockPrisma.network_members.updateMany.mockResolvedValue({ count: 1 });
		await dependencies?.controllerUpdate({
			userId: "user-1",
			networkId: "network-1",
			memberId: "member-1",
			authorized: false,
		});
		expect(ztController.member_update).toHaveBeenCalledWith({
			ctx: { session: { user: { id: "user-1" } } },
			nwid: "network-1",
			memberId: "member-1",
			central: false,
			updateParams: { authorized: false },
		});
		expect(mockPrisma.network_members.updateMany).toHaveBeenCalledWith({
			where: { id: "member-1", nwid: "network-1" },
			data: { authorized: false },
		});
		expect(
			jest.mocked(ztController.member_update).mock.invocationCallOrder[0],
		).toBeLessThan(mockPrisma.network_members.updateMany.mock.invocationCallOrder[0]);
	});

	test("retries paid fulfilment even when Alipay is disabled", async () => {
		jest.mocked(reconcileExpiredSubscriptions).mockResolvedValue(EMPTY_RECONCILIATION);
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.findMany.mockResolvedValueOnce([
			{ id: "paid-1", merchantOrderNo: "ZT-PAID-1" },
		]);
		mockPrisma.billingOrder.updateMany.mockResolvedValue({ count: 0 });
		mockPrisma.globalOptions.findUnique.mockResolvedValue({ alipayEnabled: false });
		jest.mocked(fulfilPaidOrder).mockResolvedValue({ status: "FULFILLED" } as never);

		const result = await runExpirationMaintenance(NOW);

		expect(fulfilPaidOrder).toHaveBeenCalledWith(mockPrisma, "ZT-PAID-1");
		expect(result.billingOrdersReconciled).toBe(1);
	});

	test("does not read Alipay configuration when no expired order needs a query", async () => {
		jest.mocked(reconcileExpiredSubscriptions).mockResolvedValue(EMPTY_RECONCILIATION);
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.findMany.mockResolvedValue([]);

		await runExpirationMaintenance(NOW);

		expect(mockPrisma.globalOptions.findUnique).not.toHaveBeenCalled();
		expect(getAlipayRuntimeConfig).not.toHaveBeenCalled();
	});

	test("shares one in-flight maintenance run across overlapping ticks", async () => {
		let finishReconciliation: (value: typeof EMPTY_RECONCILIATION) => void = () =>
			undefined;
		jest.mocked(reconcileExpiredSubscriptions).mockReturnValue(
			new Promise((resolve) => {
				finishReconciliation = resolve;
			}),
		);
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.findMany.mockResolvedValue([]);

		const first = runExpirationMaintenanceOnce(NOW);
		const second = runExpirationMaintenanceOnce(NOW);

		expect(second).toBe(first);
		expect(reconcileExpiredSubscriptions).toHaveBeenCalledTimes(1);
		finishReconciliation(EMPTY_RECONCILIATION);
		await expect(first).resolves.toMatchObject({ billingOrdersReconciled: 0 });
	});

	test("queries expired pending orders before closing confirmed-unpaid orders", async () => {
		jest.mocked(reconcileExpiredSubscriptions).mockResolvedValue(EMPTY_RECONCILIATION);
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "pending-1" }]);
		mockPrisma.billingOrder.updateMany.mockResolvedValue({ count: 1 });
		mockPrisma.globalOptions.findUnique.mockResolvedValue({ id: 1 });
		jest.mocked(getAlipayRuntimeConfig).mockReturnValue({ appId: "app" } as never);
		jest.mocked(queryAndReconcileAlipayOrder).mockResolvedValue({ state: "NOT_FOUND" });

		await runExpirationMaintenance(NOW);

		expect(queryAndReconcileAlipayOrder).toHaveBeenCalledWith(
			expect.objectContaining({ orderId: "pending-1" }),
		);
		expect(mockPrisma.billingOrder.updateMany).toHaveBeenCalledWith({
			where: { id: "pending-1", status: "PENDING" },
			data: { status: "CLOSED", closedAt: NOW },
		});
	});

	test("keeps a pending order open when the Alipay query fails", async () => {
		jest.mocked(reconcileExpiredSubscriptions).mockResolvedValue(EMPTY_RECONCILIATION);
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "pending-1" }]);
		mockPrisma.billingOrder.updateMany.mockResolvedValue({ count: 0 });
		mockPrisma.globalOptions.findUnique.mockResolvedValue({ id: 1 });
		jest.mocked(getAlipayRuntimeConfig).mockReturnValue({ appId: "app" } as never);
		jest
			.mocked(queryAndReconcileAlipayOrder)
			.mockRejectedValue(new Error("gateway unavailable"));
		const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

		await runExpirationMaintenance(NOW);

		expect(mockPrisma.billingOrder.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "pending-1", status: "PENDING" } }),
		);
		consoleError.mockRestore();
	});

	test("does not update the member cache when the controller update fails", async () => {
		jest
			.mocked(reconcileExpiredSubscriptions)
			.mockImplementation(async (dependencies) => {
				await dependencies.controllerUpdate({
					userId: "user-1",
					networkId: "network-1",
					memberId: "member-1",
					authorized: false,
				});
				return EMPTY_RECONCILIATION;
			});
		jest
			.mocked(ztController.member_update)
			.mockRejectedValue(new Error("controller unavailable"));
		mockPrisma.user.findMany.mockResolvedValue([]);
		mockPrisma.networkQuotaReservation.deleteMany.mockResolvedValue({ count: 0 });
		mockPrisma.billingOrder.updateMany.mockResolvedValue({ count: 0 });

		await expect(runExpirationMaintenance(NOW)).rejects.toThrow("controller unavailable");
		expect(mockPrisma.network_members.updateMany).not.toHaveBeenCalled();
	});

	test("legacy expiration rechecks entitlement under the billing user lock", async () => {
		mockPrisma.user.findMany.mockResolvedValue([{ id: "legacy-user" }]);
		mockPrisma.user.findUnique.mockResolvedValue({
			id: "legacy-user",
			role: "USER",
			isActive: true,
			suspensionReason: "NONE",
			expiresAt: NOW,
			userGroup: null,
			subscription: { id: "subscription-created-after-candidate-query" },
			network: [],
		});

		await expect(checkAndDeactivateExpiredUsers(NOW)).resolves.toBe(0);

		expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				role: { not: "ADMIN" },
				subscription: { is: null },
			}),
			select: { id: true },
		});
		expect(mockPrisma.$executeRaw.mock.calls[0]?.[1]).toBe("billing-user:legacy-user");
		expect(mockPrisma.user.update).not.toHaveBeenCalled();
		expect(mockPrisma.subscriptionSuspensionSnapshot.upsert).not.toHaveBeenCalled();
	});

	test("legacy expiration snapshots authorized members before controller suspension", async () => {
		const expiredUser = {
			id: "legacy-user",
			role: "USER",
			isActive: true,
			suspensionReason: "NONE",
			expiresAt: NOW,
			userGroup: null,
			subscription: null,
			network: [{ nwid: "network-1", networkMembers: [{ id: "member-1" }] }],
		};
		mockPrisma.user.findMany.mockResolvedValue([{ id: "legacy-user" }]);
		mockPrisma.user.findUnique.mockResolvedValue(expiredUser);
		mockPrisma.subscriptionSuspensionSnapshot.upsert.mockResolvedValue({
			id: "snapshot-1",
		});
		mockPrisma.subscriptionSuspensionSnapshot.findMany.mockResolvedValue([
			{ id: "snapshot-1", networkId: "network-1", memberId: "member-1" },
		]);
		mockPrisma.subscriptionSuspensionSnapshot.update.mockResolvedValue({
			id: "snapshot-1",
		});
		jest.mocked(ztController.member_update).mockResolvedValue({} as never);
		mockPrisma.user.update.mockResolvedValue({ id: "legacy-user" });
		mockPrisma.network_members.updateMany.mockResolvedValue({ count: 1 });

		await expect(checkAndDeactivateExpiredUsers(NOW)).resolves.toBe(1);

		expect(mockPrisma.subscriptionSuspensionSnapshot.upsert).toHaveBeenCalledWith({
			where: {
				userId_networkId_memberId: {
					userId: "legacy-user",
					networkId: "network-1",
					memberId: "member-1",
				},
			},
			create: {
				userId: "legacy-user",
				networkId: "network-1",
				memberId: "member-1",
				wasAuthorized: true,
			},
			update: {
				subscriptionId: null,
				wasAuthorized: true,
				suspendedAt: null,
				restoredAt: null,
				lastError: null,
			},
		});
		expect(ztController.member_update).toHaveBeenCalledWith(
			expect.objectContaining({
				nwid: "network-1",
				memberId: "member-1",
				updateParams: { authorized: false },
			}),
		);
		expect(mockPrisma.subscriptionSuspensionSnapshot.update).toHaveBeenCalledWith({
			where: { id: "snapshot-1" },
			data: { suspendedAt: NOW, lastError: null },
		});
		expect(mockPrisma.user.update).toHaveBeenCalledWith({
			where: { id: "legacy-user" },
			data: { isActive: false, suspensionReason: "SUBSCRIPTION_EXPIRED" },
		});
		expect(mockPrisma.aPIToken.updateMany).toHaveBeenCalledWith({
			where: { userId: "legacy-user", isActive: true },
			data: { isActive: false },
		});
		expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
			where: { userId: "legacy-user" },
		});
		expect(mockPrisma.network_members.updateMany).toHaveBeenCalledWith({
			where: { id: "member-1", nwid: "network-1" },
			data: { authorized: false },
		});
		expect(disconnectUserSockets).toHaveBeenCalledWith("legacy-user");
	});

	test("legacy controller failures leave a retryable snapshot and cached authorization", async () => {
		mockPrisma.user.findMany.mockResolvedValue([{ id: "legacy-user" }]);
		mockPrisma.user.findUnique.mockResolvedValue({
			id: "legacy-user",
			role: "USER",
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
			expiresAt: NOW,
			userGroup: null,
			subscription: null,
			network: [],
		});
		mockPrisma.subscriptionSuspensionSnapshot.findMany.mockResolvedValue([
			{ id: "snapshot-1", networkId: "network-1", memberId: "member-1" },
		]);
		mockPrisma.subscriptionSuspensionSnapshot.update.mockResolvedValue({
			id: "snapshot-1",
		});
		jest
			.mocked(ztController.member_update)
			.mockRejectedValue(new Error("controller unavailable"));
		const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(checkAndDeactivateExpiredUsers(NOW)).resolves.toBe(1);

		expect(mockPrisma.network_members.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.subscriptionSuspensionSnapshot.update).toHaveBeenCalledWith({
			where: { id: "snapshot-1" },
			data: { lastError: "controller unavailable" },
		});
		consoleError.mockRestore();
	});

	test("schedules expiration maintenance every minute", async () => {
		await CheckExpiredUsers();

		expect(cron.CronJob).toHaveBeenCalledWith(
			"* * * * *",
			expect.any(Function),
			null,
			true,
			"America/Los_Angeles",
		);
	});
});
