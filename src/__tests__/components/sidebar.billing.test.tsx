import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useRouter } from "next/router";
import Sidebar from "~/components/layouts/sidebar";
import enTranslation from "~/locales/en/common.json";
import { api } from "~/utils/api";
import { useSidebarStore, useSocketStore } from "~/utils/store";

jest.mock("next/router", () => ({
	useRouter: jest.fn(),
}));

jest.mock("~/lib/authClient", () => ({
	signOut: jest.fn(),
}));

jest.mock("~/utils/api", () => ({
	api: {
		auth: { me: { useQuery: jest.fn() } },
		org: { getOrgNotifications: { useQuery: jest.fn() } },
	},
}));

jest.mock("~/utils/store", () => ({
	useSidebarStore: jest.fn(),
	useSocketStore: jest.fn(),
}));

type ApiMock = {
	auth: { me: { useQuery: jest.Mock } };
	org: { getOrgNotifications: { useQuery: jest.Mock } };
};

const mockedApi = api as unknown as ApiMock;

describe("Sidebar billing navigation", () => {
	const renderSidebar = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<Sidebar />
			</NextIntlClientProvider>,
		);

	beforeEach(() => {
		(useRouter as jest.Mock).mockReturnValue({ pathname: "/network", query: {} });
		(useSidebarStore as unknown as jest.Mock).mockReturnValue({
			open: true,
			setOpenState: jest.fn(),
		});
		(useSocketStore as unknown as jest.Mock).mockReturnValue({
			setBulkNewMessages: jest.fn(),
			hasNewMessages: {},
		});
		mockedApi.org.getOrgNotifications.useQuery.mockReturnValue({ data: undefined });
	});

	it("links non-admin users to their billing page", () => {
		mockedApi.auth.me.useQuery.mockReturnValue({
			data: { role: "USER", options: {}, memberOfOrgs: [] },
		});
		renderSidebar();

		expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute(
			"href",
			"/billing",
		);
		expect(screen.getByRole("link", { name: "Client Downloads" })).toHaveAttribute(
			"href",
			"/downloads",
		);
	});

	it("links administrators to billing administration only", () => {
		mockedApi.auth.me.useQuery.mockReturnValue({
			data: { role: "ADMIN", options: {}, memberOfOrgs: [] },
		});
		renderSidebar();

		const billingLinks = screen.getAllByRole("link", { name: "Billing" });
		expect(billingLinks).toHaveLength(1);
		expect(billingLinks[0]).toHaveAttribute("href", "/admin/billing");
	});
});
