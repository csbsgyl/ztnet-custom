import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enTranslation from "~/locales/en/common.json";
import Billing from "~/pages/billing";
import { api } from "~/utils/api";

jest.mock("~/utils/api", () => ({
	api: {
		billing: {
			getOverview: { useQuery: jest.fn() },
			createOrder: { useMutation: jest.fn() },
			resumeOrder: { useMutation: jest.fn() },
			cancelOrder: { useMutation: jest.fn() },
			getOrderStatus: { useQuery: jest.fn() },
		},
	},
}));

jest.mock("~/server/getServerSideProps", () => ({
	getServerSideProps: jest.fn(),
}));

jest.mock("~/components/layouts/layout", () => ({
	LayoutAuthenticated: ({ children }) => children,
}));

type MutationOptions = {
	onSuccess: (data: {
		orderId: string;
		orderNo: string;
		status: string;
		planId: string | null;
		planName: string;
		amountCents: number;
		subtotalCents: number;
		feeRateBps: number;
		feeAmountCents: number;
		durationMonths: number;
		paymentUrl: string;
		expiresAt: string;
	}) => void;
	onError: (error: Error) => void;
};

type StatusOptions = {
	refetchInterval: (data: { status: string } | undefined) => number | false;
};

type BillingApiMock = {
	billing: {
		getOverview: { useQuery: jest.Mock };
		createOrder: { useMutation: jest.Mock };
		resumeOrder: { useMutation: jest.Mock };
		cancelOrder: { useMutation: jest.Mock };
		getOrderStatus: { useQuery: jest.Mock };
	};
};

const billingApi = (api as unknown as BillingApiMock).billing;

