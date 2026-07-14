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
	// Check for individually expired users
	const expUsers = await prisma.user.findMany({
		where: {
			expiresAt: {
				lte: now,
			},
			isActive: true,
			NOT: {
				role: "ADMIN",
			},
			// Once billing has created a Subscription, only the subscription
			// suspension workflow owns expiration for that account.
			subscription: { is: null },
		},
		select: {
			network: true,
			id: true,
			role: true,
		},
	});

	// Check for users in expired groups
	const usersInExpiredGroups = await prisma.user.findMany({
		where: {
			isActive: true,
			NOT: {
				role: "ADMIN",
			},
			subscription: { is: null },
			userGroup: {
				expiresAt: {
					lte: now,
				},
			},
		},
		select: {
			network: true,
			id: true,
			role: true,
			userGroup: {
				select: {
					name: true,
					expiresAt: true,
				},
			},
		},
	});

	// Combine both expired user types (need to type them properly)
	const allExpiredUsers = new Map<
		string,
		{
			network: Array<{ nwid: string }>;
			id: string;
			role: string;
			userGroup?: {
				name: string;
				expiresAt: Date | null;
			} | null;
		}
	>();
	for (const user of expUsers) {
		allExpiredUsers.set(user.id, { ...user, userGroup: undefined });
	}
	for (const user of usersInExpiredGroups) {
		allExpiredUsers.set(user.id, user);
	}

	// if no users return
	if (allExpiredUsers.size === 0) return 0;

	for (const userObj of allExpiredUsers.values()) {
		if (userObj.role === "ADMIN") continue;

		const context: FakeContext = {
			session: {
				user: {
					id: userObj.id,
				},
			},
		};

		// Deauthorize all network members for this user
		for (const network of userObj.network) {
			try {
				const members = await ztController.network_members(
					// @ts-ignore
					context,
					network.nwid,
					false,
				);
				for (const member in members) {
					const ctx = {
						session: {
							user: {
								id: userObj.id,
							},
						},
					};
					await ztController.member_update({
						// @ts-ignore
						ctx,
						nwid: network.nwid,
						central: false,
						memberId: member,
						updateParams: {
							authorized: false,
						},
					});
				}
			} catch (error) {
				// Continue with other networks if one fails
				console.error(
					`Failed to deauthorize members for network ${network.nwid}:`,
					error,
				);
			}
		}

		// update user isActive to false
		await prisma.user.update({
			where: {
				id: userObj.id,
			},
			data: {
				isActive: false,
			},
		});
	}

	return allExpiredUsers.size;
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
