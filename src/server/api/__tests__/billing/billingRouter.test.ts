jest.mock("~/server/billing/alipay", () => ({
	buildPagePayUrl: jest.fn(() => "https://alipay.example/pay"),
}));
jest.mock("~/server/billing/config", () => ({
	getAlipayCallbackUrls: jest.fn(() => ({
		notifyUrl: "https://billing.example/api/alipay/notify",
		returnUrl: "https://billing.example/billing/return?orderId=order-new",
	})),
	getAlipayRuntimeConfig: jest.fn(() => ({
		appId: "app-id",
		privateKey: "private-key",
		gateway: "https://openapi.alipay.com/gateway.do",
	})),
}));
jest.mock("~/server/billing/orders", () => ({
	...jest.requireActual("~/server/billing/orders"),
	createPendingOrder: jest.fn(),
}));
jest.mock("~/server/billing/payment", () => ({
	closePendingAlipayOrder: jest.fn(),
}));
jest.mock("~/server/billing/entitlements", () => ({
	getEffectiveEntitlement: jest.fn(async () => ({
		hasActiveEntitlement: false,
		maxNetworks: 0,
	})),
}));

import type { Session } from "~/lib/authTypes";
import { billingRouter } from "~/server/api/routers/billingRouter";
import { createPendingOrder } from "~/server/billing/orders";
import { closePendingAlipayOrder } from "~/server/billing/payment";

const planId = "clz0000000000000000000001";
const orderId = "clz0000000000000000000002";
const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "user-1", role: "USER" },
} as Session;

const order = (overrides: Record<string, unknown> = {}) => ({
	id: orderId,
	merchantOrderNo: "ZT202607150001",
	planId,
	status: "PENDING",
	amountCents: 11_951,
	baseAmountCentsSnapshot: 11_880,
	upgradeAmountCentsSnapshot: 0,
	feeRateBpsSnapshot: 60,
	feeAmountCentsSnapshot: 71,
	planNameSnapshot: "轻享版",
	durationMonthsSnapshot: 12,
	subject: "轻享版（12个月）",
	createdAt: new Date("2026-07-15T10:10:00.000Z"),
	paidAt: null,
	failureReason: null,
	source: "SELF_SERVICE",
	expiresAt: new Date("2026-07-15T10:15:00.000Z"),
	...overrides,
});

function createHarness(existingOrder: ReturnType<typeof order> | null) {
	const updateMany = jest.fn(async () => ({ count: 1 }));
	const transaction = {
		$executeRaw: jest.fn(async () => 1),
		billingPlan: {
			findUnique: jest.fn(async () => ({
				priceCents: 990,
				durationMonths: 1,
				isActive: true,
			})),
		},
		globalOptions: {
			findUnique: jest.fn(async () => ({ alipayFeeRateBps: 60 })),
		},
		billingOrder: {
			findFirst: jest.fn(async () => existingOrder),
			updateMany,
		},
	};
	const prisma = {
		user: {
			findUnique: jest.fn(async () => ({
				id: "user-1",
				role: "USER",
				isActive: true,
				suspensionReason: "NONE",
				expiresAt: null,
			})),
		},
		billingOrder: {
			findFirst: jest.fn(async () => existingOrder),
			findMany: jest.fn(async () => (existingOrder ? [existingOrder] : [])),
		},
		billingPlan: { findMany: jest.fn(async () => []) },
		subscription: { findUnique: jest.fn(async () => null) },
		network: { count: jest.fn(async () => 0) },
		globalOptions: { findUnique: jest.fn(async () => ({})) },
		$transaction: jest.fn(async (operation) => operation(transaction)),
	};
	const caller = billingRouter.createCaller({
		session,
		prisma,
		wss: null,
		res: null,
	} as never);
	return { caller, prisma, updateMany };
}

