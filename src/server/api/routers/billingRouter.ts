import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { buildPagePayUrl } from "~/server/billing/alipay";
import { getAlipayCallbackUrls, getAlipayRuntimeConfig } from "~/server/billing/config";
import { closePendingAlipayOrder } from "~/server/billing/payment";
import {
	getEffectiveEntitlement,
	type EntitlementPrisma,
} from "~/server/billing/entitlements";
import {
	calculatePlanPurchaseTerms,
	calculateUpgradeAmountCents,
	createPendingOrder,
	MAX_BILLING_DURATION_MONTHS,
} from "~/server/billing/orders";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

function planResult(plan: {
	id: string;
	name: string;
	description: string | null;
	priceCents: number;
	durationMonths: number;
	level: number;
	isActive: boolean;
	userGroup: { maxNetworks: number };
}) {
	return {
		id: plan.id,
		name: plan.name,
		description: plan.description,
		priceCents: plan.priceCents,
		durationMonths: plan.durationMonths,
		rank: plan.level,
		maxNetworks: plan.userGroup.maxNetworks,
		isActive: plan.isActive,
	};
}

function effectiveOrderStatus(
	order: { status: string; expiresAt: Date },
	now: Date,
): string {
	return order.status === "PENDING" && order.expiresAt <= now ? "CLOSED" : order.status;
}

function orderResult(
	order: {
		id: string;
		merchantOrderNo: string;
		status: string;
		amountCents: number;
		baseAmountCentsSnapshot: number;
		upgradeAmountCentsSnapshot: number;
		feeRateBpsSnapshot: number;
		feeAmountCentsSnapshot: number;
		planNameSnapshot: string;
		planId: string | null;
		durationMonthsSnapshot: number;
		createdAt: Date;
		paidAt: Date | null;
		expiresAt: Date;
	},
	now: Date,
) {
	return {
		id: order.id,
		orderNo: order.merchantOrderNo,
		status: effectiveOrderStatus(order, now),
		amountCents: order.amountCents,
		subtotalCents: order.baseAmountCentsSnapshot + order.upgradeAmountCentsSnapshot,
		feeRateBps: order.feeRateBpsSnapshot,
		feeAmountCents: order.feeAmountCentsSnapshot,
		planName: order.planNameSnapshot,
		planId: order.planId,
		baseAmountCents: order.baseAmountCentsSnapshot,
		durationMonths: order.durationMonthsSnapshot,
		createdAt: order.createdAt,
		paidAt: order.paidAt,
		expiresAt: order.expiresAt,
	};
}

async function paymentUrlForOrder(
	ctx: { prisma: PrismaClient },
	order: {
		id: string;
		merchantOrderNo: string;
		amountCents: number;
		subject: string;
		expiresAt: Date;
	},
) {
	const options = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
	const config = getAlipayRuntimeConfig(options);
	const callbacks = getAlipayCallbackUrls(options, order.id);
	if (order.expiresAt.getTime() <= Date.now()) {
		throw new Error("This payment order has expired.");
	}
	return buildPagePayUrl({
		appId: config.appId,
		privateKey: config.privateKey,
		gateway: config.gateway,
		merchantOrderNo: order.merchantOrderNo,
		amountCents: order.amountCents,
		subject: order.subject,
		notifyUrl: callbacks.notifyUrl,
		returnUrl: callbacks.returnUrl,
		timeExpire: order.expiresAt,
	});
}

function createdOrderResult(
	order: {
		id: string;
		merchantOrderNo: string;
		status: string;
		amountCents: number;
		baseAmountCentsSnapshot: number;
		upgradeAmountCentsSnapshot: number;
		feeRateBpsSnapshot: number;
		feeAmountCentsSnapshot: number;
		durationMonthsSnapshot: number;
		planId: string | null;
		planNameSnapshot: string;
		expiresAt: Date;
	},
	paymentUrl: string,
) {
	return {
		orderId: order.id,
		orderNo: order.merchantOrderNo,
		status: order.status,
		planId: order.planId,
		planName: order.planNameSnapshot,
		amountCents: order.amountCents,
		subtotalCents: order.baseAmountCentsSnapshot + order.upgradeAmountCentsSnapshot,
		feeRateBps: order.feeRateBpsSnapshot,
		feeAmountCents: order.feeAmountCentsSnapshot,
		durationMonths: order.durationMonthsSnapshot,
		paymentUrl,
		expiresAt: order.expiresAt,
	};
}

