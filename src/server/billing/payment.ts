import type { PrismaClient } from "@prisma/client";
import {
	buildTradeQueryUrl,
	type AlipayTradeQueryResponse,
	verifyTradeQueryResponse,
} from "./alipay";
import type { AlipayRuntimeConfig } from "./config";
import { recordVerifiedAlipayPayment } from "./service";
import { fulfilPaidOrder } from "./runtime";

export async function processVerifiedAlipayPayment(
	prisma: PrismaClient,
	payload: Record<string, string>,
) {
	const order = await recordVerifiedAlipayPayment({ prisma, payload });
	if (order.status === "FAILED" || order.status === "REFUNDED") return order;
	return fulfilPaidOrder(prisma, order.merchantOrderNo);
}

async function fetchAlipay(url: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Alipay query failed with HTTP ${response.status}.`);
		}
		return await response.text();
	} finally {
		clearTimeout(timeout);
	}
}

export type ActiveQueryResult = {
	state:
		| "FULFILLED"
		| "FAILED"
		| "REFUNDED"
		| "PAID"
		| "PENDING"
		| "CLOSED"
		| "NOT_FOUND";
	tradeStatus?: string;
};

export async function queryAndReconcileAlipayOrder({
	prisma,
	config,
	orderId,
}: {
	prisma: PrismaClient;
	config: AlipayRuntimeConfig;
	orderId: string;
}): Promise<ActiveQueryResult> {
	const order = await prisma.billingOrder.findUnique({ where: { id: orderId } });
	if (!order) throw new Error("Billing order not found.");
	if (order.status === "FULFILLED") return { state: "FULFILLED" };
	if (order.status === "FAILED") return { state: "FAILED" };
	if (order.status === "REFUNDED") return { state: "REFUNDED" };
	if (order.status === "PAID") {
		await fulfilPaidOrder(prisma, order.merchantOrderNo);
		return { state: "FULFILLED" };
	}
	if (order.status === "CLOSED") return { state: "CLOSED" };

	const queryUrl = buildTradeQueryUrl({
		appId: config.appId,
		privateKey: config.privateKey,
		gateway: config.gateway,
		merchantOrderNo: order.merchantOrderNo,
	});
	const body = await fetchAlipay(queryUrl);
	const response = verifyTradeQueryResponse(
		body,
		config.alipayPublicKey,
	) as Readonly<AlipayTradeQueryResponse>;

	if (response.code !== "10000") {
		if (response.sub_code === "ACQ.TRADE_NOT_EXIST") return { state: "NOT_FOUND" };
		throw new Error(
			`Alipay query failed: ${response.sub_code || response.code} ${response.sub_msg || response.msg || ""}`.trim(),
		);
	}
	if (response.out_trade_no !== order.merchantOrderNo) {
		throw new Error("Alipay query returned a different order number.");
	}
	if (response.total_amount !== (order.amountCents / 100).toFixed(2)) {
		throw new Error("Alipay query returned a different order amount.");
	}

	const tradeStatus = response.trade_status || "UNKNOWN";
	if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
		if (!response.trade_no || !response.total_amount) {
			throw new Error("Alipay paid response is missing trade details.");
		}
		const processedOrder = await processVerifiedAlipayPayment(prisma, {
			app_id: config.appId,
			seller_id: config.sellerId,
			out_trade_no: order.merchantOrderNo,
			trade_no: response.trade_no,
			total_amount: response.total_amount,
			trade_status: tradeStatus,
			gmt_payment: response.send_pay_date || new Date().toISOString(),
			event_source: "ACTIVE_QUERY",
		});
		return {
			state: processedOrder.status === "FAILED" ? "FAILED" : "FULFILLED",
			tradeStatus,
		};
	}
	if (tradeStatus === "TRADE_CLOSED") {
		await prisma.billingOrder.update({
			where: { id: order.id },
			data: { status: "CLOSED", closedAt: new Date() },
		});
		return { state: "CLOSED", tradeStatus };
	}
	return { state: "PENDING", tradeStatus };
}
