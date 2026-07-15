import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enTranslation from "~/locales/en/common.json";
import AdminBilling from "~/pages/admin/billing";
import { api } from "~/utils/api";

jest.mock("~/utils/api", () => ({
	api: {
		billingAdmin: {
			getDashboard: { useQuery: jest.fn() },
			getPlans: { useQuery: jest.fn() },
			savePlan: { useMutation: jest.fn() },
			deletePlan: { useMutation: jest.fn() },
			getOrders: { useQuery: jest.fn() },
			queryOrder: { useMutation: jest.fn() },
			manualRenew: { useMutation: jest.fn() },
			getAlipayConfig: { useQuery: jest.fn() },
			saveAlipayConfig: { useMutation: jest.fn() },
		},
	},
}));

jest.mock("~/server/getServerSideProps", () => ({
	getServerSideProps: jest.fn(),
}));

jest.mock("~/components/layouts/layout", () => ({
	LayoutAdminAuthenticated: ({ children }) => children,
}));

type BillingAdminApiMock = {
	billingAdmin: {
		getDashboard: { useQuery: jest.Mock };
		getPlans: { useQuery: jest.Mock };
		savePlan: { useMutation: jest.Mock };
		deletePlan: { useMutation: jest.Mock };
		getOrders: { useQuery: jest.Mock };
		queryOrder: { useMutation: jest.Mock };
		manualRenew: { useMutation: jest.Mock };
		getAlipayConfig: { useQuery: jest.Mock };
		saveAlipayConfig: { useMutation: jest.Mock };
	};
};

const billingAdminApi = (api as unknown as BillingAdminApiMock).billingAdmin;

