import type { PrismaClient } from "@prisma/client";
import { SUBSCRIPTION_EXPIRED_REASON } from "./entitlements";

export interface AdminPlanAssignmentInput {
	userId: string;
	planId: string;
	expiresAt: Date;
	performedById: string;
	note?: string;
	now?: Date;
}

export interface AdminPlanAssignmentResult {
	userId: string;
	planId: string;
	planName: string;
	userGroupId: number;
	maxNetworks: number;
	expiresAt: Date;
	subscriptionId: string;
	needsRestoration: boolean;
}

function isExpired(date: Date | null | undefined, now: Date): boolean {
	return Boolean(date && date.getTime() <= now.getTime());
}

/**
 * Replaces a user's effective subscription with an administrator-selected plan
 * and exact expiration. The shared billing-user lock serializes this operation
 * with payment fulfilment and expiration suspension.
 */
export async function assignAdminPlanWithExpiration(
	prisma: PrismaClient,
	input: AdminPlanAssignmentInput,
): Promise<AdminPlanAssignmentResult> {
	const now = input.now ?? new Date();
	if (
		!Number.isFinite(input.expiresAt.getTime()) ||
		input.expiresAt.getTime() <= now.getTime()
	) {
		throw new Error("The plan expiration must be a future date.");
	}

	return prisma.$transaction(
		async (transaction) => {
			const userLockKey = `billing-user:${input.userId}`;
			await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;

			const [user, plan, existingSubscription, pendingSuspensions, unsettledOrder] =
				await Promise.all([
					transaction.user.findUnique({
						where: { id: input.userId },
						select: {
							id: true,
							role: true,
							isActive: true,
							suspensionReason: true,
							expiresAt: true,
							userGroup: { select: { expiresAt: true } },
						},
					}),
					transaction.billingPlan.findUnique({
						where: { id: input.planId },
						include: { userGroup: { select: { id: true, maxNetworks: true } } },
					}),
					transaction.subscription.findUnique({ where: { userId: input.userId } }),
					transaction.subscriptionSuspensionSnapshot.count({
						where: {
							userId: input.userId,
							wasAuthorized: true,
							suspendedAt: null,
							restoredAt: null,
						},
					}),
					transaction.billingOrder.findFirst({
						where: {
							userId: input.userId,
							OR: [{ status: "PENDING" }, { status: "PAID", entitlementAppliedAt: null }],
						},
						select: { id: true },
					}),
				]);

			if (!user) throw new Error("User not found.");
			if (user.role === "ADMIN") {
				throw new Error("Administrator accounts do not need plans.");
			}
			if (!plan) throw new Error("Billing plan not found.");
			if (!plan.isActive && existingSubscription?.planId !== plan.id) {
				throw new Error("Archived plans cannot be newly assigned.");
			}
			if (
				!Number.isInteger(plan.userGroup.maxNetworks) ||
				plan.userGroup.maxNetworks < 0
			) {
				throw new Error("The selected plan has an invalid network limit.");
			}
			if (pendingSuspensions > 0) {
				throw new Error(
					"Subscription suspension is still in progress. Retry after the expiration check completes.",
				);
			}
			if (unsettledOrder) {
				throw new Error(
					"The user has an unpaid or unfulfilled order. Complete or cancel it before assigning a plan.",
				);
			}

			const legacyExpirationSuspension =
				!user.isActive &&
				user.suspensionReason === "NONE" &&
				(isExpired(user.expiresAt, now) ||
					isExpired(user.userGroup?.expiresAt, now) ||
					isExpired(existingSubscription?.expiresAt, now));
			const needsRestoration =
				user.suspensionReason === SUBSCRIPTION_EXPIRED_REASON ||
				legacyExpirationSuspension;
			const keepsCurrentTerm =
				existingSubscription?.status === "ACTIVE" &&
				existingSubscription.startsAt.getTime() <= now.getTime() &&
				existingSubscription.expiresAt.getTime() > now.getTime();
			const startsAt = keepsCurrentTerm ? existingSubscription.startsAt : now;

			const subscription = await transaction.subscription.upsert({
				where: { userId: user.id },
				create: {
					userId: user.id,
					planId: plan.id,
					status: "ACTIVE",
					startsAt,
					expiresAt: input.expiresAt,
					maxNetworksSnapshot: plan.userGroup.maxNetworks,
					userGroupIdSnapshot: plan.userGroup.id,
					planPriceCentsSnapshot: plan.priceCents,
					durationMonthsSnapshot: plan.durationMonths,
					planLevelSnapshot: plan.level,
				},
				update: {
					planId: plan.id,
					status: "ACTIVE",
					startsAt,
					expiresAt: input.expiresAt,
					maxNetworksSnapshot: plan.userGroup.maxNetworks,
					userGroupIdSnapshot: plan.userGroup.id,
					planPriceCentsSnapshot: plan.priceCents,
					durationMonthsSnapshot: plan.durationMonths,
					planLevelSnapshot: plan.level,
				},
				select: { id: true },
			});
			if (legacyExpirationSuspension) {
				const legacyMembers = await transaction.network_members.findMany({
					where: {
						authorized: true,
						deleted: false,
						permanentlyDeleted: false,
						nwid_ref: { authorId: user.id, organizationId: null },
					},
					select: { id: true, nwid: true },
				});
				const suspendedAt =
					existingSubscription?.expiresAt ??
					user.expiresAt ??
					user.userGroup?.expiresAt ??
					now;
				await Promise.all(
					legacyMembers.map((member) =>
						transaction.subscriptionSuspensionSnapshot.upsert({
							where: {
								userId_networkId_memberId: {
									userId: user.id,
									networkId: member.nwid,
									memberId: member.id,
								},
							},
							create: {
								userId: user.id,
								subscriptionId: subscription.id,
								networkId: member.nwid,
								memberId: member.id,
								wasAuthorized: true,
								suspendedAt,
							},
							update: {
								subscriptionId: subscription.id,
								wasAuthorized: true,
								suspendedAt,
								restoredAt: null,
								lastError: null,
							},
						}),
					),
				);
			}

			await transaction.user.update({
				where: { id: user.id },
				data: {
					userGroupId: plan.userGroup.id,
					expiresAt: input.expiresAt,
					legacyBillingExempt: false,
					...(needsRestoration
						? { isActive: false, suspensionReason: SUBSCRIPTION_EXPIRED_REASON }
						: {}),
				},
			});

			const note = input.note?.trim();
			await transaction.activityLog.create({
				data: {
					performedById: input.performedById,
					action: `Assigned plan "${plan.name}" to user ${user.id} until ${input.expiresAt.toISOString()}${note ? `: ${note}` : ""}`,
				},
			});

			return {
				userId: user.id,
				planId: plan.id,
				planName: plan.name,
				userGroupId: plan.userGroup.id,
				maxNetworks: plan.userGroup.maxNetworks,
				expiresAt: input.expiresAt,
				subscriptionId: subscription.id,
				needsRestoration,
			};
		},
		{ isolationLevel: "Serializable" },
	);
}