describe("Billing page", () => {
	const overviewRefetch = jest.fn();
	const statusRefetch = jest.fn();
	const createOrder = jest.fn();
	const resumeOrder = jest.fn();
	const cancelOrder = jest.fn();
	let mutationOptions: MutationOptions;
	let resumeOptions: MutationOptions;
	let cancelOptions: { onSuccess: () => void; onError: (error: Error) => void };
	let statusOptions: StatusOptions;
	let status = "PENDING";
	let pendingOrder: Record<string, unknown> | null = null;

	const renderPage = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<Billing />
			</NextIntlClientProvider>,
		);

	beforeEach(() => {
		status = "PENDING";
		pendingOrder = null;
		overviewRefetch.mockResolvedValue({ data: undefined });
		statusRefetch.mockResolvedValue({ data: undefined });
		billingApi.getOverview.useQuery.mockImplementation(() => ({
			data: {
				subscription: null,
				networkUsage: { used: 1, limit: 5 },
				plans: [
					{
						id: "plan-1",
						name: "Pro",
						description: "Five networks",
						priceCents: 990,
						durationMonths: 1,
						upgradeAmountCents: 0,
						rank: 1,
						maxNetworks: 5,
						isActive: true,
					},
				],
				orders: [],
				pendingOrder,
				paymentFeeRateBps: 60,
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: overviewRefetch,
		}));
		billingApi.createOrder.useMutation.mockImplementation((options) => {
			mutationOptions = options;
			return { mutate: createOrder, isLoading: false };
		});
		billingApi.resumeOrder.useMutation.mockImplementation((options) => {
			resumeOptions = options;
			return { mutate: resumeOrder, isLoading: false };
		});
		billingApi.cancelOrder.useMutation.mockImplementation((options) => {
			cancelOptions = options;
			return { mutate: cancelOrder, isLoading: false };
		});
		billingApi.getOrderStatus.useQuery.mockImplementation((_input, options) => {
			statusOptions = options;
			return {
				data: {
					orderId: "order-1",
					orderNo: "ZT202607140001",
					status,
					paymentUrl: "https://alipay.example/pay",
					expiresAt: "2099-07-14T10:15:00Z",
				},
				isLoading: false,
				isFetching: false,
				isError: false,
				refetch: statusRefetch,
			};
		});
	});

	it("opens a payment window from the click and keeps PAID in the confirming phase", async () => {
		const user = userEvent.setup();
		const replace = jest.fn();
		const close = jest.fn();
		const paymentWindow = {
			closed: false,
			opener: window,
			location: { replace },
			close,
		} as unknown as Window;
		jest.spyOn(window, "open").mockReturnValue(paymentWindow);
		status = "PAID";

		const view = renderPage();
		expect(screen.getByText("Create up to 5 network IDs")).toBeInTheDocument();
		expect(screen.queryByText("Up to 5 personal networks")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Buy now" }));

		expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(createOrder).toHaveBeenCalledWith({ planId: "plan-1", quantity: 1 });

		act(() =>
			mutationOptions.onSuccess({
				orderId: "order-1",
				orderNo: "ZT202607140001",
				status: "PENDING",
				planId: "plan-1",
				planName: "Pro",
				amountCents: 996,
				subtotalCents: 990,
				feeRateBps: 60,
				feeAmountCents: 6,
				durationMonths: 1,
				paymentUrl: "https://alipay.example/pay",
				expiresAt: "2099-07-14T10:15:00Z",
			}),
		);

		expect(replace).toHaveBeenCalledWith("https://alipay.example/pay");
		expect(screen.getByText("Payment fee (0.60%)")).toBeInTheDocument();
		expect(screen.getByText("CN¥0.06")).toBeInTheDocument();
		expect(await screen.findByText("Confirming payment")).toBeInTheDocument();
		expect(screen.queryByText("Plan activated")).not.toBeInTheDocument();
		expect(statusOptions.refetchInterval({ status: "PAID" })).toBe(2_000);
		expect(overviewRefetch).not.toHaveBeenCalled();

		status = "FULFILLED";
		view.rerender(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<Billing />
			</NextIntlClientProvider>,
		);

		expect(await screen.findByText("Plan activated")).toBeInTheDocument();
		expect(statusOptions.refetchInterval({ status: "FULFILLED" })).toBe(false);
		expect(statusOptions.refetchInterval({ status: "REFUNDED" })).toBe(false);
		await waitFor(() => expect(overviewRefetch).toHaveBeenCalledTimes(1));
	});

	it("updates the duration and price before ordering multiple plan units", async () => {
		const user = userEvent.setup();
		jest.spyOn(window, "open").mockReturnValue({
			closed: false,
			opener: window,
			location: { replace: jest.fn() },
			close: jest.fn(),
		} as unknown as Window);

		renderPage();
		const increaseButton = screen.getByRole("button", {
			name: "Increase purchase quantity",
		});
		for (let quantity = 1; quantity < 12; quantity += 1) {
			await user.click(increaseButton);
		}

		expect(screen.getByRole("spinbutton", { name: "Purchase quantity" })).toHaveValue(12);
		expect(screen.getByText("12 months")).toBeInTheDocument();
		expect(screen.getByText("CN¥118.80")).toBeInTheDocument();
		expect(screen.getByText("CN¥119.51")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Buy now" }));
		expect(createOrder).toHaveBeenCalledWith({ planId: "plan-1", quantity: 12 });
	});

	it("restores an unpaid order, blocks a second order, and resumes payment", async () => {
		pendingOrder = {
			id: "order-1",
			orderNo: "ZT202607140001",
			status: "PENDING",
			planId: "plan-1",
			planName: "Pro",
			amountCents: 996,
			subtotalCents: 990,
			feeRateBps: 60,
			feeAmountCents: 6,
			durationMonths: 1,
			expiresAt: "2099-07-14T10:15:00Z",
		};
		const replace = jest.fn();
		jest.spyOn(window, "open").mockReturnValue({
			closed: false,
			opener: window,
			location: { replace },
			close: jest.fn(),
		} as unknown as Window);
		const user = userEvent.setup();

		renderPage();
		expect(await screen.findByText("You have an unpaid order")).toBeInTheDocument();
		expect(screen.getByText("Time remaining")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Buy now" }));
		expect(createOrder).not.toHaveBeenCalled();
		expect(window.open).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Continue payment" }));
		expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(resumeOrder).toHaveBeenCalledWith({ orderId: "order-1" });

		act(() =>
			resumeOptions.onSuccess({
				orderId: "order-1",
				orderNo: "ZT202607140001",
				status: "PENDING",
				planId: "plan-1",
				planName: "Pro",
				amountCents: 996,
				subtotalCents: 990,
				feeRateBps: 60,
				feeAmountCents: 6,
				durationMonths: 1,
				paymentUrl: "https://alipay.example/pay",
				expiresAt: "2099-07-14T10:15:00Z",
			}),
		);
		expect(replace).toHaveBeenCalledWith("https://alipay.example/pay");
	});

	it("cancels an unpaid order and refreshes the overview", async () => {
		pendingOrder = {
			id: "order-1",
			orderNo: "ZT202607140001",
			status: "PENDING",
			planId: "plan-1",
			planName: "Pro",
			amountCents: 996,
			subtotalCents: 990,
			feeRateBps: 60,
			feeAmountCents: 6,
			durationMonths: 1,
			expiresAt: "2099-07-14T10:15:00Z",
		};
		const paymentWindowClose = jest.fn();
		jest.spyOn(window, "open").mockReturnValue({
			closed: false,
			opener: window,
			location: { replace: jest.fn() },
			close: paymentWindowClose,
		} as unknown as Window);
		jest.spyOn(window, "confirm").mockReturnValue(true);
		const user = userEvent.setup();

		renderPage();
		await user.click(await screen.findByRole("button", { name: "Continue payment" }));
		act(() =>
			resumeOptions.onSuccess({
				orderId: "order-1",
				orderNo: "ZT202607140001",
				status: "PENDING",
				planId: "plan-1",
				planName: "Pro",
				amountCents: 996,
				subtotalCents: 990,
				feeRateBps: 60,
				feeAmountCents: 6,
				durationMonths: 1,
				paymentUrl: "https://alipay.example/pay",
				expiresAt: "2099-07-14T10:15:00Z",
			}),
		);
		await user.click(await screen.findByRole("button", { name: "Cancel order" }));
		expect(cancelOrder).toHaveBeenCalledWith({ orderId: "order-1" });

		act(() => cancelOptions.onSuccess());
		expect(screen.queryByText("You have an unpaid order")).toBeNull();
		expect(paymentWindowClose).toHaveBeenCalledTimes(1);
		expect(overviewRefetch).toHaveBeenCalledTimes(1);
	});

	it("ends payment at the five-minute deadline and refreshes the order", async () => {
		jest.useFakeTimers().setSystemTime(new Date("2026-07-15T10:14:59.000Z"));
		pendingOrder = {
			id: "order-1",
			orderNo: "ZT202607140001",
			status: "PENDING",
			planId: "plan-1",
			planName: "Pro",
			amountCents: 996,
			subtotalCents: 990,
			feeRateBps: 60,
			feeAmountCents: 6,
			durationMonths: 1,
			expiresAt: "2026-07-15T10:15:00.000Z",
		};

		renderPage();
		expect(screen.getByText("00:01")).toBeInTheDocument();

		act(() => jest.advanceTimersByTime(1_000));
		expect(screen.getByText("Payment not completed")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Continue payment" })).toBeNull();
		expect(statusRefetch).toHaveBeenCalledTimes(1);
		expect(overviewRefetch).toHaveBeenCalledTimes(1);
		jest.useRealTimers();
	});
});
