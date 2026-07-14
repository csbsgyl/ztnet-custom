import { describe, expect, jest, test } from "@jest/globals";
import {
	assertAccountActive,
	assertNetworkQuota,
	cleanupExpiredNetworkQuotaReservations,
	consumeNetworkQuotaReservation,
	getEffectiveEntitlement,
	releaseNetworkQuotaReservation,
	reserveNetworkQuota,
	type EntitlementPrisma,
	type EntitlementSubscriptionRecord,
	type EntitlementUserRecord,
	type NetworkQuotaReservationPrisma,
	type NetworkQuotaReservationTransaction,
} from "~/server/billing/entitlements";

const NOW = new Date("2026-07-14T08:00:00.000Z");

function user(overrides: Partial<EntitlementUserRecord> = {}): EntitlementUserRecord {
	return {
		id: "user-1",
		role: "USER",
		isActive: true,
		suspensionReason: "NONE",
		expiresAt: null,
		legacyBillingExempt: false,
		userGroup: null,
		...overrides,
	};
}

function subscription(
	overrides: Partial<EntitlementSubscriptionRecord> = {},
): EntitlementSubscriptionRecord {
	return {
		id: "subscription-1",
		userId: "user-1",
		status: "ACTIVE",
		startsAt: new Date("2026-07-01T00:00:00.000Z"),
		expiresAt: new Date("2026-08-01T00:00:00.000Z"),
		maxNetworksSnapshot: 8,
		userGroupIdSnapshot: 18,
		plan: {
			id: "plan-1",
			userGroup: { id: 2, maxNetworks: 3 },
		},
		...overrides,
	};
}

function setup(
	input: {
		user?: EntitlementUserRecord | null;
		currentSubscription?: EntitlementSubscriptionRecord | null;
		latestSubscription?: EntitlementSubscriptionRecord | null;
		networkCount?: number;
	} = {},
) {
	const userFindUnique = jest.fn(async () => input.user ?? user());
	const subscriptionFindFirst = jest.fn(
		async (args: { where: Readonly<Record<string, unknown>> }) =>
			args.where.status === "ACTIVE"
				? (input.currentSubscription ?? null)
				: (input.latestSubscription ?? null),
	);
	const networkCount = jest.fn(
		async (_args: { where: { authorId: string; organizationId: null } }) =>
			input.networkCount ?? 0,
	);
	const prisma = {
		user: { findUnique: userFindUnique },
		subscription: { findFirst: subscriptionFindFirst },
		network: { count: networkCount },
	} as unknown as EntitlementPrisma;

	return {
		dependencies: { prisma, now: () => NOW },
		mocks: { userFindUnique, subscriptionFindFirst, networkCount },
	};
}

