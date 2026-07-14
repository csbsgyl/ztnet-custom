import { TRPCError } from "@trpc/server";

jest.mock("~/utils/ztApi", () => ({
	network_create: jest.fn(),
}));
jest.mock("~/utils/IPv4gen", () => ({
	IPv4gen: jest.fn(() => ({
		routes: [{ target: "10.10.0.0/16", via: null }],
		ipAssignmentPools: [{ ipRangeStart: "10.10.0.1", ipRangeEnd: "10.10.255.254" }],
	})),
}));

import { networkProvisioningFactory } from "~/server/api/services/networkService";
import * as ztController from "~/utils/ztApi";

type Reservation = { id: string; userId: string; expiresAt: Date };

function createHarness(
	options: {
		userActive?: boolean;
		suspensionReason?: string;
		maxNetworks?: number;
		networkCount?: number;
	} = {},
) {
	const reservations: Reservation[] = [];
	const userRecord = {
		id: "user-1",
		role: "USER",
		isActive: options.userActive ?? true,
		suspensionReason: options.suspensionReason ?? "NONE",
		expiresAt: null,
		userGroup: null,
	};
	const activeSubscription = {
		id: "subscription-1",
		userId: "user-1",
		status: "ACTIVE",
		startsAt: new Date("2026-07-01T00:00:00.000Z"),
		expiresAt: new Date("2099-08-01T00:00:00.000Z"),
		maxNetworksSnapshot: options.maxNetworks ?? 2,
		userGroupIdSnapshot: 7,
		plan: { id: "plan-1", userGroup: { id: 7, maxNetworks: 2 } },
	};
	const deleteMany = jest.fn(async (args: { where: Record<string, unknown> }) => {
		const before = reservations.length;
		const where = args.where as {
			id?: string;
			userId?: string;
			expiresAt?: { lte: Date };
		};
		for (let index = reservations.length - 1; index >= 0; index -= 1) {
			const reservation = reservations[index];
			if (!reservation) continue;
			if (where.id && reservation.id !== where.id) continue;
			if (where.userId && reservation.userId !== where.userId) continue;
			if (
				where.expiresAt &&
				reservation.expiresAt.getTime() > where.expiresAt.lte.getTime()
			) {
				continue;
			}
			reservations.splice(index, 1);
		}
		return { count: before - reservations.length };
	});
	const reservationDelegate = {
		deleteMany,
		count: jest.fn(async () => reservations.length),
		create: jest.fn(async (args: { data: { userId: string; expiresAt: Date } }) => {
			const reservation = {
				id: "reservation-1",
				userId: args.data.userId,
				expiresAt: args.data.expiresAt,
			};
			reservations.push(reservation);
			return { id: reservation.id, expiresAt: reservation.expiresAt };
		}),
	};
	const commonDelegates = {
		user: {
			findUnique: jest.fn(async () => userRecord),
			update: jest.fn(async () => ({ id: "user-1" })),
		},
		subscription: {
			findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
				args.where.status === "ACTIVE" ? activeSubscription : activeSubscription,
			),
		},
		network: {
			count: jest.fn(async () => options.networkCount ?? 0),
			findMany: jest.fn(
				async (_args: {
					where: { authorId: string; organizationId: null };
					select: { routes: true };
				}) => [],
			),
		},
		networkQuotaReservation: reservationDelegate,
	};
	const transaction = {
		...commonDelegates,
		$queryRaw: jest.fn(async () => [{ id: "user-1" }]),
	};
	const prisma = {
		...commonDelegates,
		$transaction: jest.fn(async (operation: (tx: typeof transaction) => unknown) =>
			operation(transaction),
		),
	};

	return {
		ctx: {
			prisma,
			session: { user: { id: "user-1" } },
		},
		prisma,
		transaction,
		reservations,
	};
}

describe("networkProvisioningFactory billing quota", () => {
	test("reserves quota for a personal local network and releases it after success", async () => {
		const harness = createHarness();
		jest.mocked(ztController.network_create).mockResolvedValue({
			nwid: "local-network-1",
			name: "Local network",
		} as never);

		await expect(
			networkProvisioningFactory({
				ctx: harness.ctx,
				input: { central: false, name: "Local network" },
			}),
		).resolves.toMatchObject({ nwid: "local-network-1" });

		expect(harness.prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(harness.transaction.$queryRaw).toHaveBeenCalledTimes(2);
		expect(harness.transaction.networkQuotaReservation.create).toHaveBeenCalledTimes(1);
		expect(harness.reservations).toEqual([]);
		expect(harness.prisma.network.findMany).toHaveBeenCalledWith({
			where: { authorId: "user-1", organizationId: null },
			select: { routes: true },
		});
		expect(harness.prisma.user.update).toHaveBeenCalledTimes(1);
	});

	test("releases quota when controller creation fails", async () => {
		const harness = createHarness();
		const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
		jest
			.mocked(ztController.network_create)
			.mockRejectedValue(new Error("controller down"));

		await expect(
			networkProvisioningFactory({
				ctx: harness.ctx,
				input: { central: false, name: "Local network" },
			}),
		).rejects.toBeInstanceOf(TRPCError);

		expect(harness.reservations).toEqual([]);
		expect(harness.prisma.user.update).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	test("does not reserve or count quota for a Central network", async () => {
		const harness = createHarness({ networkCount: 999 });
		jest.mocked(ztController.network_create).mockResolvedValue({
			nwid: "central-network-1",
			name: "Central network",
		} as never);

		await networkProvisioningFactory({
			ctx: harness.ctx,
			input: { central: true, name: "Central network" },
		});

		expect(harness.prisma.$transaction).not.toHaveBeenCalled();
		expect(harness.prisma.user.findUnique).not.toHaveBeenCalled();
		expect(harness.prisma.subscription.findFirst).not.toHaveBeenCalled();
		expect(harness.prisma.network.count).not.toHaveBeenCalled();
		expect(harness.prisma.user.update).not.toHaveBeenCalled();
		expect(harness.reservations).toEqual([]);
	});

	test("does not apply billing entitlement checks to a Central network", async () => {
		const harness = createHarness({
			userActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		});
		jest.mocked(ztController.network_create).mockResolvedValue({
			nwid: "central-network-2",
			name: "Central network",
		} as never);

		await expect(
			networkProvisioningFactory({
				ctx: harness.ctx,
				input: { central: true, name: "Central network" },
			}),
		).resolves.toMatchObject({ nwid: "central-network-2" });
		expect(harness.prisma.user.findUnique).not.toHaveBeenCalled();
		expect(harness.prisma.subscription.findFirst).not.toHaveBeenCalled();
	});
});