describe("Billing administration page", () => {
	const dashboardRefetch = jest.fn();
	const plansRefetch = jest.fn();
	const ordersRefetch = jest.fn();
	const alipayRefetch = jest.fn();
	const savePlan = jest.fn();
	const deletePlan = jest.fn();
	const queryOrder = jest.fn();
	const manualRenew = jest.fn();
	const saveAlipayConfig = jest.fn();
	let queryOrderLoading = false;
	let queryOrderOptions: {
		onSuccess: () => Promise<void>;
		onError: (error: Error) => void;
	};

	const plan = {
		id: "plan-1",
		name: "Pro",
		description: "Five networks",
		priceCents: 9900,
		durationMonths: 12,
		level: 1,
		isActive: true,
		userGroupId: 2,
		userGroupName: "Pro users",
		maxNetworks: 5,
		subscriberCount: 3,
	};

	const renderPage = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<AdminBilling />
			</NextIntlClientProvider>,
		);

	beforeEach(() => {
		queryOrderLoading = false;
		for (const refetch of [
			dashboardRefetch,
			plansRefetch,
			ordersRefetch,
			alipayRefetch,
		]) {
			refetch.mockResolvedValue({ data: undefined });
		}
		billingAdminApi.getDashboard.useQuery.mockReturnValue({
			data: {
				metrics: {
					activeSubscriptions: 1,
					expiringSoon: 0,
					pendingOrders: 2,
					revenueCents: 9900,
				},
				subscriptions: [],
				renewableUsers: [
					{
						id: "user-1",
						name: "Alice",
						email: "alice@example.com",
						isActive: true,
					},
				],
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: dashboardRefetch,
		});
		billingAdminApi.getPlans.useQuery.mockReturnValue({
			data: {
				plans: [plan],
				userGroups: [{ id: 2, name: "Pro users", maxNetworks: 5 }],
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: plansRefetch,
		});
		billingAdminApi.getOrders.useQuery.mockReturnValue({
			data: {
				total: 3,
				orders: [
					{
						id: "pending-order",
						merchantOrderNo: "ZT-PENDING",
						userEmail: "alice@example.com",
						planName: "Pro",
						amountCents: 9900,
						subtotalCents: 9900,
						feeRateBps: 0,
						feeAmountCents: 0,
						status: "PENDING",
						source: "SELF_SERVICE",
						createdAt: "2026-07-14T10:00:00Z",
						alipayTradeNo: null,
					},
					{
						id: "paid-order",
						merchantOrderNo: "ZT-PAID",
						userEmail: "bob@example.com",
						planName: "Pro",
						amountCents: 9900,
						subtotalCents: 9900,
						feeRateBps: 0,
						feeAmountCents: 0,
						status: "PAID",
						source: "SELF_SERVICE",
						createdAt: "2026-07-14T10:01:00Z",
						alipayTradeNo: "20260714001",
					},
					{
						id: "fulfilled-order",
						merchantOrderNo: "ZT-FULFILLED",
						userEmail: "carol@example.com",
						planName: "Pro",
						amountCents: 9900,
						subtotalCents: 9900,
						feeRateBps: 0,
						feeAmountCents: 0,
						status: "FULFILLED",
						source: "SELF_SERVICE",
						createdAt: "2026-07-14T10:02:00Z",
						alipayTradeNo: "20260714002",
					},
				],
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: ordersRefetch,
		});
		billingAdminApi.getAlipayConfig.useQuery.mockReturnValue({
			data: {
				enabled: true,
				appId: "2026000000001",
				gateway: "https://openapi.alipay.com/gateway.do",
				feeRateBps: 60,
				hasPublicKey: true,
				hasPrivateKey: true,
				notifyUrl: "https://ztnet.example/api/billing/alipay/notify",
				returnUrl: "https://ztnet.example/billing/return",
				alipayPublicKey: "SERVER_PUBLIC_KEY_MUST_NOT_RENDER",
				privateKey: "SERVER_SECRET_MUST_NOT_RENDER",
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch: alipayRefetch,
		});
		billingAdminApi.savePlan.useMutation.mockReturnValue({
			mutate: savePlan,
			isLoading: false,
		});
		billingAdminApi.deletePlan.useMutation.mockReturnValue({
			mutate: deletePlan,
			isLoading: false,
		});
		billingAdminApi.queryOrder.useMutation.mockImplementation((options) => {
			queryOrderOptions = options;
			return { mutate: queryOrder, isLoading: queryOrderLoading };
		});
		billingAdminApi.manualRenew.useMutation.mockReturnValue({
			mutate: manualRenew,
			isLoading: false,
		});
		billingAdminApi.saveAlipayConfig.useMutation.mockReturnValue({
			mutate: saveAlipayConfig,
			isLoading: false,
		});
	});

	it("queries only PENDING and PAID orders and exposes live row progress", async () => {
		const user = userEvent.setup();
		const view = renderPage();
		await user.click(screen.getByRole("tab", { name: "Orders" }));

		const queryButtons = screen.getAllByRole("button", { name: /^Query order/ });
		expect(queryButtons).toHaveLength(2);
		expect(screen.queryByRole("button", { name: "Query order ZT-FULFILLED" })).toBeNull();

		await user.click(screen.getByRole("button", { name: "Query order ZT-PENDING" }));
		expect(queryOrder).toHaveBeenCalledWith({ orderId: "pending-order" });

		queryOrderLoading = true;
		view.rerender(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<AdminBilling />
			</NextIntlClientProvider>,
		);
		expect(
			screen.getByText("Querying Alipay and refreshing the order status..."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Query order ZT-PENDING" })).toBeDisabled();

		await act(async () => {
			await queryOrderOptions.onSuccess();
		});
		await waitFor(() => expect(ordersRefetch).toHaveBeenCalledTimes(1));
		expect(dashboardRefetch).toHaveBeenCalledTimes(1);
	});

	it("submits manual renewal without a payment-channel field", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Manual renewal" }));
		expect(screen.queryByText("Payment method")).not.toBeInTheDocument();
		expect(screen.queryByText("Other / offline")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Apply renewal" }));
		expect(manualRenew).toHaveBeenCalledWith({
			userId: "user-1",
			planId: "plan-1",
			durationMonths: 12,
			amountCents: 9900,
			note: "",
		});
		expect(manualRenew.mock.calls[0][0]).not.toHaveProperty("paymentMethod");
	});

	it("never reflects stored Alipay keys and only submits newly entered values", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("tab", { name: "Alipay" }));

		const publicKeyInput = screen.getByLabelText(/^Alipay public key/);
		const privateKeyInput = screen.getByLabelText(/Merchant application private key/);
		expect(publicKeyInput).toHaveValue("");
		expect(privateKeyInput).toHaveValue("");
		expect(screen.getByLabelText("Asynchronous notification URL")).toHaveValue(
			"https://ztnet.example/api/billing/alipay/notify",
		);
		expect(screen.getByLabelText("Browser return URL")).toHaveValue(
			"https://ztnet.example/billing/return",
		);
		expect(screen.queryByDisplayValue("SERVER_PUBLIC_KEY_MUST_NOT_RENDER")).toBeNull();
		expect(screen.queryByDisplayValue("SERVER_SECRET_MUST_NOT_RENDER")).toBeNull();
		expect(screen.getAllByText("Configured")).toHaveLength(2);

		await user.click(screen.getByRole("button", { name: "Save Alipay configuration" }));
		expect(saveAlipayConfig).toHaveBeenLastCalledWith({
			enabled: true,
			appId: "2026000000001",
			gateway: "https://openapi.alipay.com/gateway.do",
			feeRateBps: 60,
			notifyUrl: "https://ztnet.example/api/billing/alipay/notify",
			returnUrl: "https://ztnet.example/billing/return",
		});
		expect(saveAlipayConfig.mock.calls.at(-1)?.[0]).not.toHaveProperty("sellerId");
		expect(saveAlipayConfig.mock.calls.at(-1)?.[0]).not.toHaveProperty("alipayPublicKey");
		expect(saveAlipayConfig.mock.calls.at(-1)?.[0]).not.toHaveProperty("privateKey");

		await user.type(publicKeyInput, "NEW_PUBLIC_KEY");
		await user.type(privateKeyInput, "NEW_PRIVATE_KEY");
		await user.click(screen.getByRole("button", { name: "Save Alipay configuration" }));
		expect(saveAlipayConfig).toHaveBeenLastCalledWith(
			expect.objectContaining({
				alipayPublicKey: "NEW_PUBLIC_KEY",
				privateKey: "NEW_PRIVATE_KEY",
			}),
		);
	});

	it("supports direct plan publication changes", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("tab", { name: "Plans" }));
		await user.click(screen.getByRole("button", { name: "Take Pro off sale" }));

		expect(savePlan).toHaveBeenCalledWith({
			id: "plan-1",
			name: "Pro",
			description: "Five networks",
			priceCents: 9900,
			durationMonths: 12,
			level: 1,
			isActive: false,
			userGroupId: 2,
		});
	});
});
