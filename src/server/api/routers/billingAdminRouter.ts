import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	ALIPAY_NOTIFY_PATH,
	ALIPAY_RETURN_PATH,
	buildAlipayCallbackUrl,
	isValidAlipayCallbackOrigin,
} from "~/lib/billing/alipayCallbacks";
import { signContent, verifyContentSignature } from "~/server/billing/alipay";
import {
	DEFAULT_ALIPAY_GATEWAY,
	ALIPAY_GATEWAYS,
	encryptAlipayPrivateKey,
	getAlipayCallbackOrigins,
	getAlipayRuntimeConfig,
	getPublicAlipayConfig,
} from "~/server/billing/config";
import { createPendingOrder } from "~/server/billing/orders";
import { queryAndReconcileAlipayOrder } from "~/server/billing/payment";
import { fulfilPaidOrder, restoreSubscriptionAccess } from "~/server/billing/runtime";
import { assignAdminPlanWithExpiration } from "~/server/billing/adminAssignment";
import { adminRoleProtectedRoute, createTRPCRouter } from "~/server/api/trpc";

const planInput = z.object({
	id: z.string().cuid().optional(),
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(500),
	priceCents: z.number().int().positive().max(100_000_000),
	durationMonths: z.number().int().min(1).max(120),
	level: z.number().int().min(0).max(10_000),
	isActive: z.boolean(),
	userGroupId: z.number().int().positive(),
});

const alipayConfigInput = z.object({
	enabled: z.boolean(),
	appId: z.string().trim().max(64),
	gateway: z.enum(ALIPAY_GATEWAYS),
	alipayPublicKey: z.string().trim().max(16_384).optional(),
	privateKey: z.string().trim().max(16_384).optional(),
	feeRateBps: z.number().int().min(0).max(10_000),
	notifyOrigin: z
		.string()
		.trim()
		.max(2_048)
		.refine((value) => !value || isValidAlipayCallbackOrigin(value), {
			message: "The asynchronous notification domain must be an HTTP or HTTPS origin.",
		}),
	returnOrigin: z
		.string()
		.trim()
		.max(2_048)
		.refine((value) => !value || isValidAlipayCallbackOrigin(value), {
			message: "The browser return domain must be an HTTP or HTTPS origin.",
		}),
});

