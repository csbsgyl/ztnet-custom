import type { PrismaClient } from "@prisma/client";
import { recordVerifiedAlipayPayment } from "~/server/billing/service";

type TestOrder = {
	id: string;
	merchantOrderNo: string;
	userId: string;
	planId: string;
	status: "PENDING" | "PAID" | "FULFILLED" | "FAILED" | "REFUNDED";
	source: "SELF_SERVICE" | "MANUAL_ADMIN";
	amountCents: number;
	planLevelSnapshot: number;
	durationMonthsSnapshot: number;
	maxNetworksSnapshot: number;
	userGroupIdSnapshot: number;
	planPriceCentsSnapshot: number;
	paidAt: Date | null;
	entitlementAppliedAt: Date | null;
	failureReason: string | null;
	plan: { id: string } | null;
	user: { suspensionReason: string };
};

type TestSubscription = {
	id: string;
	userId: string;
	planId: string;
	status: "ACTIVE" | "EXPIRED" | "CANCELLED";
	startsAt: Date;
	expiresAt: Date;
	maxNetworksSnapshot: number;
	userGroupIdSnapshot: number;
	planPriceCentsSnapshot: number;
	durationMonthsSnapshot: number;
	planLevelSnapshot: number;
};

type TestTransaction = {
	orderId: string;
	alipayTradeNo: string;
	buyerId: string | null;
	amountCents: number;
	tradeStatus: string;
	rawPayload: Record<string, string>;
	paidAt: Date;
};

type TestEvent = {
	id: string;
	eventHash: string;
	orderId: string;
	eventType: string;
	rawPayload: Record<string, string>;
	processedAt: Date | null;
	processingError: string | null;
};

function order(overrides: Partial<TestOrder> = {}): TestOrder {
	return {
		id: "order-1",
		merchantOrderNo: "ZT-ORDER-1",
		userId: "user-1",
		planId: "plan-2",
		status: "PENDING",
		source: "SELF_SERVICE",
		amountCents: 2_500,
		planLevelSnapshot: 2,
		durationMonthsSnapshot: 1,
		maxNetworksSnapshot: 10,
		userGroupIdSnapshot: 20,
		planPriceCentsSnapshot: 2_500,
		paidAt: null,
		entitlementAppliedAt: null,
		failureReason: null,
		plan: { id: "plan-2" },
		user: { suspensionReason: "NONE" },
		...overrides,
	};
}

function subscription(overrides: Partial<TestSubscription> = {}): TestSubscription {
	return {
		id: "subscription-1",
		userId: "user-1",
		planId: "plan-2",
		status: "ACTIVE",
		startsAt: new Date("2026-07-01T00:00:00.000Z"),
		expiresAt: new Date("2099-08-01T00:00:00.000Z"),
		maxNetworksSnapshot: 10,
		userGroupIdSnapshot: 20,
		planPriceCentsSnapshot: 2_500,
		durationMonthsSnapshot: 1,
		planLevelSnapshot: 2,
		...overrides,
	};
}

function paymentPayload(
	overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
	return {
		app_id: "2026071400000001",
		seller_id: "2088000000000001",
		out_trade_no: "ZT-ORDER-1",
		trade_no: "TRADE-1",
		trade_status: "TRADE_SUCCESS",
		total_amount: "25.00",
		buyer_id: "buyer-1",
		gmt_payment: "2026-07-14T08:00:00.000Z",
		notify_id: "notify-1",
		...overrides,
	};
}

