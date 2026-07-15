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
		amountCents: number;
		subtotalCents: number;
		feeRateBps: number;
		feeAmountCents: number;
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
		getOrderStatus: { useQuery: jest.Mock };
	};
};

const billingApi = (api as unknown as BillingApiMock).billing;

describe("Billing page", () => {
	const overviewRefetch = jest.fn();
	const statusRefetch = jest.fn();
	const createOrder = jest.fn();
	let mutationOptions: MutationOptions;
	let statusOptions: StatusOptions;
	let status = "PENDING";

	const renderPage = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<Billing />
			</NextIntlClientProvider>,
		);

	beforeEach(() => {
		status = "PENDING";
		overviewRefetch.mockResolvedValue({ data: undefined });
		statusRefetch.mockResolvedValue({ data: undefined });
		billingApi.getOverview.useQuery.mockReturnValue({
			data: {
				subscription: null,
				networkUsage: { used: 1, limit: 5 },
				plans: [
					{
						id: "plan-1",
						name: "Pro",
						description: "Five networks",
						priceCents: 9900,
						durationMonths: 12,
						rank: 1,
						maxNetworks: 5,
						isActive: true,
					},
				],
				orders: [],
				paymentFeeRateBps: 60,
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: overviewRefetch,
		});
		billingApi.createOrder.useMutation.mockImplementation((options) => {
			mutationOptions = options;
			return { mutate: createOrder, isLoading: false };
		});
		billingApi.getOrderStatus.useQuery.mockImplementation((_input, options) => {
			statusOptions = options;
			return {
				data: {
					orderId: "order-1",
					orderNo: "ZT202607140001",
					status,
					paymentUrl: "https://alipay.example/pay",
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
		await user.click(screen.getByRole("button", { name: "Buy now" }));

		expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(createOrder).toHaveBeenCalledWith({ planId: "plan-1" });

		act(() =>
			mutationOptions.onSuccess({
				orderId: "order-1",
				orderNo: "ZT202607140001",
				status: "PENDING",
				amountCents: 9959,
				subtotalCents: 9900,
				feeRateBps: 60,
				feeAmountCents: 59,
				paymentUrl: "https://alipay.example/pay",
				expiresAt: "2026-07-14T10:15:00Z",
			}),
		);

		expect(replace).toHaveBeenCalledWith("https://alipay.example/pay");
		expect(screen.getByText("Payment fee (0.60%)")).toBeInTheDocument();
		expect(screen.getByText("CN¥0.59")).toBeInTheDocument();
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
});
