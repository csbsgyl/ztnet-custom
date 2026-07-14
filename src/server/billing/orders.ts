import { randomBytes } from "node:crypto";
import type { BillingOrderSource, Prisma, PrismaClient } from "@prisma/client";

export const ORDER_TTL_MS = 15 * 60 * 1000;
const AVERAGE_BILLING_MONTH_MS = 2_629_746_000;

export type BillingDatabase = PrismaClient | Prisma.TransactionClient;

export function createMerchantOrderNo(now = new Date()): string {
	const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
	return `ZT${timestamp}${randomBytes(8).toString("hex").toUpperCase()}`;
}

export function centsToAlipayAmount(cents: number): string {
	if (!Number.isSafeInteger(cents) || cents < 0) {
		throw new Error("Amount must be a non-negative integer in cents.");
	}
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function alipayAmountToCents(amount: string): number {
	if (!/^(0|[1-9]\d*)\.\d{2}$/.test(amount)) {
		throw new Error("Alipay amount must have exactly two decimal places.");
	}
	const [yuan, fraction] = amount.split(".");
	const cents = Number(yuan) * 100 + Number(fraction);
	if (!Number.isSafeInteger(cents)) throw new Error("Alipay amount is too large.");
	return cents;
}

export function addBillingMonths(date: Date, months: number): Date {
	if (!Number.isInteger(months) || months < 1 || months > 120) {
		throw new Error("Billing duration must be between 1 and 120 months.");
	}

	const result = new Date(date);
	const originalDay = result.getUTCDate();
	result.setUTCDate(1);
	result.setUTCMonth(result.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
	).getUTCDate();
	result.setUTCDate(Math.min(originalDay, lastDay));
	return result;
}

export function calculateUpgradeAmountCents({
	now,
	expiresAt,
	currentPriceCents,
	currentDurationMonths,
	targetPriceCents,
	targetDurationMonths,
}: {
	now: Date;
	expiresAt: Date;
	currentPriceCents: number;
	currentDurationMonths: number;
	targetPriceCents: number;
	targetDurationMonths: number;
}): number {
	if (expiresAt <= now) return 0;
	for (const value of [
		currentPriceCents,
		currentDurationMonths,
		targetPriceCents,
		targetDurationMonths,
	]) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error("Plan pricing must use positive safe integers.");
		}
	}

	const monthlyDifferenceNumerator =
		BigInt(targetPriceCents) * BigInt(currentDurationMonths) -
		BigInt(currentPriceCents) * BigInt(targetDurationMonths);
	if (monthlyDifferenceNumerator <= BigInt(0)) return 0;

	const numerator =
		monthlyDifferenceNumerator * BigInt(expiresAt.getTime() - now.getTime());
	const denominator =
		BigInt(currentDurationMonths) *
		BigInt(targetDurationMonths) *
		BigInt(AVERAGE_BILLING_MONTH_MS);
	const cents = (numerator + denominator - BigInt(1)) / denominator;
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("Calculated upgrade amount is too large.");
	}
	return Number(cents);
}

export async function createPendingOrder({
	db,
	userId,
	planId,
	source = "SELF_SERVICE",
	durationMonths,
	amountCents,
	adminNote,
	now = new Date(),
}: {
	db: BillingDatabase;
	userId: string;
	planId: string;
	source?: BillingOrderSource;
	durationMonths?: number;
	amountCents?: number;
	adminNote?: string | null;
	now?: Date;
}) {
	const [user, plan, subscription] = await Promise.all([
		db.user.findUnique({
			where: { id: userId },
			select: { id: true, isActive: true, role: true },
		}),
		db.billingPlan.findUnique({
			where: { id: planId },
			include: { userGroup: { select: { maxNetworks: true } } },
		}),
		db.subscription.findUnique({
			where: { userId },
			select: {
				status: true,
				expiresAt: true,
				planPriceCentsSnapshot: true,
				durationMonthsSnapshot: true,
				planLevelSnapshot: true,
			},
		}),
	]);

	if (!user) throw new Error("User not found.");
	if (user.role === "ADMIN") throw new Error("Administrator accounts do not need plans.");
	if (!user.isActive && source === "SELF_SERVICE") {
		throw new Error("Inactive users cannot create self-service orders.");
	}
	if (!plan?.isActive && source === "SELF_SERVICE") {
		throw new Error("This plan is not available.");
	}
	if (!plan) throw new Error("Billing plan not found.");
	if (
		source === "SELF_SERVICE" &&
		subscription?.status === "ACTIVE" &&
		plan.level < subscription.planLevelSnapshot
	) {
		throw new Error("Self-service plan downgrades are not allowed.");
	}
	const orderDurationMonths = durationMonths ?? plan.durationMonths;
	if (
		!Number.isInteger(orderDurationMonths) ||
		orderDurationMonths < 1 ||
		orderDurationMonths > 120
	) {
		throw new Error("Billing duration must be between 1 and 120 months.");
	}

	let upgradeAmountCents = 0;
	if (
		source === "SELF_SERVICE" &&
		subscription?.status === "ACTIVE" &&
		subscription.expiresAt > now &&
		plan.level > subscription.planLevelSnapshot
	) {
		upgradeAmountCents = calculateUpgradeAmountCents({
			now,
			expiresAt: subscription.expiresAt,
			currentPriceCents: subscription.planPriceCentsSnapshot,
			currentDurationMonths: subscription.durationMonthsSnapshot,
			targetPriceCents: plan.priceCents,
			targetDurationMonths: plan.durationMonths,
		});
	}
	const baseAmountCents = amountCents ?? plan.priceCents;
	if (!Number.isSafeInteger(baseAmountCents) || baseAmountCents < 0) {
		throw new Error("Order amount must be a non-negative integer in cents.");
	}
	const totalAmountCents = baseAmountCents + upgradeAmountCents;
	if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents < 1) {
		if (source === "SELF_SERVICE") {
			throw new Error("Self-service orders must have a positive amount.");
		}
	}

	return db.billingOrder.create({
		data: {
			merchantOrderNo: createMerchantOrderNo(now),
			userId,
			planId: plan.id,
			status: "PENDING",
			source,
			amountCents: totalAmountCents,
			currency: "CNY",
			subject: `${plan.name} - ${orderDurationMonths} month(s)`,
			planNameSnapshot: plan.name,
			planPriceCentsSnapshot: plan.priceCents,
			durationMonthsSnapshot: orderDurationMonths,
			planLevelSnapshot: plan.level,
			maxNetworksSnapshot: plan.userGroup.maxNetworks,
			userGroupIdSnapshot: plan.userGroupId,
			baseAmountCentsSnapshot: baseAmountCents,
			upgradeAmountCentsSnapshot: upgradeAmountCents,
			adminNote: source === "MANUAL_ADMIN" ? adminNote?.trim() || null : null,
			expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
		},
	});
}