describe("billing entitlements", () => {
	test("ADMIN bypasses subscription and network quota checks", async () => {
		const { dependencies, mocks } = setup({
			user: user({ role: "ADMIN", userGroup: null }),
			networkCount: 999,
		});

		const quota = await assertNetworkQuota(dependencies, "user-1");

		expect(quota).toMatchObject({
			source: "ADMIN",
			hasActiveEntitlement: true,
			maxNetworks: null,
			remainingNetworks: null,
		});
		expect(mocks.subscriptionFindFirst).not.toHaveBeenCalled();
		expect(mocks.networkCount).not.toHaveBeenCalled();
	});

	test("uses immutable Subscription quota snapshots before the current plan group", async () => {
		const { dependencies } = setup({ currentSubscription: subscription() });

		const entitlement = await getEffectiveEntitlement(dependencies, "user-1");

		expect(entitlement).toMatchObject({
			source: "SUBSCRIPTION",
			maxNetworks: 8,
			groupId: 18,
			subscriptionId: "subscription-1",
		});
	});

	test("falls back to plan.userGroup when old Subscription snapshots are unavailable", async () => {
		const oldSubscription = subscription({
			maxNetworksSnapshot: null,
			userGroupIdSnapshot: null,
		});
		const { dependencies } = setup({ currentSubscription: oldSubscription });

		const entitlement = await getEffectiveEntitlement(dependencies, "user-1");

		expect(entitlement).toMatchObject({
			source: "SUBSCRIPTION",
			maxNetworks: 3,
			groupId: 2,
		});
	});

	test("legacy users with no Subscription fall back to their UserGroup", async () => {
		const { dependencies } = setup({
			user: user({
				userGroup: { id: 5, maxNetworks: 4, expiresAt: null },
			}),
		});

		const entitlement = await assertAccountActive(dependencies, "user-1");

		expect(entitlement).toMatchObject({
			source: "LEGACY_USER_GROUP",
			maxNetworks: 4,
			groupId: 5,
		});
	});

	test("preserves unlimited provisioning for legacy users without a group", async () => {
		const { dependencies } = setup({
			user: user({ legacyBillingExempt: true }),
		});

		await expect(assertNetworkQuota(dependencies, "user-1")).resolves.toMatchObject({
			source: "LEGACY_UNGROUPED",
			hasActiveEntitlement: true,
			maxNetworks: null,
			remainingNetworks: null,
		});
	});

	test("does not exempt newly created users without a group", async () => {
		const { dependencies } = setup();

		await expect(assertAccountActive(dependencies, "user-1")).rejects.toMatchObject({
			code: "NO_ACTIVE_ENTITLEMENT",
		});
	});

	test.each([
		["MANUAL", "ACCOUNT_MANUALLY_SUSPENDED"],
		["ADMIN", "ACCOUNT_MANUALLY_SUSPENDED"],
		["NONE", "ACCOUNT_INACTIVE"],
		["SUBSCRIPTION_EXPIRED", "SUBSCRIPTION_EXPIRED"],
	])("distinguishes inactive reason %s", async (reason, expectedCode) => {
		const { dependencies } = setup({
			user: user({ isActive: false, suspensionReason: reason }),
		});

		await expect(assertAccountActive(dependencies, "user-1")).rejects.toMatchObject({
			code: expectedCode,
		});
	});

	test("an expired Subscription never falls through to a legacy UserGroup", async () => {
		const expired = subscription({
			status: "EXPIRED",
			expiresAt: new Date("2026-07-13T00:00:00.000Z"),
		});
		const { dependencies } = setup({
			user: user({
				userGroup: { id: 5, maxNetworks: 100, expiresAt: null },
			}),
			latestSubscription: expired,
		});

		await expect(assertAccountActive(dependencies, "user-1")).rejects.toMatchObject({
			code: "SUBSCRIPTION_EXPIRED",
		});
	});

	test("an active Subscription overrides stale legacy expiration fields", async () => {
		const { dependencies } = setup({
			user: user({
				expiresAt: new Date("2026-07-13T00:00:00.000Z"),
				userGroup: {
					id: 5,
					maxNetworks: 100,
					expiresAt: new Date("2026-07-13T00:00:00.000Z"),
				},
			}),
			currentSubscription: subscription(),
		});

		await expect(getEffectiveEntitlement(dependencies, "user-1")).resolves.toMatchObject({
			source: "SUBSCRIPTION",
			maxNetworks: 8,
		});
	});

	test("enforces the personal network quota including the requested allocation", async () => {
		const { dependencies, mocks } = setup({
			currentSubscription: subscription({ maxNetworksSnapshot: 5 }),
			networkCount: 4,
		});

		await expect(assertNetworkQuota(dependencies, "user-1", 2)).rejects.toEqual(
			expect.objectContaining({
				code: "NETWORK_LIMIT_REACHED",
			}),
		);
		expect(mocks.networkCount).toHaveBeenCalledWith({
			where: { authorId: "user-1", organizationId: null },
		});
	});

	test("returns the remaining quota after a valid reservation", async () => {
		const { dependencies } = setup({
			currentSubscription: subscription({ maxNetworksSnapshot: 5 }),
			networkCount: 2,
		});

		const quota = await assertNetworkQuota(dependencies, "user-1", 2);

		expect(quota).toMatchObject({
			currentNetworks: 2,
			reservedNetworks: 0,
			requestedNetworks: 2,
			remainingNetworks: 1,
		});
	});
});

type ReservationRow = {
	id: string;
	userId: string;
	createdAt: Date;
	expiresAt: Date;
};

