import {
	addBillingMonths,
	calculateFeeAmountCents,
	calculatePlanPurchaseTerms,
	calculateUpgradeAmountCents,
	createPendingOrder,
	type BillingDatabase,
} from "~/server/billing/orders";

const AVERAGE_BILLING_MONTH_MS = 2_629_746_000;

describe("billing month arithmetic", () => {
	test.each([
		["a non-leap February", "2025-01-31T12:34:56.789Z", 1, "2025-02-28T12:34:56.789Z"],
		["a leap-year February", "2024-01-31T12:34:56.789Z", 1, "2024-02-29T12:34:56.789Z"],
		[
			"the original day after two months",
			"2025-01-31T12:34:56.789Z",
			2,
			"2025-03-31T12:34:56.789Z",
		],
		["a shorter month", "2025-08-31T12:34:56.789Z", 1, "2025-09-30T12:34:56.789Z"],
		["a year boundary", "2025-12-31T12:34:56.789Z", 2, "2026-02-28T12:34:56.789Z"],
	])("clamps month-end dates for %s", (_case, input, months, expected) => {
		expect(addBillingMonths(new Date(input), months)).toEqual(new Date(expected));
	});
});

describe("plan purchase quantities", () => {
	test("multiplies the plan duration and price by the purchase quantity", () => {
		expect(
			calculatePlanPurchaseTerms({ priceCents: 990, durationMonths: 1 }, 12),
		).toEqual({ amountCents: 11_880, durationMonths: 12 });
	});

	test("rejects quantities that exceed the 120 month order limit", () => {
		expect(() =>
			calculatePlanPurchaseTerms({ priceCents: 9_900, durationMonths: 12 }, 11),
		).toThrow("Total billing duration must not exceed 120 months.");
	});

	test("rejects a multiplied price that cannot fit in an order amount field", () => {
		expect(() =>
			calculatePlanPurchaseTerms({ priceCents: 100_000_000, durationMonths: 1 }, 22),
		).toThrow("Calculated order amount is too large.");
	});
});

describe("upgrade price calculation", () => {
	const now = new Date("2026-07-14T08:00:00.000Z");

	test("charges one exact month of the positive monthly price difference", () => {
		expect(
			calculateUpgradeAmountCents({
				now,
				expiresAt: new Date(now.getTime() + AVERAGE_BILLING_MONTH_MS),
				currentPriceCents: 1_000,
				currentDurationMonths: 1,
				targetPriceCents: 2_500,
				targetDurationMonths: 1,
			}),
		).toBe(1_500);
	});

	test("normalizes plan durations and prorates the remaining period", () => {
		expect(
			calculateUpgradeAmountCents({
				now,
				expiresAt: new Date(now.getTime() + AVERAGE_BILLING_MONTH_MS / 2),
				currentPriceCents: 12_000,
				currentDurationMonths: 12,
				targetPriceCents: 2_400,
				targetDurationMonths: 1,
			}),
		).toBe(700);
	});

	test("rounds any positive prorated difference up to one cent", () => {
		expect(
			calculateUpgradeAmountCents({
				now,
				expiresAt: new Date(now.getTime() + 1),
				currentPriceCents: 1_000,
				currentDurationMonths: 1,
				targetPriceCents: 1_001,
				targetDurationMonths: 1,
			}),
		).toBe(1);
	});

	test("does not charge a supplement after expiry or without a higher monthly price", () => {
		const common = {
			now,
			currentPriceCents: 2_000,
			currentDurationMonths: 1,
			targetPriceCents: 12_000,
			targetDurationMonths: 12,
		};

		expect(calculateUpgradeAmountCents({ ...common, expiresAt: now })).toBe(0);
		expect(
			calculateUpgradeAmountCents({
				...common,
				expiresAt: new Date(now.getTime() + AVERAGE_BILLING_MONTH_MS),
			}),
		).toBe(0);
	});

	test("adds the upgrade supplement to a self-service order and snapshots it", async () => {
		const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "order-1",
			...data,
		}));
		const db = {
			user: {
				findUnique: jest.fn(async () => ({
					id: "user-1",
					isActive: true,
					role: "USER",
				})),
			},
			billingPlan: {
				findUnique: jest.fn(async () => ({
					id: "plan-pro",
					name: "Pro",
					isActive: true,
					level: 2,
					priceCents: 2_500,
					durationMonths: 1,
					userGroupId: 20,
					userGroup: { maxNetworks: 10 },
				})),
			},
			subscription: {
				findUnique: jest.fn(async () => ({
					status: "ACTIVE",
					expiresAt: new Date(now.getTime() + AVERAGE_BILLING_MONTH_MS),
					planPriceCentsSnapshot: 1_000,
					durationMonthsSnapshot: 1,
					planLevelSnapshot: 1,
				})),
			},
			billingOrder: { create },
		} as unknown as BillingDatabase;

		await createPendingOrder({
			db,
			userId: "user-1",
			planId: "plan-pro",
			quantity: 12,
			now,
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				subject: "Pro（12个月）",
				amountCents: 31_500,
				baseAmountCentsSnapshot: 30_000,
				upgradeAmountCentsSnapshot: 1_500,
				planLevelSnapshot: 2,
				durationMonthsSnapshot: 12,
			}),
		});
	});

	test("uses the subscribed level snapshot after a plan is edited", async () => {
		const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "order-1",
			...data,
		}));
		const db = {
			user: {
				findUnique: jest.fn(async () => ({
					id: "user-1",
					isActive: true,
					role: "USER",
				})),
			},
			billingPlan: {
				findUnique: jest.fn(async () => ({
					id: "plan-standard",
					name: "Standard",
					isActive: true,
					level: 2,
					priceCents: 2_500,
					durationMonths: 1,
					userGroupId: 20,
					userGroup: { maxNetworks: 10 },
				})),
			},
			subscription: {
				findUnique: jest.fn(async () => ({
					status: "ACTIVE",
					expiresAt: new Date(now.getTime() + AVERAGE_BILLING_MONTH_MS),
					planPriceCentsSnapshot: 2_500,
					durationMonthsSnapshot: 1,
					planLevelSnapshot: 2,
				})),
			},
			billingOrder: { create },
		} as unknown as BillingDatabase;

		await createPendingOrder({ db, userId: "user-1", planId: "plan-standard", now });

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				amountCents: 2_500,
				upgradeAmountCentsSnapshot: 0,
				planLevelSnapshot: 2,
			}),
		});
	});
});