export async function applyPaidOrder(
	db: BillingDatabase,
	merchantOrderNo: string,
	now = new Date(),
) {
	const order = await db.billingOrder.findUnique({
		where: { merchantOrderNo },
		include: { plan: true, user: { select: { suspensionReason: true } } },
	});
	if (!order) throw new Error("Billing order not found.");
	if (order.status === "FULFILLED") return order;
	if (order.status !== "PAID") throw new Error("Only paid orders can be fulfilled.");
	if (!order.plan) throw new Error("The ordered plan no longer exists.");
	if (order.entitlementAppliedAt) return order;
	const userLockKey = `billing-user:${order.userId}`;
	await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
	const lockedOrder = await db.billingOrder.findUnique({
		where: { merchantOrderNo },
		include: { plan: true, user: { select: { suspensionReason: true } } },
	});
	if (!lockedOrder) throw new Error("Billing order not found.");
	if (lockedOrder.status === "FULFILLED" || lockedOrder.entitlementAppliedAt) {
		return lockedOrder;
	}
	if (lockedOrder.status !== "PAID") {
		throw new Error("Only paid orders can be fulfilled.");
	}
	const pendingSuspensions = await db.subscriptionSuspensionSnapshot.count({
		where: {
			userId: lockedOrder.userId,
			wasAuthorized: true,
			suspendedAt: null,
			restoredAt: null,
		},
	});
	if (pendingSuspensions > 0) {
		throw new Error("Subscription suspension is still in progress.");
	}

	const existing = await db.subscription.findUnique({
		where: { userId: lockedOrder.userId },
	});
	const base = existing?.expiresAt && existing.expiresAt > now ? existing.expiresAt : now;
	const startsAt =
		existing?.expiresAt && existing.expiresAt > now ? existing.startsAt : now;
	const subscriptionExpiresAt = addBillingMonths(
		base,
		lockedOrder.durationMonthsSnapshot,
	);

	await db.subscription.upsert({
		where: { userId: lockedOrder.userId },
		create: {
			userId: lockedOrder.userId,
			planId: lockedOrder.plan.id,
			status: "ACTIVE",
			startsAt,
			expiresAt: subscriptionExpiresAt,
			maxNetworksSnapshot: lockedOrder.maxNetworksSnapshot,
			userGroupIdSnapshot: lockedOrder.userGroupIdSnapshot,
			planPriceCentsSnapshot: lockedOrder.planPriceCentsSnapshot,
			durationMonthsSnapshot: lockedOrder.durationMonthsSnapshot,
			planLevelSnapshot: lockedOrder.planLevelSnapshot,
		},
		update: {
			planId: lockedOrder.plan.id,
			status: "ACTIVE",
			expiresAt: subscriptionExpiresAt,
			maxNetworksSnapshot: lockedOrder.maxNetworksSnapshot,
			userGroupIdSnapshot: lockedOrder.userGroupIdSnapshot,
			planPriceCentsSnapshot: lockedOrder.planPriceCentsSnapshot,
			durationMonthsSnapshot: lockedOrder.durationMonthsSnapshot,
			planLevelSnapshot: lockedOrder.planLevelSnapshot,
		},
	});

	await db.user.update({
		where: { id: lockedOrder.userId },
		data: {
			userGroupId: lockedOrder.userGroupIdSnapshot,
			expiresAt: subscriptionExpiresAt,
		},
	});

	return db.billingOrder.update({
		where: { id: lockedOrder.id },
		data: { entitlementAppliedAt: now, failureReason: null },
	});
}