describe("billing order quantity reuse", () => {
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(new Date("2026-07-15T10:10:00.000Z"));
		jest.mocked(createPendingOrder).mockReset();
		jest.mocked(closePendingAlipayOrder).mockReset();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("reuses a pending order only when its quantity snapshots still match", async () => {
		const existingOrder = order();
		const { caller, updateMany } = createHarness(existingOrder);

		const result = await caller.createOrder({ planId, quantity: 12 });

		expect(result).toMatchObject({
			orderId,
			durationMonths: 12,
			amountCents: 11_951,
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(createPendingOrder).not.toHaveBeenCalled();
	});

	test("rejects a different purchase while an unpaid order is active", async () => {
		const existingOrder = order({
			id: "order-old",
			amountCents: 996,
			baseAmountCentsSnapshot: 990,
			feeAmountCentsSnapshot: 6,
			durationMonthsSnapshot: 1,
			subject: "轻享版（1个月）",
		});
		const { caller, updateMany } = createHarness(existingOrder);

		await expect(caller.createOrder({ planId, quantity: 12 })).rejects.toMatchObject({
			code: "CONFLICT",
			message: "You already have an unpaid order. Continue or cancel it first.",
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(createPendingOrder).not.toHaveBeenCalled();
	});

	test("resumes an unexpired order owned by the user", async () => {
		const existingOrder = order();
		const { caller } = createHarness(existingOrder);

		await expect(
			caller.resumeOrder({ orderId: existingOrder.id }),
		).resolves.toMatchObject({
			orderId: existingOrder.id,
			planName: "轻享版",
			paymentUrl: "https://alipay.example/pay",
		});
	});

	test("rejects an expired order without closing it during the request", async () => {
		const existingOrder = order({ expiresAt: new Date("2026-07-15T10:09:59.000Z") });
		const { caller, updateMany } = createHarness(existingOrder);

		await expect(caller.resumeOrder({ orderId: existingOrder.id })).rejects.toMatchObject(
			{
				code: "CONFLICT",
				message: "This payment order has expired.",
			},
		);
		expect(updateMany).not.toHaveBeenCalled();
	});

	test("returns a virtual closed status for an expired order without mutating it", async () => {
		const existingOrder = order({ expiresAt: new Date("2026-07-15T10:09:59.000Z") });
		const { caller, updateMany } = createHarness(existingOrder);

		await expect(
			caller.getOrderStatus({ orderId: existingOrder.id }),
		).resolves.toMatchObject({
			orderId: existingOrder.id,
			status: "CLOSED",
			paymentUrl: null,
			message: "Payment order expired after five minutes.",
		});
		expect(updateMany).not.toHaveBeenCalled();
	});

	test("cancels an unpaid order only after Alipay confirms it can be closed", async () => {
		const existingOrder = order();
		const { caller, prisma } = createHarness(existingOrder);
		jest.mocked(closePendingAlipayOrder).mockResolvedValue({ state: "CLOSED" });

		await expect(caller.cancelOrder({ orderId: existingOrder.id })).resolves.toEqual({
			orderId: existingOrder.id,
			status: "CLOSED",
		});
		expect(closePendingAlipayOrder).toHaveBeenCalledWith({
			prisma,
			config: expect.objectContaining({ appId: "app-id" }),
			orderId: existingOrder.id,
		});
	});

	test("does not report cancellation when payment won the race", async () => {
		const existingOrder = order();
		const { caller } = createHarness(existingOrder);
		jest.mocked(closePendingAlipayOrder).mockResolvedValue({ state: "FULFILLED" });

		await expect(caller.cancelOrder({ orderId: existingOrder.id })).rejects.toMatchObject(
			{
				code: "CONFLICT",
			},
		);
	});

	test("includes the active unpaid order in the billing overview", async () => {
		const existingOrder = order();
		const { caller } = createHarness(existingOrder);

		await expect(caller.getOverview()).resolves.toMatchObject({
			pendingOrder: {
				id: existingOrder.id,
				orderNo: existingOrder.merchantOrderNo,
				status: "PENDING",
				planId,
				planName: "轻享版",
				durationMonths: 12,
				expiresAt: existingOrder.expiresAt,
			},
		});
	});
});
