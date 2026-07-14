import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useRouter } from "next/router";
import enTranslation from "~/locales/en/common.json";
import BillingReturn from "~/pages/billing/return";
import { api } from "~/utils/api";

jest.mock("next/router", () => ({
	useRouter: jest.fn(),
}));

jest.mock("~/utils/api", () => ({
	api: {
		billing: {
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

type BillingApiMock = {
	billing: {
		getOrderStatus: { useQuery: jest.Mock };
	};
};

const billingApi = (api as unknown as BillingApiMock).billing;

describe("Billing return page", () => {
	const refetch = jest.fn();
	let queryOptions: {
		enabled: boolean;
		refetchInterval: (data: { status: string } | undefined) => number | false;
	};

	const renderPage = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<BillingReturn />
			</NextIntlClientProvider>,
		);

	beforeEach(() => {
		(useRouter as jest.Mock).mockReturnValue({
			isReady: true,
			query: { orderId: "order-1" },
		});
		refetch.mockResolvedValue({ data: undefined });
		billingApi.getOrderStatus.useQuery.mockImplementation((_input, options) => {
			queryOptions = options;
			return {
				data: {
					orderId: "order-1",
					orderNo: "ZT202607140001",
					status: "PAID",
				},
				isLoading: false,
				isFetching: true,
				isError: false,
				refetch,
			};
		});
	});

	it("polls by orderId and treats PAID as server-side activation in progress", () => {
		renderPage();

		expect(billingApi.getOrderStatus.useQuery).toHaveBeenCalledWith(
			{ orderId: "order-1" },
			expect.objectContaining({
				enabled: true,
				refetchIntervalInBackground: true,
			}),
		);
		expect(screen.getByText("Payment received, activating plan")).toBeInTheDocument();
		expect(screen.queryByText("Plan activated")).not.toBeInTheDocument();
		expect(queryOptions.refetchInterval({ status: "PAID" })).toBe(2_000);
		expect(queryOptions.refetchInterval({ status: "FULFILLED" })).toBe(false);
	});

	it("rejects return links without an orderId without starting polling", () => {
		(useRouter as jest.Mock).mockReturnValue({ isReady: true, query: {} });
		renderPage();

		expect(screen.getByText("Order reference missing")).toBeInTheDocument();
		expect(billingApi.getOrderStatus.useQuery).toHaveBeenCalledWith(
			{ orderId: "" },
			expect.objectContaining({ enabled: false }),
		);
	});
});
