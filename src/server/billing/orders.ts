import { randomBytes } from "node:crypto";
import type { BillingOrderSource, Prisma, PrismaClient } from "@prisma/client";

export const ORDER_TTL_MS = 5 * 60 * 1000;
export const MAX_BILLING_DURATION_MONTHS = 120;
export const MAX_BILLING_AMOUNT_CENTS = 2_147_483_647;
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

export function calculateFeeAmountCents(amountCents: number, feeRateBps: number): number {
	if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
		throw new Error("Fee base amount must be a non-negative integer in cents.");
	}
	if (!Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
		throw new Error("Payment fee rate must be between 0% and 100%.");
	}
	if (amountCents === 0 || feeRateBps === 0) return 0;

	const numerator = BigInt(amountCents) * BigInt(feeRateBps);
	const fee = (numerator + BigInt(5_000)) / BigInt(10_000);
	if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("Calculated payment fee is too large.");
	}
	return Number(fee);
}

export function addBillingMonths(date: Date, months: number): Date {
	if (!Number.isInteger(months) || months < 1 || months > MAX_BILLING_DURATION_MONTHS) {
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

export function calculatePlanPurchaseTerms(
	plan: { priceCents: number; durationMonths: number },
	quantity: number,
) {
	if (!Number.isSafeInteger(quantity) || quantity < 1) {
		throw new Error("Purchase quantity must be a positive integer.");
	}
	if (
		!Number.isSafeInteger(plan.priceCents) ||
		plan.priceCents < 1 ||
		!Number.isInteger(plan.durationMonths) ||
		plan.durationMonths < 1
	) {
		throw new Error("Plan pricing must use positive integers.");
	}

	const durationMonths = plan.durationMonths * quantity;
	if (durationMonths > MAX_BILLING_DURATION_MONTHS) {
		throw new Error("Total billing duration must not exceed 120 months.");
	}
	const amountCents = plan.priceCents * quantity;
	if (!Number.isSafeInteger(amountCents) || amountCents > MAX_BILLING_AMOUNT_CENTS) {
		throw new Error("Calculated order amount is too large.");
	}

	return { amountCents, durationMonths };
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
	quantity = 1,
	durationMonths,
	amountCents,
	feeRateBps = 0,
	adminNote,
	now = new Date(),
}: {
	db: BillingDatabase;
	userId: string;
	planId: string;
	source?: BillingOrderSource;
	quantity?: number;
	durationMonths?: number;
	amountCents?: number;
	feeRateBps?: number;
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
	const purchaseTerms = calculatePlanPurchaseTerms(plan, quantity);
	const orderDurationMonths =
		source === "SELF_SERVICE"
			? purchaseTerms.durationMonths
			: (durationMonths ?? plan.durationMonths);
	if (
		!Number.isInteger(orderDurationMonths) ||
		orderDurationMonths < 1 ||
		orderDurationMonths > MAX_BILLING_DURATION_MONTHS
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
	const baseAmountCents =
		source === "SELF_SERVICE"
			? purchaseTerms.amountCents
			: (amountCents ?? plan.priceCents);
	if (
		!Number.isSafeInteger(baseAmountCents) ||
		baseAmountCents < 0 ||
		baseAmountCents > MAX_BILLING_AMOUNT_CENTS
	) {
		throw new Error("Order amount must be a non-negative integer in cents.");
	}
	const subtotalAmountCents = baseAmountCents + upgradeAmountCents;
	if (
		!Number.isSafeInteger(subtotalAmountCents) ||
		subtotalAmountCents > MAX_BILLING_AMOUNT_CENTS
	) {
		throw new Error("Calculated order subtotal is too large.");
	}
	const appliedFeeRateBps = source === "SELF_SERVICE" ? feeRateBps : 0;
	const feeAmountCents = calculateFeeAmountCents(subtotalAmountCents, appliedFeeRateBps);
	const totalAmountCents = subtotalAmountCents + feeAmountCents;
	if (
		!Number.isSafeInteger(totalAmountCents) ||
		totalAmountCents > MAX_BILLING_AMOUNT_CENTS
	) {
		throw new Error("Calculated order total is too large.");
	}
	if (totalAmountCents < 1 && source === "SELF_SERVICE") {
		throw new Error("Self-service orders must have a positive amount.");
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
			subject: `${plan.name}（${orderDurationMonths}个月）`,
			planNameSnapshot: plan.name,
			planPriceCentsSnapshot:
				source === "SELF_SERVICE" ? baseAmountCents : plan.priceCents,
			durationMonthsSnapshot: orderDurationMonths,
			planLevelSnapshot: plan.level,
			maxNetworksSnapshot: plan.userGroup.maxNetworks,
			userGroupIdSnapshot: plan.userGroupId,
			baseAmountCentsSnapshot: baseAmountCents,
			upgradeAmountCentsSnapshot: upgradeAmountCents,
			feeRateBpsSnapshot: appliedFeeRateBps,
			feeAmountCentsSnapshot: feeAmountCents,
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