function setupReservationHarness(input: {
	networkCount: number;
	maxNetworks: number;
	reservations?: ReservationRow[];
}) {
	const reservations = [...(input.reservations ?? [])];
	let reservationSequence = reservations.length;
	let lockTail = Promise.resolve();
	const lockEvents: string[] = [];

	const baseTransaction = {
		user: { findUnique: jest.fn(async () => user()) },
		subscription: {
			findFirst: jest.fn(async (args: { where: Readonly<Record<string, unknown>> }) =>
				args.where.status === "ACTIVE"
					? subscription({ maxNetworksSnapshot: input.maxNetworks })
					: null,
			),
		},
		network: { count: jest.fn(async () => input.networkCount) },
		networkQuotaReservation: {
			count: jest.fn(
				async (args: { where: { userId: string; expiresAt: { gt: Date } } }) =>
					reservations.filter(
						(row) =>
							row.userId === args.where.userId &&
							row.expiresAt.getTime() > args.where.expiresAt.gt.getTime(),
					).length,
			),
			create: jest.fn(async (args: { data: { userId: string; expiresAt: Date } }) => {
				reservationSequence += 1;
				const row = {
					id: `reservation-${reservationSequence}`,
					userId: args.data.userId,
					createdAt: NOW,
					expiresAt: args.data.expiresAt,
				};
				reservations.push(row);
				return { id: row.id, expiresAt: row.expiresAt };
			}),
			deleteMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
				const before = reservations.length;
				const where = args.where as {
					id?: string;
					userId?: string;
					expiresAt?: { lte: Date };
				};
				for (let index = reservations.length - 1; index >= 0; index -= 1) {
					const row = reservations[index];
					if (!row) continue;
					const matchesId = where.id === undefined || row.id === where.id;
					const matchesUser = where.userId === undefined || row.userId === where.userId;
					const matchesExpiry =
						where.expiresAt === undefined ||
						row.expiresAt.getTime() <= where.expiresAt.lte.getTime();
					if (matchesId && matchesUser && matchesExpiry) reservations.splice(index, 1);
				}
				return { count: before - reservations.length };
			}),
		},
	};

	const prisma = {
		networkQuotaReservation: baseTransaction.networkQuotaReservation,
		$transaction: async <T>(
			operation: (transaction: NetworkQuotaReservationTransaction) => Promise<T>,
		) => {
			const previousLock = lockTail;
			let releaseLock: () => void = () => undefined;
			lockTail = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			const transaction = {
				...baseTransaction,
				$queryRaw: jest.fn(async () => {
					await previousLock;
					lockEvents.push("locked");
					return [{ id: "user-1" }];
				}),
			} as unknown as NetworkQuotaReservationTransaction;
			try {
				return await operation(transaction);
			} finally {
				releaseLock();
			}
		},
	} as NetworkQuotaReservationPrisma;

	return { prisma, reservations, lockEvents };
}

describe("network quota reservations", () => {
	test("serializes concurrent allocations so only one can claim the last slot", async () => {
		const harness = setupReservationHarness({ networkCount: 4, maxNetworks: 5 });

		const results = await Promise.allSettled([
			reserveNetworkQuota({ prisma: harness.prisma, now: () => NOW }, "user-1"),
			reserveNetworkQuota({ prisma: harness.prisma, now: () => NOW }, "user-1"),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ code: "NETWORK_LIMIT_REACHED" }),
		});
		expect(harness.reservations).toHaveLength(1);
		expect(harness.lockEvents).toEqual(["locked", "locked"]);
	});

	test("removes explicit and expired reservations idempotently", async () => {
		const harness = setupReservationHarness({
			networkCount: 0,
			maxNetworks: 2,
			reservations: [
				{
					id: "expired",
					userId: "other-user",
					createdAt: NOW,
					expiresAt: new Date(NOW.getTime() - 1),
				},
			],
		});
		const reservation = await reserveNetworkQuota(
			{ prisma: harness.prisma, now: () => NOW, reservationTtlMs: 1000 },
			"user-1",
		);

		expect(reservation.expiresAt).toEqual(new Date(NOW.getTime() + 1000));
		await expect(
			cleanupExpiredNetworkQuotaReservations(harness.prisma, NOW),
		).resolves.toBe(1);
		await expect(
			releaseNetworkQuotaReservation(harness.prisma, reservation.id),
		).resolves.toBe(1);
		await expect(
			releaseNetworkQuotaReservation(harness.prisma, reservation.id),
		).resolves.toBe(0);
		expect(harness.reservations).toEqual([]);
	});

	test("rechecks quota when an expired reservation is consumed", async () => {
		const harness = setupReservationHarness({ networkCount: 4, maxNetworks: 5 });
		const expiredClaim = await reserveNetworkQuota(
			{ prisma: harness.prisma, now: () => NOW },
			"user-1",
		);
		await releaseNetworkQuotaReservation(harness.prisma, expiredClaim.id);
		await reserveNetworkQuota({ prisma: harness.prisma, now: () => NOW }, "user-1");
		const operation = jest.fn(async () => "stored");

		await expect(
			consumeNetworkQuotaReservation(
				{ prisma: harness.prisma, now: () => NOW },
				"user-1",
				expiredClaim.id as string,
				operation,
			),
		).rejects.toMatchObject({ code: "NETWORK_LIMIT_REACHED" });
		expect(operation).not.toHaveBeenCalled();
		expect(harness.reservations).toHaveLength(1);
	});
});