function createHarness(
	input: {
		orders?: TestOrder[];
		subscriptions?: TestSubscription[];
		transactions?: TestTransaction[];
	} = {},
) {
	const orders = new Map((input.orders ?? [order()]).map((row) => [row.id, { ...row }]));
	const subscriptions = new Map(
		(input.subscriptions ?? []).map((row) => [row.userId, { ...row }]),
	);
	const transactions = new Map(
		(input.transactions ?? []).map((row) => [row.alipayTradeNo, { ...row }]),
	);
	const events = new Map<string, TestEvent>();
	let eventSequence = 0;

	const findOrder = (where: { id?: string; merchantOrderNo?: string }) => {
		if (where.id) return orders.get(where.id) ?? null;
		for (const row of orders.values()) {
			if (row.merchantOrderNo === where.merchantOrderNo) return row;
		}
		return null;
	};

	const billingOrderFindUnique = jest.fn(
		async ({ where }: { where: { id?: string; merchantOrderNo?: string } }) =>
			findOrder(where),
	);
	const billingOrderFindUniqueOrThrow = jest.fn(
		async ({ where }: { where: { id?: string; merchantOrderNo?: string } }) => {
			const row = findOrder(where);
			if (!row) throw new Error("Billing order not found.");
			return row;
		},
	);
	const billingOrderUpdate = jest.fn(
		async ({
			where,
			data,
		}: {
			where: { id: string };
			data: Partial<TestOrder>;
		}) => {
			const row = orders.get(where.id);
			if (!row) throw new Error("Billing order not found.");
			Object.assign(row, data);
			return row;
		},
	);

	const subscriptionFindUnique = jest.fn(
		async ({ where }: { where: { userId: string } }) =>
			subscriptions.get(where.userId) ?? null,
	);
	const subscriptionUpsert = jest.fn(
		async ({
			where,
			create,
			update,
		}: {
			where: { userId: string };
			create: Omit<TestSubscription, "id">;
			update: Partial<TestSubscription>;
		}) => {
			const existing = subscriptions.get(where.userId);
			if (existing) {
				Object.assign(existing, update);
				return existing;
			}
			const created = { id: `subscription-${subscriptions.size + 1}`, ...create };
			subscriptions.set(where.userId, created);
			return created;
		},
	);

	const paymentTransactionFindUnique = jest.fn(
		async ({ where }: { where: { alipayTradeNo: string } }) =>
			transactions.get(where.alipayTradeNo) ?? null,
	);
	const paymentTransactionUpsert = jest.fn(
		async ({
			where,
			create,
			update,
		}: {
			where: { alipayTradeNo: string };
			create: TestTransaction;
			update: Partial<TestTransaction>;
		}) => {
			const existing = transactions.get(where.alipayTradeNo);
			if (existing) {
				Object.assign(existing, update);
				return existing;
			}
			const created = { ...create };
			transactions.set(where.alipayTradeNo, created);
			return created;
		},
	);

	const paymentEventFindUnique = jest.fn(
		async ({ where }: { where: { eventHash: string } }) =>
			events.get(where.eventHash) ?? null,
	);
	const paymentEventCreate = jest.fn(
		async ({
			data,
		}: {
			data: Omit<TestEvent, "id" | "processedAt" | "processingError">;
		}) => {
			eventSequence += 1;
			const created: TestEvent = {
				id: `event-${eventSequence}`,
				processedAt: null,
				processingError: null,
				...data,
			};
			events.set(created.eventHash, created);
			return created;
		},
	);
	const paymentEventUpdate = jest.fn(
		async ({
			where,
			data,
		}: {
			where: { id: string };
			data: Partial<TestEvent>;
		}) => {
			const event = [...events.values()].find((row) => row.id === where.id);
			if (!event) throw new Error("Payment event not found.");
			Object.assign(event, data);
			return event;
		},
	);

	const userUpdate = jest.fn(async () => ({ id: "user-1" }));
	const tx = {
		$executeRaw: jest.fn(async () => 1),
		billingOrder: {
			findUnique: billingOrderFindUnique,
			findUniqueOrThrow: billingOrderFindUniqueOrThrow,
			update: billingOrderUpdate,
		},
		subscription: {
			findUnique: subscriptionFindUnique,
			upsert: subscriptionUpsert,
		},
		paymentTransaction: {
			findUnique: paymentTransactionFindUnique,
			upsert: paymentTransactionUpsert,
		},
		paymentEvent: {
			findUnique: paymentEventFindUnique,
			create: paymentEventCreate,
			update: paymentEventUpdate,
		},
		user: { update: userUpdate },
	};
	const prisma = {
		$transaction: jest.fn(
			async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
		),
	} as unknown as PrismaClient;

	return {
		prisma,
		state: { orders, subscriptions, transactions, events },
		mocks: {
			billingOrderUpdate,
			subscriptionUpsert,
			paymentTransactionUpsert,
			paymentEventCreate,
			paymentEventUpdate,
			userUpdate,
		},
	};
}