describe("payment fee calculation", () => {
	test.each([
		[10_000, 60, 60],
		[9_900, 60, 59],
		[101, 100, 1],
		[49, 100, 0],
		[10_000, 0, 0],
	])("rounds %i cents at %i basis points to %i cents", (amount, rate, fee) => {
		expect(calculateFeeAmountCents(amount, rate)).toBe(fee);
	});

	test("adds and snapshots the fee only for self-service orders", async () => {
		const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "order-1",
			...data,
		}));
		const db = {
			user: {
				findUnique: jest.fn(async () => ({
					id: "user-1",
					isActive: true,
					role: "USER",
				})),
			},
			billingPlan: {
				findUnique: jest.fn(async () => ({
					id: "plan-pro",
					name: "Pro",
					isActive: true,
					level: 1,
					priceCents: 9_900,
					durationMonths: 1,
					userGroupId: 20,
					userGroup: { maxNetworks: 10 },
				})),
			},
			subscription: { findUnique: jest.fn(async () => null) },
			billingOrder: { create },
		} as unknown as BillingDatabase;

		await createPendingOrder({
			db,
			userId: "user-1",
			planId: "plan-pro",
			feeRateBps: 60,
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				amountCents: 9_959,
				baseAmountCentsSnapshot: 9_900,
				feeRateBpsSnapshot: 60,
				feeAmountCentsSnapshot: 59,
			}),
		});
	});

	test("charges twelve plan units and calculates the fee from their subtotal", async () => {
		const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
			id: "order-12",
			...data,
		}));
		const db = {
			user: {
				findUnique: jest.fn(async () => ({
					id: "user-1",
					isActive: true,
					role: "USER",
				})),
			},
			billingPlan: {
				findUnique: jest.fn(async () => ({
					id: "plan-monthly",
					name: "轻享版",
					isActive: true,
					level: 1,
					priceCents: 990,
					durationMonths: 1,
					userGroupId: 20,
					userGroup: { maxNetworks: 1 },
				})),
			},
			subscription: { findUnique: jest.fn(async () => null) },
			billingOrder: { create },
		} as unknown as BillingDatabase;

		await createPendingOrder({
			db,
			userId: "user-1",
			planId: "plan-monthly",
			quantity: 12,
			feeRateBps: 60,
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				subject: "轻享版（12个月）",
				amountCents: 11_951,
				baseAmountCentsSnapshot: 11_880,
				planPriceCentsSnapshot: 11_880,
				durationMonthsSnapshot: 12,
				feeRateBpsSnapshot: 60,
				feeAmountCentsSnapshot: 71,
			}),
		});
	});
});
