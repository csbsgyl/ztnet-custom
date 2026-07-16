import type { PrismaClient } from "@prisma/client";
import { assignAdminPlanWithExpiration } from "~/server/billing/adminAssignment";

const NOW = new Date("2026-07-16T08:00:00.000Z");
const EXPIRES_AT = new Date("2027-07-16T15:59:59.999Z");

function createHarness(
	overrides: {
		user?: Record<string, unknown> | null;
		plan?: Record<string, unknown> | null;
		subscription?: Record<string, unknown> | null;
		pendingSuspensions?: number;
		unsettledOrder?: { id: string } | null;
		legacyMembers?: Array<{ id: string; nwid: string }>;
	} = {},
) {
	const user =
		overrides.user === null
			? null
			: {
					id: "user-1",
					role: "USER",
					isActive: true,
					suspensionReason: "NONE",
					expiresAt: null,
					userGroup: { expiresAt: null },
					...overrides.user,
				};
	const plan =
		overrides.plan === null
			? null
			: {
					id: "plan-1",
					name: "Three Networks",
					priceCents: 2_990,
					durationMonths: 1,
					level: 3,
					isActive: true,
					userGroup: { id: 30, maxNetworks: 3 },
					...overrides.plan,
				};
	const executeRaw = jest.fn(
		async (_query: TemplateStringsArray, ..._values: unknown[]) => 1,
	);
	const subscriptionUpsert = jest.fn(async () => ({ id: "subscription-1" }));
	const userUpdate = jest.fn(
		async (_args: {
			where: { id: string };
			data: Record<string, unknown>;
		}) => user,
	);
	const activityCreate = jest.fn(async () => ({ id: 1 }));
	const snapshotUpsert = jest.fn(async () => ({ id: "snapshot-1" }));
	const transaction = {
		$executeRaw: executeRaw,
		user: {
			findUnique: jest.fn(async () => user),
			update: userUpdate,
		},
		billingPlan: { findUnique: jest.fn(async () => plan) },
		subscription: {
			findUnique: jest.fn(async () => overrides.subscription ?? null),
			upsert: subscriptionUpsert,
		},
		subscriptionSuspensionSnapshot: {
			count: jest.fn(async () => overrides.pendingSuspensions ?? 0),
			upsert: snapshotUpsert,
		},
		network_members: {
			findMany: jest.fn(async () => overrides.legacyMembers ?? []),
		},
		billingOrder: {
			findFirst: jest.fn(async () => overrides.unsettledOrder ?? null),
		},
		activityLog: { create: activityCreate },
	};
	const databaseTransaction = jest.fn(async (operation) => operation(transaction));
	const prisma = { $transaction: databaseTransaction } as unknown as PrismaClient;

	return {
		prisma,
		mocks: {
			executeRaw,
			subscriptionUpsert,
			userUpdate,
			activityCreate,
			databaseTransaction,
			billingOrderFindFirst: transaction.billingOrder.findFirst,
			networkMembersFindMany: transaction.network_members.findMany,
			snapshotUpsert,
		},
	};
}

function assign(
	prisma: PrismaClient,
	input: Partial<Parameters<typeof assignAdminPlanWithExpiration>[1]> = {},
) {
	return assignAdminPlanWithExpiration(prisma, {
		userId: "user-1",
		planId: "plan-1",
		expiresAt: EXPIRES_AT,
		performedById: "admin-1",
		now: NOW,
		...input,
	});
}

test("creates a complete subscription snapshot and legacy user projection", async () => {
	const harness = createHarness();

	const result = await assign(harness.prisma, { note: "Annual agreement" });

	expect(harness.mocks.executeRaw).toHaveBeenCalled();
	expect(harness.mocks.executeRaw.mock.calls[0]?.[1]).toBe("billing-user:user-1");
	expect(harness.mocks.subscriptionUpsert).toHaveBeenCalledWith({
		where: { userId: "user-1" },
		create: {
			userId: "user-1",
			planId: "plan-1",
			status: "ACTIVE",
			startsAt: NOW,
			expiresAt: EXPIRES_AT,
			maxNetworksSnapshot: 3,
			userGroupIdSnapshot: 30,
			planPriceCentsSnapshot: 2_990,
			durationMonthsSnapshot: 1,
			planLevelSnapshot: 3,
		},
		update: expect.objectContaining({
			planId: "plan-1",
			status: "ACTIVE",
			expiresAt: EXPIRES_AT,
			maxNetworksSnapshot: 3,
			userGroupIdSnapshot: 30,
			planLevelSnapshot: 3,
		}),
		select: { id: true },
	});
	expect(harness.mocks.userUpdate).toHaveBeenCalledWith({
		where: { id: "user-1" },
		data: {
			userGroupId: 30,
			expiresAt: EXPIRES_AT,
			legacyBillingExempt: false,
		},
	});
	expect(harness.mocks.activityCreate).toHaveBeenCalledWith({
		data: expect.objectContaining({
			performedById: "admin-1",
			action: expect.stringContaining("Annual agreement"),
		}),
	});
	expect(result).toMatchObject({
		planId: "plan-1",
		userGroupId: 30,
		maxNetworks: 3,
		needsRestoration: false,
	});
});

