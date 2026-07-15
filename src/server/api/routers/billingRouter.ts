import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { buildPagePayUrl } from "~/server/billing/alipay";
import { getAlipayCallbackUrls, getAlipayRuntimeConfig } from "~/server/billing/config";
import {
	getEffectiveEntitlement,
	type EntitlementPrisma,
} from "~/server/billing/entitlements";
import { createPendingOrder } from "~/server/billing/orders";
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

function orderResult(order: {
	id: string;
	merchantOrderNo: string;
	status: string;
	amountCents: number;
	baseAmountCentsSnapshot: number;
	upgradeAmountCentsSnapshot: number;
	feeRateBpsSnapshot: number;
	feeAmountCentsSnapshot: number;
	planNameSnapshot: string;
	createdAt: Date;
	paidAt: Date | null;
}) {
	return {
		id: order.id,
		orderNo: order.merchantOrderNo,
		status: order.status,
		amountCents: order.amountCents,
		subtotalCents: order.baseAmountCentsSnapshot + order.upgradeAmountCentsSnapshot,
		feeRateBps: order.feeRateBpsSnapshot,
		feeAmountCents: order.feeAmountCentsSnapshot,
		planName: order.planNameSnapshot,
		createdAt: order.createdAt,
		paidAt: order.paidAt,
	};
}

async function paymentUrlForOrder(
	ctx: { prisma: PrismaClient },
	order: {
		id: string;
		merchantOrderNo: string;
		amountCents: number;
		subject: string;
	},
) {
	const options = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
	const config = getAlipayRuntimeConfig(options);
	const callbacks = getAlipayCallbackUrls(options, order.id);
	return buildPagePayUrl({
		appId: config.appId,
		privateKey: config.privateKey,
		gateway: config.gateway,
		merchantOrderNo: order.merchantOrderNo,
		amountCents: order.amountCents,
		subject: order.subject,
		notifyUrl: callbacks.notifyUrl,
		returnUrl: callbacks.returnUrl,
		timeoutExpress: "15m",
	});
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

		return {
			subscription: activeSubscription,
			networkUsage: {
				used: usedNetworks,
				limit: entitlement.hasActiveEntitlement ? entitlement.maxNetworks : 0,
			},
			plans: plans.map(planResult),
			orders: orders.map(orderResult),
			paymentFeeRateBps: options?.alipayFeeRateBps ?? 0,
		};
	}),

	createOrder: protectedProcedure
		.input(z.object({ planId: z.string().cuid() }))
		.mutation(async ({ ctx, input }) => {
			try {
				const order = await ctx.prisma.$transaction(async (transaction) => {
					const lockKey = `billing-order:${ctx.session.user.id}`;
					await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
					const existing = await transaction.billingOrder.findFirst({
						where: {
							userId: ctx.session.user.id,
							source: "SELF_SERVICE",
							status: "PENDING",
							expiresAt: { gt: new Date() },
						},
						orderBy: { createdAt: "desc" },
					});
					if (existing?.planId === input.planId) return existing;
					if (existing) {
						await transaction.billingOrder.updateMany({
							where: {
								userId: ctx.session.user.id,
								source: "SELF_SERVICE",
								status: "PENDING",
							},
							data: { status: "CLOSED", closedAt: new Date() },
						});
					}
					const options = await transaction.globalOptions.findUnique({
						where: { id: 1 },
						select: { alipayFeeRateBps: true },
					});
					return createPendingOrder({
						db: transaction,
						userId: ctx.session.user.id,
						planId: input.planId,
						feeRateBps: options?.alipayFeeRateBps ?? 0,
					});
				});
				const paymentUrl = await paymentUrlForOrder(ctx, order);
				return {
					orderId: order.id,
					orderNo: order.merchantOrderNo,
					status: order.status,
					amountCents: order.amountCents,
					subtotalCents: order.baseAmountCentsSnapshot + order.upgradeAmountCentsSnapshot,
					feeRateBps: order.feeRateBpsSnapshot,
					feeAmountCents: order.feeAmountCentsSnapshot,
					paymentUrl,
					expiresAt: order.expiresAt,
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not create the order.",
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

			let paymentUrl: string | null = null;
			if (order.status === "PENDING" && order.expiresAt > new Date()) {
				try {
					paymentUrl = await paymentUrlForOrder(ctx, order);
				} catch {
					paymentUrl = null;
				}
			}
			return {
				orderId: order.id,
				orderNo: order.merchantOrderNo,
				status: order.status,
				paymentUrl,
				message: order.failureReason,
			};
		}),
});
