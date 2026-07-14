jest.mock("~/server/db", () => ({
	prisma: {
		globalOptions: { findUnique: jest.fn() },
		billingOrder: { findUnique: jest.fn() },
	},
}));
jest.mock("~/server/billing/config", () => ({
	getAlipayRuntimeConfig: jest.fn(),
}));
jest.mock("~/server/billing/alipay", () => ({
	verifyAlipayNotification: jest.fn(),
}));
jest.mock("~/server/billing/payment", () => ({
	processVerifiedAlipayPayment: jest.fn(),
}));

import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import alipayNotify, {
	config as notifyRouteConfig,
} from "~/pages/api/billing/alipay/notify";
import { verifyAlipayNotification } from "~/server/billing/alipay";
import { getAlipayRuntimeConfig } from "~/server/billing/config";
import { processVerifiedAlipayPayment } from "~/server/billing/payment";
import { prisma } from "~/server/db";

const mockPrisma = prisma as unknown as {
	globalOptions: { findUnique: jest.Mock };
	billingOrder: { findUnique: jest.Mock };
};

function createRawRequest(
	body: string,
	input: { method?: string; contentType?: string } = {},
): NextApiRequest {
	const midpoint = Math.floor(body.length / 2);
	const request = Readable.from([
		Buffer.from(body.slice(0, midpoint), "utf8"),
		Buffer.from(body.slice(midpoint), "utf8"),
	]);
	Object.assign(request, {
		method: input.method ?? "POST",
		headers: {
			"content-type":
				input.contentType ?? "application/x-www-form-urlencoded; charset=utf-8",
		},
	});
	return request as unknown as NextApiRequest;
}

function createResponse() {
	const setHeader = jest.fn();
	const status = jest.fn();
	const send = jest.fn();
	const response = { setHeader, status, send };
	status.mockReturnValue(response);
	send.mockReturnValue(response);
	return {
		response: response as unknown as NextApiResponse,
		mocks: { setHeader, status, send },
	};
}

describe("Alipay notification API", () => {
	let consoleError: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		mockPrisma.globalOptions.findUnique.mockReset();
		mockPrisma.billingOrder.findUnique.mockReset();
		jest.mocked(getAlipayRuntimeConfig).mockReset();
		jest.mocked(verifyAlipayNotification).mockReset();
		jest.mocked(processVerifiedAlipayPayment).mockReset();
		consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

		mockPrisma.globalOptions.findUnique.mockResolvedValue({ id: 1 });
		mockPrisma.billingOrder.findUnique.mockResolvedValue({
			id: "order-1",
			merchantOrderNo: "ZT-NOTIFY-1",
			amountCents: 2_500,
			source: "SELF_SERVICE",
		});
		jest.mocked(getAlipayRuntimeConfig).mockReturnValue({
			appId: "2026071400000001",
			sellerId: "2088000000000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			privateKey: "merchant-private-key",
			alipayPublicKey: "alipay-public-key",
		});
		jest.mocked(verifyAlipayNotification).mockReturnValue({
			payload: {
				out_trade_no: "ZT-NOTIFY-1",
				trade_no: "TRADE-1",
				trade_status: "TRADE_SUCCESS",
				total_amount: "25.00",
			},
			appId: "2026071400000001",
			sellerId: "2088000000000001",
			merchantOrderNo: "ZT-NOTIFY-1",
			alipayTradeNo: "TRADE-1",
			amountCents: 2_500,
			tradeStatus: "TRADE_SUCCESS",
		});
		jest.mocked(processVerifiedAlipayPayment).mockResolvedValue({} as never);
	});

	afterEach(() => {
		consoleError.mockRestore();
	});

	test("disables Next.js body parsing so the signed form remains raw", () => {
		expect(notifyRouteConfig).toEqual({ api: { bodyParser: false } });
	});

	test("passes the exact raw form to verification and returns plain-text success", async () => {
		const rawBody =
			"out_trade_no=ZT-NOTIFY-1&subject=ZTNET+Pro%2B&sign=raw%2Bsignature%3D";
		const response = createResponse();

		await alipayNotify(createRawRequest(rawBody), response.response);

		expect(verifyAlipayNotification).toHaveBeenCalledWith({
			payload: rawBody,
			alipayPublicKey: "alipay-public-key",
			expected: {
				appId: "2026071400000001",
				sellerId: "2088000000000001",
				merchantOrderNo: "ZT-NOTIFY-1",
				amountCents: 2_500,
			},
		});
		expect(processVerifiedAlipayPayment).toHaveBeenCalledWith(mockPrisma, {
			out_trade_no: "ZT-NOTIFY-1",
			trade_no: "TRADE-1",
			trade_status: "TRADE_SUCCESS",
			total_amount: "25.00",
		});
		expect(response.mocks.setHeader).toHaveBeenCalledWith(
			"Content-Type",
			"text/plain; charset=utf-8",
		);
		expect(response.mocks.status).toHaveBeenCalledWith(200);
		expect(response.mocks.send).toHaveBeenCalledWith("success");
	});

	test("rejects every non-POST method with plain-text failure", async () => {
		const response = createResponse();

		await alipayNotify(createRawRequest("", { method: "GET" }), response.response);

		expect(response.mocks.setHeader).toHaveBeenCalledWith("Allow", "POST");
		expect(response.mocks.status).toHaveBeenCalledWith(405);
		expect(response.mocks.send).toHaveBeenCalledWith("failure");
		expect(mockPrisma.globalOptions.findUnique).not.toHaveBeenCalled();
		expect(verifyAlipayNotification).not.toHaveBeenCalled();
	});

	test("rejects a parsed request object instead of trusting req.body", async () => {
		const request = {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: { out_trade_no: "ZT-NOTIFY-1" },
		} as unknown as NextApiRequest;
		const response = createResponse();

		await alipayNotify(request, response.response);

		expect(response.mocks.status).toHaveBeenCalledWith(400);
		expect(response.mocks.send).toHaveBeenCalledWith("failure");
		expect(verifyAlipayNotification).not.toHaveBeenCalled();
	});

	test("returns plain-text failure when verification rejects the form", async () => {
		jest.mocked(verifyAlipayNotification).mockImplementation(() => {
			throw new Error("Invalid signature");
		});
		const response = createResponse();

		await alipayNotify(
			createRawRequest("out_trade_no=ZT-NOTIFY-1&sign=invalid"),
			response.response,
		);

		expect(response.mocks.status).toHaveBeenCalledWith(400);
		expect(response.mocks.send).toHaveBeenCalledWith("failure");
		expect(processVerifiedAlipayPayment).not.toHaveBeenCalled();
	});

	test("returns plain-text failure when verified payment processing fails", async () => {
		jest
			.mocked(processVerifiedAlipayPayment)
			.mockRejectedValue(new Error("Transaction failed"));
		const response = createResponse();

		await alipayNotify(
			createRawRequest("out_trade_no=ZT-NOTIFY-1&sign=valid"),
			response.response,
		);

		expect(response.mocks.status).toHaveBeenCalledWith(400);
		expect(response.mocks.send).toHaveBeenCalledWith("failure");
	});

	test("rejects POST bodies that are not declared as form-urlencoded", async () => {
		const response = createResponse();

		await alipayNotify(
			createRawRequest("out_trade_no=ZT-NOTIFY-1&sign=valid", {
				contentType: "application/json",
			}),
			response.response,
		);

		expect(response.mocks.send).toHaveBeenCalledWith("failure");
		expect(verifyAlipayNotification).not.toHaveBeenCalled();
		expect(processVerifiedAlipayPayment).not.toHaveBeenCalled();
	});
});
