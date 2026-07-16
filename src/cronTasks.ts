import * as cron from "cron";
import { prisma } from "./server/db";
import * as ztController from "~/utils/ztApi";

import { reconcileNetworkMembers } from "~/server/api/services/memberService";
import {
	reconcileExpiredSubscriptions,
	type ControllerUpdateInput,
	type SuspensionPrisma,
} from "~/server/billing/suspension";
import { cleanupExpiredNetworkQuotaReservations } from "~/server/billing/entitlements";
import { getAlipayRuntimeConfig } from "~/server/billing/config";
import { queryAndReconcileAlipayOrder } from "~/server/billing/payment";
import { fulfilPaidOrder } from "~/server/billing/runtime";
import { disconnectUserSockets } from "~/server/socketRegistry";
import {
	MANUAL_SUSPENSION_REASON,
	SUBSCRIPTION_EXPIRED_REASON,
} from "~/server/billing/entitlements";

type FakeContext = {
	session: {
		user: {
			id: string;
		};
	};
};

/**
 * Checks for expired users and deactivates them.
 * This includes both individually expired users and users in expired groups.
 * Returns the number of users that were deactivated.
 */
export const checkAndDeactivateExpiredUsers = async (
	now = new Date(),
): Promise<number> => {
	const candidates = await prisma.user.findMany({
		where: {
			role: { not: "ADMIN" },
			subscription: { is: null },
			AND: [
				{
					OR: [{ expiresAt: { lte: now } }, { userGroup: { expiresAt: { lte: now } } }],
				},
				{
					OR: [
						{ isActive: true },
						{
							isActive: false,
							suspensionReason: SUBSCRIPTION_EXPIRED_REASON,
							suspensionSnapshots: {
								some: {
									subscriptionId: null,
									wasAuthorized: true,
									suspendedAt: null,
									restoredAt: null,
								},
							},
						},
					],
				},
			],
		},
		select: { id: true },
	});
	let processed = 0;
	for (const candidate of candidates) {
		const prepared = await prisma.$transaction(async (transaction) => {
			const userLockKey = `billing-user:${candidate.id}`;
			await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
			const user = await transaction.user.findUnique({
				where: { id: candidate.id },
				select: {
					id: true,
					role: true,
					isActive: true,
					suspensionReason: true,
					expiresAt: true,
					userGroup: { select: { expiresAt: true } },
					subscription: { select: { id: true } },
					network: {
						select: {
							nwid: true,
							networkMembers: {
								where: {
									authorized: true,
									deleted: false,
									permanentlyDeleted: false,
								},
								select: { id: true },
							},
						},
					},
				},
			});
			if (!user || user.role === "ADMIN" || user.subscription) return null;
			if (
				user.suspensionReason === MANUAL_SUSPENSION_REASON ||
				user.suspensionReason === "ADMIN"
			) {
				return null;
			}
			const expired =
				Boolean(user.expiresAt && user.expiresAt <= now) ||
				Boolean(user.userGroup?.expiresAt && user.userGroup.expiresAt <= now);
			if (!expired) return null;
			if (!user.isActive && user.suspensionReason !== SUBSCRIPTION_EXPIRED_REASON) {
				return null;
			}

			for (const network of user.network) {
				for (const member of network.networkMembers) {
					await transaction.subscriptionSuspensionSnapshot.upsert({
						where: {
							userId_networkId_memberId: {
								userId: user.id,
								networkId: network.nwid,
								memberId: member.id,
							},
						},
						create: {
							userId: user.id,
							networkId: network.nwid,
							memberId: member.id,
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
				}
			}

			const pending = await transaction.subscriptionSuspensionSnapshot.findMany({
				where: {
					userId: user.id,
					subscriptionId: null,
					wasAuthorized: true,
					suspendedAt: null,
					restoredAt: null,
				},
				select: { id: true, networkId: true, memberId: true },
			});
			await transaction.user.update({
				where: { id: user.id },
				data: {
					isActive: false,
					suspensionReason: SUBSCRIPTION_EXPIRED_REASON,
				},
			});
			await transaction.aPIToken.updateMany({
				where: { userId: user.id, isActive: true },
				data: { isActive: false },
			});
			await transaction.session.deleteMany({ where: { userId: user.id } });
			return { userId: user.id, pending };
		});
		if (!prepared) continue;
		processed += 1;
		disconnectUserSockets(prepared.userId);

		for (const snapshot of prepared.pending) {
			try {
				const context: FakeContext = {
					session: { user: { id: prepared.userId } },
				};
				await ztController.member_update({
					ctx: context as never,
					nwid: snapshot.networkId,
					central: false,
					memberId: snapshot.memberId,
					updateParams: { authorized: false },
				});
				await prisma.network_members.updateMany({
					where: { id: snapshot.memberId, nwid: snapshot.networkId },
					data: { authorized: false },
				});
				await prisma.subscriptionSuspensionSnapshot.update({
					where: { id: snapshot.id },
					data: { suspendedAt: now, lastError: null },
				});
			} catch (error) {
				await prisma.subscriptionSuspensionSnapshot.update({
					where: { id: snapshot.id },
					data: {
						lastError: error instanceof Error ? error.message : String(error),
					},
				});
				console.error(
					`Failed to deauthorize member ${snapshot.memberId} in network ${snapshot.networkId}:`,
					error,
				);
			}
		}
	}

	return processed;
};

async function updateSubscriptionMember({
	userId,
	networkId,
	memberId,
	authorized,
}: ControllerUpdateInput): Promise<unknown> {
	const context: FakeContext = { session: { user: { id: userId } } };
	const result = await ztController.member_update({
		ctx: context as never,
		nwid: networkId,
		memberId,
		central: false,
		updateParams: { authorized },
	});

	// The controller is the source of truth, but the local member cache is read
	// by the UI and must move only after the controller mutation succeeds.
	await prisma.network_members.updateMany({
		where: { id: memberId, nwid: networkId },
		data: { authorized },
	});

	return result;
}

export interface ExpirationMaintenanceResult {
	subscriptions: Awaited<ReturnType<typeof reconcileExpiredSubscriptions>>;
	legacyUsersDeactivated: number;
	expiredReservationsDeleted: number;
	pendingBillingOrdersClosed: number;
	billingOrdersReconciled: number;
}

let expirationMaintenanceRun: Promise<ExpirationMaintenanceResult> | null = null;

/** Runs the billing expiration workflow and the pre-billing compatibility path. */
export const runExpirationMaintenance = async (
	now = new Date(),
): Promise<ExpirationMaintenanceResult> => {
	const subscriptions = await reconcileExpiredSubscriptions(
		{
			prisma: prisma as unknown as SuspensionPrisma,
			controllerUpdate: updateSubscriptionMember,
			now: () => now,
		},
		{ batchSize: 100 },
	);
	const legacyUsersDeactivated = await checkAndDeactivateExpiredUsers(now);
	const expiredReservationsDeleted = await cleanupExpiredNetworkQuotaReservations(
		prisma,
		now,
	);
	let billingOrdersReconciled = 0;
	let pendingBillingOrdersClosed = 0;
	const paidOrders = await prisma.billingOrder.findMany({
		where: { status: "PAID" },
		select: { id: true, merchantOrderNo: true },
		orderBy: { paidAt: "asc" },
		take: 100,
	});
	for (const order of paidOrders) {
		try {
			await fulfilPaidOrder(prisma, order.merchantOrderNo);
			billingOrdersReconciled += 1;
		} catch (error) {
			console.error(`Failed to fulfil paid billing order ${order.id}:`, error);
		}
	}

	const pendingOrders = await prisma.billingOrder.findMany({
		where: {
			source: "SELF_SERVICE",
			status: "PENDING",
			expiresAt: { lte: now },
		},
		select: { id: true },
		orderBy: { createdAt: "asc" },
		take: 100,
	});
	if (pendingOrders.length > 0) {
		try {
			const billingOptions = await prisma.globalOptions.findUnique({ where: { id: 1 } });
			const alipayConfig = getAlipayRuntimeConfig(billingOptions, {
				requireEnabled: false,
			});
			for (const order of pendingOrders) {
				try {
					const result = await queryAndReconcileAlipayOrder({
						prisma,
						config: alipayConfig,
						orderId: order.id,
					});
					if (
						result.state === "FULFILLED" ||
						result.state === "FAILED" ||
						result.state === "CLOSED"
					) {
						billingOrdersReconciled += 1;
						if (result.state === "CLOSED") pendingBillingOrdersClosed += 1;
					} else {
						const closed = await prisma.billingOrder.updateMany({
							where: { id: order.id, status: "PENDING" },
							data: { status: "CLOSED", closedAt: now },
						});
						pendingBillingOrdersClosed += closed.count;
					}
				} catch (error) {
					console.error(`Failed to reconcile billing order ${order.id}:`, error);
				}
			}
		} catch (error) {
			console.error("Alipay reconciliation is not configured correctly:", error);
		}
	}
	return {
		subscriptions,
		legacyUsersDeactivated,
		expiredReservationsDeleted,
		pendingBillingOrdersClosed,
		billingOrdersReconciled,
	};
};

export function runExpirationMaintenanceOnce(
	now = new Date(),
): Promise<ExpirationMaintenanceResult> {
	if (expirationMaintenanceRun) return expirationMaintenanceRun;
	expirationMaintenanceRun = runExpirationMaintenance(now).finally(() => {
		expirationMaintenanceRun = null;
	});
	return expirationMaintenanceRun;
}

export const CheckExpiredUsers = async () => {
	new cron.CronJob(
		"* * * * *", // every minute
		async () => {
			try {
				await runExpirationMaintenanceOnce();
			} catch (error) {
				console.error("Error in CheckExpiredUsers cron job:", error);
			}
		},
		null,
		true,
		"America/Los_Angeles",
	);
};

/**
 * Updates the peers for all active users and their networks.
 * This function is scheduled to run periodically using a cron job.
 *
 * Run every 5 minutes and if user is offline. There is no reason to update if the user is online.
 * https://github.com/sinamics/ztnet/issues/313
 */
export const updatePeers = async () => {
	new cron.CronJob(
		// updates every 5 minutes

		// "*/10 * * * * *", // every 10 seconds ( testing )
		// Backstop only: viewed networks are synced every ~10s by the SyncManager
		// (Socket.IO subscription-driven). Idle networks reconcile every 10 min here.
		"*/10 * * * *", // every 10min
		async () => {
			try {
				// fetch all users
				const users = await prisma.user.findMany({
					where: {
						isActive: true,
					},
					select: {
						id: true,
						lastseen: true,
						memberOfOrgs: {
							select: {
								networks: true,
							},
						},
					},
				});

				// if no users return
				if (users.length === 0) return;

				// Get all users that have been inactive for 5 minutes
				const now = new Date();
				const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000);
				const inactiveUsers = users.filter((user) => {
					return user?.lastseen && new Date(user.lastseen) < fiveMinutesAgo;
				});

				// keep track of processed networks
				const processedNetworks = new Set();

				// fetch all networks for each user
				for (const user of inactiveUsers) {
					const networks = await prisma.network.findMany({
						where: {
							authorId: user.id,
						},
						select: {
							nwid: true,
						},
					});

					// include get organization networks
					const organizationNetworks = user.memberOfOrgs?.flatMap((org) =>
						org.networks.map((network) => ({
							nwid: network.nwid,
						})),
					);

					// merge user and organization networks
					const allNetworks = [...networks, ...organizationNetworks];

					// if no networks return
					if (allNetworks.length === 0) return;

					// fetch all members for each network
					for (const network of allNetworks) {
						if (network && !processedNetworks.has(network.nwid)) {
							processedNetworks.add(network.nwid);
							const context: FakeContext = {
								session: {
									user: {
										id: user.id,
									},
								},
							};

							// Reconcile members against the controller (revision-delta +
							// self-healing). Replaces the old per-member N+1 fetch + write storm,
							// and serves as the periodic backstop that keeps idle networks' caches
							// converged with the controller.
							await reconcileNetworkMembers(
								// @ts-expect-error fake context for the cron
								context,
								network.nwid,
							);
						}
					}
				}
			} catch (error) {
				console.error("cron task updatePeers:", error);
			}
		},
		null,
		true,
		"America/Los_Angeles",
	);
};
