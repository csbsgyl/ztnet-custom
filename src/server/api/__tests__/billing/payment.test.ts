jest.mock("~/server/billing/service", () => ({
	recordVerifiedAlipayPayment: jest.fn(),
}));
jest.mock("~/server/billing/runtime", () => ({
	fulfilPaidOrder: jest.fn(),
}));

import {
	constants,
	generateKeyPairSync,
	sign as rsaSign,
	verify as rsaVerify,
} from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { canonicalizeParameters } from "~/server/billing/alipay";
import type { AlipayRuntimeConfig } from "~/server/billing/config";
import { queryAndReconcileAlipayOrder } from "~/server/billing/payment";
import { fulfilPaidOrder } from "~/server/billing/runtime";
import { recordVerifiedAlipayPayment } from "~/server/billing/service";

const APP_ID = "2026071400000001";
const SELLER_ID = "2088000000000001";
const MERCHANT_ORDER_NO = "ZT-QUERY-ORDER-1";

let merchantPrivateKey: string;
let merchantPublicKey: string;
let alipayPrivateKey: string;
let alipayPublicKey: string;
const originalFetch = global.fetch;

beforeAll(() => {
	const merchantKeys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	merchantPrivateKey = merchantKeys.privateKey;
	merchantPublicKey = merchantKeys.publicKey;

	const alipayKeys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	alipayPrivateKey = alipayKeys.privateKey;
	alipayPublicKey = alipayKeys.publicKey;
});

afterAll(() => {
	global.fetch = originalFetch;
});

function signResponseContent(content: string, privateKey: string): string {
	return rsaSign("RSA-SHA256", Buffer.from(content, "utf8"), {
		key: privateKey,
		padding: constants.RSA_PKCS1_PADDING,
	}).toString("base64");
}

function buildSignedQueryResponse(
	response: Readonly<Record<string, string>>,
	privateKey = alipayPrivateKey,
): string {
	const responseJson = JSON.stringify(response);
	return `{"alipay_trade_query_response":${responseJson},"sign":${JSON.stringify(
		signResponseContent(responseJson, privateKey),
	)},"sign_type":"RSA2"}`;
}

function createHarness(status: "PENDING" | "PAID" | "FULFILLED" = "PENDING") {
	const order = {
		id: "order-1",
		merchantOrderNo: MERCHANT_ORDER_NO,
		status,
		amountCents: 2_500,
	};
	const findUnique = jest.fn(async () => order);
	const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
		Object.assign(order, data);
		return order;
	});
	const prisma = {
		billingOrder: { findUnique, update },
	} as unknown as PrismaClient;
	return { prisma, order, mocks: { findUnique, update } };
}

function runtimeConfig(): AlipayRuntimeConfig {
	return {
		appId: APP_ID,
		sellerId: SELLER_ID,
		gateway: "https://alipay.example.test/gateway.do",
		privateKey: merchantPrivateKey,
		alipayPublicKey,
		feeRateBps: 0,
	};
}

describe("active Alipay query reconciliation", () => {
	beforeEach(() => {
		jest.mocked(recordVerifiedAlipayPayment).mockReset();
		jest.mocked(fulfilPaidOrder).mockReset();
	});

	test("verifies a signed paid response and performs the missing local payment", async () => {
		const harness = createHarness();
		const responseBody = buildSignedQueryResponse({
			code: "10000",
			msg: "Success",
			trade_no: "2026071422000000000101",
			out_trade_no: MERCHANT_ORDER_NO,
			trade_status: "TRADE_SUCCESS",
			total_amount: "25.00",
			send_pay_date: "2026-07-14 16:00:00",
		});
		const fetchMock = jest.fn(async (_url: string) => ({
			ok: true,
			status: 200,
			text: async () => responseBody,
		}));
		global.fetch = fetchMock as unknown as typeof fetch;
		jest.mocked(recordVerifiedAlipayPayment).mockResolvedValue({
			status: "PAID",
			merchantOrderNo: MERCHANT_ORDER_NO,
		} as never);
		jest.mocked(fulfilPaidOrder).mockResolvedValue({
			status: "FULFILLED",
			merchantOrderNo: MERCHANT_ORDER_NO,
		} as never);

		await expect(
			queryAndReconcileAlipayOrder({
				prisma: harness.prisma,
				config: runtimeConfig(),
				orderId: "order-1",
			}),
		).resolves.toEqual({ state: "FULFILLED", tradeStatus: "TRADE_SUCCESS" });

		const requestedUrl = fetchMock.mock.calls[0]?.[0];
		if (typeof requestedUrl !== "string") {
			throw new Error("Alipay query URL was not passed to fetch.");
		}
		const url = new URL(requestedUrl);
		const { sign: signature, ...parameters } = Object.fromEntries(
			url.searchParams.entries(),
		);
		if (!signature) throw new Error("Alipay query URL was not signed.");

		expect(parameters).toMatchObject({
			app_id: APP_ID,
			method: "alipay.trade.query",
			sign_type: "RSA2",
		});
		expect(JSON.parse(parameters.biz_content ?? "{}")).toEqual({
			out_trade_no: MERCHANT_ORDER_NO,
		});
		expect(
			rsaVerify(
				"RSA-SHA256",
				Buffer.from(canonicalizeParameters(parameters), "utf8"),
				{ key: merchantPublicKey, padding: constants.RSA_PKCS1_PADDING },
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
		expect(recordVerifiedAlipayPayment).toHaveBeenCalledWith({
			prisma: harness.prisma,
			payload: {
				app_id: APP_ID,
				seller_id: SELLER_ID,
				out_trade_no: MERCHANT_ORDER_NO,
				trade_no: "2026071422000000000101",
				total_amount: "25.00",
				trade_status: "TRADE_SUCCESS",
				gmt_payment: "2026-07-14 16:00:00",
				event_source: "ACTIVE_QUERY",
			},
		});
		expect(fulfilPaidOrder).toHaveBeenCalledWith(harness.prisma, MERCHANT_ORDER_NO);
	});

	test("rejects a response not signed by the configured Alipay key", async () => {
		const harness = createHarness();
		const responseBody = buildSignedQueryResponse(
			{
				code: "10000",
				trade_no: "2026071422000000000101",
				out_trade_no: MERCHANT_ORDER_NO,
				trade_status: "TRADE_SUCCESS",
				total_amount: "25.00",
			},
			merchantPrivateKey,
		);
		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => responseBody,
		})) as unknown as typeof fetch;

		await expect(
			queryAndReconcileAlipayOrder({
				prisma: harness.prisma,
				config: runtimeConfig(),
				orderId: "order-1",
			}),
		).rejects.toMatchObject({
			name: "AlipayProtocolError",
			code: "INVALID_SIGNATURE",
		});
		expect(recordVerifiedAlipayPayment).not.toHaveBeenCalled();
		expect(fulfilPaidOrder).not.toHaveBeenCalled();
	});

	test("fulfils a locally paid order without querying Alipay again", async () => {
		const harness = createHarness("PAID");
		const fetchMock = jest.fn();
		global.fetch = fetchMock as unknown as typeof fetch;
		jest.mocked(fulfilPaidOrder).mockResolvedValue({
			status: "FULFILLED",
			merchantOrderNo: MERCHANT_ORDER_NO,
		} as never);

		await expect(
			queryAndReconcileAlipayOrder({
				prisma: harness.prisma,
				config: runtimeConfig(),
				orderId: "order-1",
			}),
		).resolves.toEqual({ state: "FULFILLED" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(fulfilPaidOrder).toHaveBeenCalledWith(harness.prisma, MERCHANT_ORDER_NO);
	});
});
