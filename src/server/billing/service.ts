import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { alipayAmountToCents } from "./orders";

export function createPaymentEventHash(payload: Record<string, string>): string {
	const canonical = Object.keys(payload)
		.sort()
		.map((key) => `${key}=${payload[key]}`)
		.join("&");
	return createHash("sha256").update(canonical).digest("hex");
}

function parseAlipayPaidAt(value: string | undefined): Date {
	if (!value) return new Date();
	const chinaTime = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
	const parsed = chinaTime
		? new Date(
				`${chinaTime[1]}-${chinaTime[2]}-${chinaTime[3]}T${chinaTime[4]}:${chinaTime[5]}:${chinaTime[6]}+08:00`,
			)
		: new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

export async function recordVerifiedAlipayPayment({
	prisma,
	payload,
}: {
	prisma: PrismaClient;
	payload: Record<string, string>;
}) {
	const merchantOrderNo = payload.out_trade_no;
	const alipayTradeNo = payload.trade_no;
	if (!merchantOrderNo || !alipayTradeNo || !payload.total_amount) {
		throw new Error("Verified Alipay notification is missing required fields.");
	}
	if (
		payload.trade_status !== "TRADE_SUCCESS" &&
		payload.trade_status !== "TRADE_FINISHED"
	) {
		throw new Error("Only successful Alipay trades can be recorded.");
	}

	const eventHash = createPaymentEventHash(payload);
	return prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${merchantOrderNo}))`;
			const duplicateEvent = await tx.paymentEvent.findUnique({ where: { eventHash } });
			if (duplicateEvent?.processedAt) {
				return tx.billingOrder.findUniqueOrThrow({ where: { merchantOrderNo } });
			}

			const order = await tx.billingOrder.findUnique({ where: { merchantOrderNo } });
			if (!order) throw new Error("Alipay notification references an unknown order.");
			const amountCents = alipayAmountToCents(payload.total_amount);
			if (amountCents !== order.amountCents) {
				throw new Error("Alipay notification amount does not match the order.");
			}
			const existingTransaction = await tx.paymentTransaction.findUnique({
				where: { alipayTradeNo },
			});
			if (existingTransaction && existingTransaction.orderId !== order.id) {
				throw new Error("The Alipay trade number is already bound to another order.");
			}

			const event = duplicateEvent
				? duplicateEvent
				: await tx.paymentEvent.create({
						data: {
							eventHash,
							orderId: order.id,
							eventType: payload.trade_status || "UNKNOWN",
							rawPayload: payload,
						},
					});

			if (
				order.status !== "FULFILLED" &&
				order.status !== "FAILED" &&
				order.status !== "REFUNDED"
			) {
				await tx.paymentTransaction.upsert({
					where: { alipayTradeNo },
					create: {
						orderId: order.id,
						alipayTradeNo,
						buyerId: payload.buyer_id || null,
						amountCents,
						tradeStatus: payload.trade_status,
						rawPayload: payload,
						paidAt: parseAlipayPaidAt(payload.gmt_payment),
					},
					update: {
						tradeStatus: payload.trade_status,
						rawPayload: payload,
					},
				});
				const currentSubscription = await tx.subscription.findUnique({
					where: { userId: order.userId },
					select: { status: true, expiresAt: true, planLevelSnapshot: true },
				});
				const paidDowngrade =
					order.source === "SELF_SERVICE" &&
					currentSubscription !== null &&
					order.planLevelSnapshot < currentSubscription.planLevelSnapshot;
				await tx.billingOrder.update({
					where: { id: order.id },
					data: {
						status: paidDowngrade ? "FAILED" : "PAID",
						paidAt: order.paidAt ?? new Date(),
						failureReason: paidDowngrade
							? "Paid order would downgrade an active subscription; manual review required."
							: null,
					},
				});
			}

			await tx.paymentEvent.update({
				where: { id: event.id },
				data: { processedAt: new Date(), processingError: null },
			});
			return tx.billingOrder.findUniqueOrThrow({ where: { merchantOrderNo } });
		},
		{ isolationLevel: "Serializable" },
	);
}

export async function markOrderFulfilled(prisma: PrismaClient, merchantOrderNo: string) {
	return prisma.billingOrder.update({
		where: { merchantOrderNo },
		data: {
			status: "FULFILLED",
			fulfilledAt: new Date(),
			failureReason: null,
		},
	});
}