test("keeps the current term start while applying a lower plan snapshot", async () => {
	const startsAt = new Date("2026-06-01T00:00:00.000Z");
	const harness = createHarness({
		plan: {
			id: "plan-basic",
			name: "One Network",
			priceCents: 990,
			durationMonths: 1,
			level: 1,
			userGroup: { id: 10, maxNetworks: 1 },
		},
		subscription: {
			id: "subscription-1",
			userId: "user-1",
			status: "ACTIVE",
			startsAt,
			expiresAt: new Date("2026-12-01T00:00:00.000Z"),
			planLevelSnapshot: 5,
		},
	});

	await assign(harness.prisma, { planId: "plan-basic" });

	expect(harness.mocks.subscriptionUpsert).toHaveBeenCalledWith(
		expect.objectContaining({
			update: expect.objectContaining({
				planId: "plan-basic",
				startsAt,
				maxNetworksSnapshot: 1,
				planLevelSnapshot: 1,
			}),
		}),
	);
	// Existing networks are intentionally untouched; the lower snapshot limits only new creation.
	expect(Object.keys(harness.prisma)).toEqual(["$transaction"]);
});

test("marks subscription-expired users for post-commit restoration", async () => {
	const harness = createHarness({
		user: {
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
			expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		},
		subscription: {
			id: "subscription-1",
			status: "EXPIRED",
			startsAt: new Date("2026-06-01T00:00:00.000Z"),
			expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		},
	});

	const result = await assign(harness.prisma);

	expect(result.needsRestoration).toBe(true);
	expect(harness.mocks.userUpdate).toHaveBeenCalledWith({
		where: { id: "user-1" },
		data: expect.objectContaining({
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		}),
	});
	expect(harness.mocks.subscriptionUpsert).toHaveBeenCalledWith(
		expect.objectContaining({
			update: expect.objectContaining({ startsAt: NOW, status: "ACTIVE" }),
		}),
	);
});

test("bridges legacy-expired members into restoration snapshots", async () => {
	const expiredAt = new Date("2026-07-01T00:00:00.000Z");
	const harness = createHarness({
		user: {
			isActive: false,
			suspensionReason: "NONE",
			expiresAt: expiredAt,
		},
		legacyMembers: [
			{ id: "member-1", nwid: "network-1" },
			{ id: "member-2", nwid: "network-2" },
		],
	});

	const result = await assign(harness.prisma);

	expect(result.needsRestoration).toBe(true);
	expect(harness.mocks.networkMembersFindMany).toHaveBeenCalledWith({
		where: {
			authorized: true,
			deleted: false,
			permanentlyDeleted: false,
			nwid_ref: { authorId: "user-1", organizationId: null },
		},
		select: { id: true, nwid: true },
	});
	expect(harness.mocks.snapshotUpsert).toHaveBeenCalledTimes(2);
	expect(harness.mocks.snapshotUpsert).toHaveBeenNthCalledWith(1, {
		where: {
			userId_networkId_memberId: {
				userId: "user-1",
				networkId: "network-1",
				memberId: "member-1",
			},
		},
		create: {
			userId: "user-1",
			subscriptionId: "subscription-1",
			networkId: "network-1",
			memberId: "member-1",
			wasAuthorized: true,
			suspendedAt: expiredAt,
		},
		update: {
			subscriptionId: "subscription-1",
			wasAuthorized: true,
			suspendedAt: expiredAt,
			restoredAt: null,
			lastError: null,
		},
	});
});

test.each(["ADMIN", "MANUAL"])(
	"never clears a %s manual suspension while assigning a plan",
	async (suspensionReason) => {
		const harness = createHarness({
			user: { isActive: false, suspensionReason },
		});

		const result = await assign(harness.prisma);

		expect(result.needsRestoration).toBe(false);
		const update = harness.mocks.userUpdate.mock.calls[0]?.[0];
		if (!update) throw new Error("Expected the user projection to be updated.");
		expect(update.data).not.toHaveProperty("isActive");
		expect(update.data).not.toHaveProperty("suspensionReason");
	},
);

test("rejects elapsed expiration dates before starting a transaction", async () => {
	const harness = createHarness();

	await expect(assign(harness.prisma, { expiresAt: NOW })).rejects.toThrow(
		"The plan expiration must be a future date.",
	);
	expect(harness.mocks.databaseTransaction).not.toHaveBeenCalled();
});

test("rejects assignment while member suspension is still in progress", async () => {
	const harness = createHarness({ pendingSuspensions: 1 });

	await expect(assign(harness.prisma)).rejects.toThrow(
		"Subscription suspension is still in progress",
	);
	expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
	expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
});

test("rejects every pending or paid-unfulfilled order before changing entitlement", async () => {
	const harness = createHarness({ unsettledOrder: { id: "order-1" } });

	await expect(assign(harness.prisma)).rejects.toThrow(
		"The user has an unpaid or unfulfilled order",
	);
	expect(harness.mocks.billingOrderFindFirst).toHaveBeenCalledWith({
		where: {
			userId: "user-1",
			OR: [{ status: "PENDING" }, { status: "PAID", entitlementAppliedAt: null }],
		},
		select: { id: true },
	});
	expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
	expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
});

test("rejects administrator accounts", async () => {
	const harness = createHarness({ user: { role: "ADMIN" } });

	await expect(assign(harness.prisma)).rejects.toThrow(
		"Administrator accounts do not need plans.",
	);
	expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
});

test("rejects assigning an archived plan to a new subscriber", async () => {
	const harness = createHarness({ plan: { isActive: false } });

	await expect(assign(harness.prisma)).rejects.toThrow(
		"Archived plans cannot be newly assigned.",
	);
	expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
});

test("allows an archived current plan to be repaired or extended", async () => {
	const harness = createHarness({
		plan: { isActive: false },
		subscription: {
			id: "subscription-1",
			planId: "plan-1",
			status: "ACTIVE",
			startsAt: new Date("2026-06-01T00:00:00.000Z"),
			expiresAt: new Date("2026-12-01T00:00:00.000Z"),
		},
	});

	await expect(assign(harness.prisma)).resolves.toMatchObject({ planId: "plan-1" });
	expect(harness.mocks.subscriptionUpsert).toHaveBeenCalled();
});