export const billingAdminRouter = createTRPCRouter({
	getDashboard: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const now = new Date();
		const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
		const [
			activeSubscriptions,
			expiringSoon,
			pendingOrders,
			revenue,
			subscriptions,
			users,
		] = await Promise.all([
			ctx.prisma.subscription.count({
				where: { status: "ACTIVE", expiresAt: { gt: now } },
			}),
			ctx.prisma.subscription.count({
				where: { status: "ACTIVE", expiresAt: { gt: now, lte: sevenDays } },
			}),
			ctx.prisma.billingOrder.count({ where: { status: { in: ["PENDING", "PAID"] } } }),
			ctx.prisma.billingOrder.aggregate({
				where: {
					paidAt: { not: null },
					status: { not: "REFUNDED" },
				},
				_sum: { amountCents: true },
			}),
			ctx.prisma.subscription.findMany({
				include: {
					plan: { select: { id: true, name: true } },
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							_count: {
								select: { network: { where: { organizationId: null } } },
							},
						},
					},
				},
				orderBy: { expiresAt: "asc" },
			}),
			ctx.prisma.user.findMany({
				where: { role: { not: "ADMIN" } },
				select: {
					id: true,
					name: true,
					email: true,
					isActive: true,
					subscription: { select: { planId: true, expiresAt: true } },
				},
				orderBy: { email: "asc" },
			}),
		]);

		return {
			metrics: {
				activeSubscriptions,
				expiringSoon,
				pendingOrders,
				revenueCents: revenue._sum.amountCents ?? 0,
			},
			subscriptions: subscriptions.map((subscription) => ({
				id: subscription.id,
				userId: subscription.userId,
				userName: subscription.user.name,
				userEmail: subscription.user.email,
				planId: subscription.plan.id,
				planName: subscription.plan.name,
				status: subscription.status,
				expiresAt: subscription.expiresAt,
				networkUsage: subscription.user._count.network,
				networkLimit: subscription.maxNetworksSnapshot,
			})),
			renewableUsers: users.map((user) => ({
				id: user.id,
				name: user.name,
				email: user.email,
				isActive: user.isActive,
				currentPlanId: user.subscription?.planId ?? null,
				expiresAt: user.subscription?.expiresAt ?? null,
			})),
		};
	}),

	getPlans: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const [plans, userGroups] = await Promise.all([
			ctx.prisma.billingPlan.findMany({
				include: {
					userGroup: { select: { id: true, name: true, maxNetworks: true } },
					_count: { select: { subscriptions: true } },
				},
				orderBy: [{ sortOrder: "asc" }, { level: "asc" }, { createdAt: "asc" }],
			}),
			ctx.prisma.userGroup.findMany({
				select: { id: true, name: true, maxNetworks: true },
				orderBy: { name: "asc" },
			}),
		]);
		return {
			plans: plans.map((plan) => ({
				id: plan.id,
				name: plan.name,
				description: plan.description,
				priceCents: plan.priceCents,
				durationMonths: plan.durationMonths,
				level: plan.level,
				isActive: plan.isActive,
				userGroupId: plan.userGroup.id,
				userGroupName: plan.userGroup.name,
				maxNetworks: plan.userGroup.maxNetworks,
				subscriberCount: plan._count.subscriptions,
			})),
			userGroups,
		};
	}),

	savePlan: adminRoleProtectedRoute.input(planInput).mutation(async ({ ctx, input }) => {
		const { id, description, ...data } = input;
		const group = await ctx.prisma.userGroup.findUnique({
			where: { id: input.userGroupId },
		});
		if (!group)
			throw new TRPCError({ code: "BAD_REQUEST", message: "User group not found." });
		try {
			const plan = id
				? await ctx.prisma.billingPlan.update({
						where: { id },
						data: { ...data, description: description || null },
					})
				: await ctx.prisma.billingPlan.create({
						data: { ...data, description: description || null },
					});
			await ctx.prisma.activityLog.create({
				data: {
					performedById: ctx.session.user.id,
					action: `${id ? "Updated" : "Created"} billing plan ${plan.name} (${plan.id})`,
				},
			});
			return plan;
		} catch (error) {
			throw new TRPCError({
				code: "CONFLICT",
				message: error instanceof Error ? error.message : "Could not save plan.",
			});
		}
	}),

	deletePlan: adminRoleProtectedRoute
		.input(z.object({ id: z.string().cuid() }))
		.mutation(async ({ ctx, input }) => {
			const plan = await ctx.prisma.billingPlan.findUnique({
				where: { id: input.id },
				include: { _count: { select: { subscriptions: true, orders: true } } },
			});
			if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found." });
			const result =
				plan._count.subscriptions || plan._count.orders
					? await ctx.prisma.billingPlan.update({
							where: { id: plan.id },
							data: { isActive: false },
						})
					: await ctx.prisma.billingPlan.delete({ where: { id: plan.id } });
			await ctx.prisma.activityLog.create({
				data: {
					performedById: ctx.session.user.id,
					action: `${plan._count.subscriptions || plan._count.orders ? "Archived" : "Deleted"} billing plan ${plan.name} (${plan.id})`,
				},
			});
			return result;
		}),

	getOrders: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const [orders, total] = await Promise.all([
			ctx.prisma.billingOrder.findMany({
				include: {
					user: { select: { email: true } },
					transactions: { select: { alipayTradeNo: true }, take: 1 },
				},
				orderBy: { createdAt: "desc" },
				take: 200,
			}),
			ctx.prisma.billingOrder.count(),
		]);
		return {
			orders: orders.map((order) => ({
				id: order.id,
				merchantOrderNo: order.merchantOrderNo,
				userEmail: order.user.email,
				planName: order.planNameSnapshot,
				durationMonths: order.durationMonthsSnapshot,
				amountCents: order.amountCents,
				subtotalCents: order.baseAmountCentsSnapshot + order.upgradeAmountCentsSnapshot,
				feeRateBps: order.feeRateBpsSnapshot,
				feeAmountCents: order.feeAmountCentsSnapshot,
				status: order.status,
				source: order.source,
				createdAt: order.createdAt,
				paidAt: order.paidAt,
				alipayTradeNo: order.transactions[0]?.alipayTradeNo ?? null,
			})),
			total,
		};
	}),

	queryOrder: adminRoleProtectedRoute
		.input(z.object({ orderId: z.string().cuid() }))
		.mutation(async ({ ctx, input }) => {
			const order = await ctx.prisma.billingOrder.findUnique({
				where: { id: input.orderId },
			});
			if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
			try {
				if (order.source === "MANUAL_ADMIN") {
					if (order.status === "PAID")
						await fulfilPaidOrder(ctx.prisma, order.merchantOrderNo);
					return ctx.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
				}
				const options = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
				const config = getAlipayRuntimeConfig(options, { requireEnabled: false });
				await queryAndReconcileAlipayOrder({
					prisma: ctx.prisma,
					config,
					orderId: order.id,
				});
				return ctx.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not query the order.",
				});
			}
		}),

	manualRenew: adminRoleProtectedRoute
		.input(
			z.object({
				userId: z.string().cuid(),
				planId: z.string().cuid(),
				durationMonths: z.number().int().min(1).max(120),
				amountCents: z.number().int().min(0).max(100_000_000),
				note: z.string().trim().max(1000),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const order = await ctx.prisma.$transaction(async (transaction) => {
					const userLockKey = `billing-user:${input.userId}`;
					await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
					const unsettledOrder = await transaction.billingOrder.findFirst({
						where: {
							userId: input.userId,
							OR: [{ status: "PENDING" }, { status: "PAID", entitlementAppliedAt: null }],
						},
						select: { id: true },
					});
					if (unsettledOrder) {
						throw new Error(
							"The user has an unpaid or unfulfilled order. Complete or cancel it first.",
						);
					}
					const created = await createPendingOrder({
						db: transaction,
						userId: input.userId,
						planId: input.planId,
						source: "MANUAL_ADMIN",
						durationMonths: input.durationMonths,
						amountCents: input.amountCents,
						adminNote: input.note,
					});
					return transaction.billingOrder.update({
						where: { id: created.id },
						data: { status: "PAID", paidAt: new Date() },
					});
				});
				await fulfilPaidOrder(ctx.prisma, order.merchantOrderNo);
				await ctx.prisma.activityLog.create({
					data: {
						performedById: ctx.session.user.id,
						action: `Manually renewed user ${input.userId} with order ${order.merchantOrderNo}${input.note ? `: ${input.note}` : ""}`,
					},
				});
				return ctx.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Could not renew subscription.",
				});
			}
		}),

	assignPlan: adminRoleProtectedRoute
		.input(
			z.object({
				userId: z.string().cuid(),
				planId: z.string().cuid(),
				expiresAt: z.date(),
				note: z.string().trim().max(500).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const assignment = await assignAdminPlanWithExpiration(ctx.prisma, {
					...input,
					performedById: ctx.session.user.id,
				});
				const restoration = assignment.needsRestoration
					? await restoreSubscriptionAccess(ctx.prisma, input.userId)
					: null;
				return { assignment, restoration };
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Could not assign the plan.",
				});
			}
		}),

	getAlipayConfig: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const options = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
		return getPublicAlipayConfig(options);
	}),

	saveAlipayConfig: adminRoleProtectedRoute
		.input(alipayConfigInput)
		.mutation(async ({ ctx, input }) => {
			const current = await ctx.prisma.globalOptions.findUnique({ where: { id: 1 } });
			const newPublicKey = input.alipayPublicKey || undefined;
			const newPrivateKey = input.privateKey || undefined;
			const currentCallbacks = getAlipayCallbackOrigins(current);
			const notifyOrigin = input.notifyOrigin || currentCallbacks.notifyOrigin;
			const returnOrigin = input.returnOrigin || currentCallbacks.returnOrigin;
			if (input.enabled) {
				if (!notifyOrigin || !returnOrigin) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Both Alipay callback domains are required before payments can be enabled.",
					});
				}
				if (!input.appId || (!newPublicKey && !current?.alipayPublicKey)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "App ID and Alipay public key are required.",
					});
				}
				if (!newPrivateKey && !current?.alipayPrivateKeyEncrypted) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Alipay merchant private key is required.",
					});
				}
			}
			if (newPublicKey) {
				try {
					verifyContentSignature("ztnet-key-check", "AA==", newPublicKey);
				} catch {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"The Alipay public key format is invalid. Use the Alipay public key, not the merchant application public key.",
					});
				}
			}
			if (newPrivateKey) {
				try {
					signContent("ztnet-key-check", newPrivateKey);
				} catch {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The merchant application private key format is invalid.",
					});
				}
			}
			let encryptedPrivateKey: string | undefined;
			const notifyUrl = input.notifyOrigin
				? buildAlipayCallbackUrl(input.notifyOrigin, ALIPAY_NOTIFY_PATH)
				: undefined;
			const returnUrl = input.returnOrigin
				? buildAlipayCallbackUrl(input.returnOrigin, ALIPAY_RETURN_PATH)
				: undefined;
			try {
				encryptedPrivateKey = newPrivateKey
					? encryptAlipayPrivateKey(newPrivateKey)
					: undefined;
			} catch {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "The Alipay private key could not be encrypted.",
				});
			}
			const updated = await ctx.prisma
				.$transaction(async (transaction) => {
					const saved = await transaction.globalOptions.upsert({
						where: { id: 1 },
						create: {
							id: 1,
							alipayEnabled: input.enabled,
							alipayAppId: input.appId || null,
							alipaySellerId: null,
							alipayGateway: input.gateway || DEFAULT_ALIPAY_GATEWAY,
							alipayPublicKey: newPublicKey ?? current?.alipayPublicKey ?? null,
							alipayPrivateKeyEncrypted:
								encryptedPrivateKey ?? current?.alipayPrivateKeyEncrypted ?? null,
							alipayFeeRateBps: input.feeRateBps,
							alipayNotifyUrl: notifyUrl ?? null,
							alipayReturnUrl: returnUrl ?? null,
						},
						update: {
							alipayEnabled: input.enabled,
							alipayAppId: input.appId || null,
							alipaySellerId: null,
							alipayGateway: input.gateway || DEFAULT_ALIPAY_GATEWAY,
							alipayFeeRateBps: input.feeRateBps,
							...(notifyUrl ? { alipayNotifyUrl: notifyUrl } : {}),
							...(returnUrl ? { alipayReturnUrl: returnUrl } : {}),
							...(newPublicKey ? { alipayPublicKey: newPublicKey } : {}),
							...(encryptedPrivateKey
								? { alipayPrivateKeyEncrypted: encryptedPrivateKey }
								: {}),
						},
					});
					await transaction.activityLog.create({
						data: {
							performedById: ctx.session.user.id,
							action: `Updated Alipay billing configuration (enabled=${saved.alipayEnabled})`,
						},
					});
					return saved;
				})
				.catch((error) => {
					console.error("Could not save Alipay configuration:", error);
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							"Could not save Alipay configuration. Make sure the latest database migration has been applied.",
					});
				});
			return getPublicAlipayConfig(updated);
		}),
});
