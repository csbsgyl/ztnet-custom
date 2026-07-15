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

import type { Session } from "~/lib/authTypes";
import { billingRouter } from "~/server/api/routers/billingRouter";
import { createPendingOrder } from "~/server/billing/orders";

const planId = "clz0000000000000000000001";
const session = {
	expires: "2099-01-01T00:00:00.000Z",
	user: { id: "user-1", role: "USER" },
} as Session;

const order = (overrides: Record<string, unknown> = {}) => ({
	id: "order-new",
	merchantOrderNo: "ZT202607150001",
	planId,
	status: "PENDING",
	amountCents: 11_951,
	baseAmountCentsSnapshot: 11_880,
	upgradeAmountCentsSnapshot: 0,
	feeRateBpsSnapshot: 60,
	feeAmountCentsSnapshot: 71,
	durationMonthsSnapshot: 12,
	subject: "轻享版（12个月）",
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
		globalOptions: { findUnique: jest.fn(async () => ({})) },
		$transaction: jest.fn(async (operation) => operation(transaction)),
	};
	const caller = billingRouter.createCaller({
		session,
		prisma,
		wss: null,
		res: null,
	} as never);
	return { caller, updateMany };
}

describe("billing order quantity reuse", () => {
	beforeEach(() => {
		jest.mocked(createPendingOrder).mockReset();
	});

	test("reuses a pending order only when its quantity snapshots still match", async () => {
		const existingOrder = order();
		const { caller, updateMany } = createHarness(existingOrder);

		const result = await caller.createOrder({ planId, quantity: 12 });

		expect(result).toMatchObject({
			orderId: "order-new",
			durationMonths: 12,
			amountCents: 11_951,
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(createPendingOrder).not.toHaveBeenCalled();
	});

	test("closes an old pending order when the purchase quantity changes", async () => {
		const existingOrder = order({
			id: "order-old",
			amountCents: 996,
			baseAmountCentsSnapshot: 990,
			feeAmountCentsSnapshot: 6,
			durationMonthsSnapshot: 1,
			subject: "轻享版（1个月）",
		});
		const newOrder = order();
		jest.mocked(createPendingOrder).mockResolvedValue(newOrder as never);
		const { caller, updateMany } = createHarness(existingOrder);

		const result = await caller.createOrder({ planId, quantity: 12 });

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				source: "SELF_SERVICE",
				status: "PENDING",
			},
			data: { status: "CLOSED", closedAt: expect.any(Date) },
		});
		expect(createPendingOrder).toHaveBeenCalledWith({
			db: expect.any(Object),
			userId: "user-1",
			planId,
			quantity: 12,
			feeRateBps: 60,
		});
		expect(result.durationMonths).toBe(12);
	});
});