export const billingRouter = createTRPCRouter({
	getOverview: protectedProcedure.query(async ({ ctx }) => {
		if (ctx.session.user.role === "ADMIN") {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Administrators do not need billing plans.",
			});
		}
		const now = new Date();
		const [plans, subscription, orders, usedNetworks, entitlement, options] =
			await Promise.all([
				ctx.prisma.billingPlan.findMany({
					where: { isActive: true },
					include: { userGroup: { select: { maxNetworks: true } } },
					orderBy: [{ sortOrder: "asc" }, { level: "asc" }, { priceCents: "asc" }],
				}),
				ctx.prisma.subscription.findUnique({
					where: { userId: ctx.session.user.id },
					include: {
						plan: { include: { userGroup: { select: { maxNetworks: true } } } },
					},
				}),
				ctx.prisma.billingOrder.findMany({
					where: { userId: ctx.session.user.id },
					orderBy: { createdAt: "desc" },
					take: 50,
				}),
				ctx.prisma.network.count({
					where: { authorId: ctx.session.user.id, organizationId: null },
				}),
				getEffectiveEntitlement(
					{ prisma: ctx.prisma as unknown as EntitlementPrisma },
					ctx.session.user.id,
				),
				ctx.prisma.globalOptions.findUnique({
					where: { id: 1 },
					select: { alipayFeeRateBps: true },
				}),
			]);

		const activeSubscription =
			subscription?.status === "ACTIVE" && subscription.expiresAt > now
				? {
						id: subscription.id,
						status: subscription.status,
						startsAt: subscription.startsAt,
						endsAt: subscription.expiresAt,
						plan: planResult(subscription.plan),
					}
				: null;

		const plansWithPricing = plans.map((plan) => {
			const upgradeAmountCents =
				subscription?.status === "ACTIVE" &&
				subscription.expiresAt > now &&
				plan.level > subscription.planLevelSnapshot
					? calculateUpgradeAmountCents({
							now,
							expiresAt: subscription.expiresAt,
							currentPriceCents: subscription.planPriceCentsSnapshot,
							currentDurationMonths: subscription.durationMonthsSnapshot,
							targetPriceCents: plan.priceCents,
							targetDurationMonths: plan.durationMonths,
						})
					: 0;
			return { ...planResult(plan), upgradeAmountCents };
		});

		const orderSummaries = orders.map((order) => orderResult(order, now));
		const pendingOrder =
			orderSummaries.find(
				(order) => order.status === "PENDING" && order.expiresAt > now,
			) ?? null;

		return {
			subscription: activeSubscription,
			networkUsage: {
				used: usedNetworks,
				limit: entitlement.hasActiveEntitlement ? entitlement.maxNetworks : 0,
			},
			plans: plansWithPricing,
			orders: orderSummaries,
			pendingOrder,
			paymentFeeRateBps: options?.alipayFeeRateBps ?? 0,
		};
	}),

	createOrder: protectedProcedure
		.input(
			z.object({
				planId: z.string().cuid(),
				quantity: z.number().int().min(1).max(MAX_BILLING_DURATION_MONTHS).default(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const order = await ctx.prisma.$transaction(async (transaction) => {
					const lockKey = `billing-order:${ctx.session.user.id}`;
					await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
					const [plan, options, existing] = await Promise.all([
						transaction.billingPlan.findUnique({
							where: { id: input.planId },
							select: { priceCents: true, durationMonths: true, isActive: true },
						}),
						transaction.globalOptions.findUnique({
							where: { id: 1 },
							select: { alipayFeeRateBps: true },
						}),
						transaction.billingOrder.findFirst({
							where: {
								userId: ctx.session.user.id,
								source: "SELF_SERVICE",
								status: "PENDING",
								expiresAt: { gt: new Date() },
							},
							orderBy: { createdAt: "desc" },
						}),
					]);
					if (!plan) throw new Error("Billing plan not found.");
					if (!plan.isActive) throw new Error("This plan is not available.");
					const purchaseTerms = calculatePlanPurchaseTerms(plan, input.quantity);
					const feeRateBps = options?.alipayFeeRateBps ?? 0;
					if (
						existing?.planId === input.planId &&
						existing.durationMonthsSnapshot === purchaseTerms.durationMonths &&
						existing.baseAmountCentsSnapshot === purchaseTerms.amountCents &&
						existing.feeRateBpsSnapshot === feeRateBps
					) {
						return existing;
					}
					if (existing) {
						throw new TRPCError({
							code: "CONFLICT",
							message: "You already have an unpaid order. Continue or cancel it first.",
						});
					}
					return createPendingOrder({
						db: transaction,
						userId: ctx.session.user.id,
						planId: input.planId,
						quantity: input.quantity,
						feeRateBps,
					});
				});
				const paymentUrl = await paymentUrlForOrder(ctx, order);
				return createdOrderResult(order, paymentUrl);
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not create the order.",
				});
			}
		}),

	resumeOrder: protectedProcedure
		.input(z.object({ orderId: z.string().cuid() }))
		.mutation(async ({ ctx, input }) => {
			try {
				const order = await ctx.prisma.billingOrder.findFirst({
					where: {
						id: input.orderId,
						userId: ctx.session.user.id,
						source: "SELF_SERVICE",
					},
				});
				if (!order)
					throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
				if (order.status !== "PENDING") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "This order is no longer awaiting payment.",
					});
				}
				if (order.expiresAt <= new Date()) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "This payment order has expired.",
					});
				}
				return createdOrderResult(order, await paymentUrlForOrder(ctx, order));
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not resume the order.",
				});
			}
		}),

	cancelOrder: protectedProcedure
		.input(z.object({ orderId: z.string().cuid() }))
		.mutation(async ({ ctx, input }) => {
			try {
				const order = await ctx.prisma.billingOrder.findFirst({
					where: {
						id: input.orderId,
						userId: ctx.session.user.id,
						source: "SELF_SERVICE",
					},
				});
				if (!order)
					throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
				if (order.status !== "PENDING") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "This order is no longer awaiting payment.",
					});
				}
				const options = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
				const config = getAlipayRuntimeConfig(options, { requireEnabled: false });
				const result = await closePendingAlipayOrder({
					prisma: ctx.prisma,
					config,
					orderId: order.id,
				});
				if (result.state !== "CLOSED") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "The order was already paid or completed; refresh the page.",
					});
				}
				return { orderId: order.id, status: "CLOSED" as const };
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not cancel the order.",
				});
			}
		}),

	getOrderStatus: protectedProcedure
		.input(z.object({ orderId: z.string().cuid() }))
		.query(async ({ ctx, input }) => {
			const order = await ctx.prisma.billingOrder.findFirst({
				where: { id: input.orderId, userId: ctx.session.user.id },
			});
			if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

			const now = new Date();
			const status = effectiveOrderStatus(order, now);
			let paymentUrl: string | null = null;
			if (status === "PENDING") {
				try {
					paymentUrl = await paymentUrlForOrder(ctx, order);
				} catch {
					paymentUrl = null;
				}
			}
			return {
				orderId: order.id,
				orderNo: order.merchantOrderNo,
				status,
				paymentUrl,
				expiresAt: order.expiresAt,
				message:
					order.failureReason ??
					(status === "CLOSED" && order.status === "PENDING"
						? "Payment order expired after five minutes."
						: null),
			};
		}),
});