describe("verified Alipay payment recording", () => {
	test("records an exact duplicate notification only once without applying entitlement", async () => {
		const harness = createHarness();
		const payload = paymentPayload();

		await recordVerifiedAlipayPayment({ prisma: harness.prisma, payload });
		await recordVerifiedAlipayPayment({ prisma: harness.prisma, payload });

		expect(harness.mocks.paymentEventCreate).toHaveBeenCalledTimes(1);
		expect(harness.mocks.paymentEventUpdate).toHaveBeenCalledTimes(1);
		expect(harness.mocks.paymentTransactionUpsert).toHaveBeenCalledTimes(1);
		expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
		expect(harness.state.subscriptions.size).toBe(0);
		expect(harness.state.orders.get("order-1")).toMatchObject({
			status: "PAID",
			entitlementAppliedAt: null,
		});
	});

	test("keeps entitlement application out of later payment status events", async () => {
		const harness = createHarness();
		await recordVerifiedAlipayPayment({
			prisma: harness.prisma,
			payload: paymentPayload(),
		});
		await recordVerifiedAlipayPayment({
			prisma: harness.prisma,
			payload: paymentPayload({
				trade_status: "TRADE_FINISHED",
				notify_id: "notify-2",
			}),
		});

		expect(harness.mocks.paymentEventCreate).toHaveBeenCalledTimes(2);
		expect(harness.mocks.paymentTransactionUpsert).toHaveBeenCalledTimes(2);
		expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
		expect(harness.state.subscriptions.size).toBe(0);
	});

	test("does not allow an Alipay trade number to be reused by another order", async () => {
		const harness = createHarness({
			orders: [
				order(),
				order({
					id: "order-2",
					merchantOrderNo: "ZT-ORDER-2",
					userId: "user-2",
				}),
			],
		});
		await recordVerifiedAlipayPayment({
			prisma: harness.prisma,
			payload: paymentPayload(),
		});

		await expect(
			recordVerifiedAlipayPayment({
				prisma: harness.prisma,
				payload: paymentPayload({
					out_trade_no: "ZT-ORDER-2",
					notify_id: "notify-order-2",
				}),
			}),
		).rejects.toThrow("trade number is already bound to another order");
		expect(harness.state.orders.get("order-2")?.status).toBe("PENDING");
		expect(harness.mocks.paymentEventCreate).toHaveBeenCalledTimes(1);
		expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
	});

	test("marks a paid stale lower-level order failed instead of downgrading", async () => {
		const currentSubscription = subscription({
			planId: "plan-3",
			planLevelSnapshot: 3,
			maxNetworksSnapshot: 30,
			userGroupIdSnapshot: 30,
		});
		const harness = createHarness({
			orders: [
				order({
					planId: "plan-1",
					plan: { id: "plan-1" },
					planLevelSnapshot: 1,
					maxNetworksSnapshot: 3,
					userGroupIdSnapshot: 10,
				}),
			],
			subscriptions: [currentSubscription],
		});

		const result = await recordVerifiedAlipayPayment({
			prisma: harness.prisma,
			payload: paymentPayload(),
		});

		expect(result).toMatchObject({
			status: "FAILED",
			failureReason: expect.stringContaining("would downgrade"),
		});
		expect(harness.state.subscriptions.get("user-1")).toMatchObject({
			planId: "plan-3",
			planLevelSnapshot: 3,
			maxNetworksSnapshot: 30,
		});
		expect(harness.mocks.paymentTransactionUpsert).toHaveBeenCalledTimes(1);
		expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
		expect(harness.mocks.paymentEventUpdate).toHaveBeenCalledWith({
			where: { id: "event-1" },
			data: { processedAt: expect.any(Date), processingError: null },
		});
	});

	test("never applies a stale lower-level order after the higher plan expires", async () => {
		const harness = createHarness({
			orders: [order({ planLevelSnapshot: 1, planId: "plan-1" })],
			subscriptions: [
				subscription({
					planId: "plan-3",
					planLevelSnapshot: 3,
					status: "EXPIRED",
					expiresAt: new Date("2026-07-01T00:00:00.000Z"),
				}),
			],
		});

		const result = await recordVerifiedAlipayPayment({
			prisma: harness.prisma,
			payload: paymentPayload(),
		});

		expect(result.status).toBe("FAILED");
		expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
	});

	test.each(["FAILED", "REFUNDED"] as const)(
		"keeps a %s order terminal when another payment event arrives",
		async (status) => {
			const harness = createHarness({
				orders: [order({ status })],
			});

			const result = await recordVerifiedAlipayPayment({
				prisma: harness.prisma,
				payload: paymentPayload(),
			});

			expect(result.status).toBe(status);
			expect(harness.mocks.subscriptionUpsert).not.toHaveBeenCalled();
			expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
		},
	);
});
