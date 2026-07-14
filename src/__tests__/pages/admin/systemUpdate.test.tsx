import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enTranslation from "~/locales/en/common.json";
import SystemUpdate from "~/pages/admin/system-update";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

jest.mock("~/utils/api", () => ({
	api: {
		admin: {
			getSystemUpdateStatus: { useQuery: jest.fn() },
			triggerSystemUpdate: { useMutation: jest.fn() },
		},
	},
}));

jest.mock("~/utils/store", () => ({
	useModalStore: jest.fn(),
}));

jest.mock("~/server/getServerSideProps", () => ({
	getServerSideProps: jest.fn(),
}));

jest.mock("~/components/layouts/layout", () => ({
	LayoutAdminAuthenticated: ({ children }) => children,
}));

describe("System update admin page", () => {
	const refetch = jest.fn();
	const triggerUpdate = jest.fn();
	const callModal = jest.fn();
	let mutationOptions: { onSuccess?: () => void; onError?: (error: Error) => void };

	beforeEach(() => {
		window.localStorage.clear();
		refetch.mockReset();
		refetch.mockResolvedValue({ data: undefined });
		triggerUpdate.mockReset();
		callModal.mockReset();
		(api.admin.getSystemUpdateStatus.useQuery as jest.Mock).mockReturnValue({
			data: {
				currentVersion: "abc1234567890abc1234567890abc1234567890",
				currentCommit: "abc1234567890abc1234567890abc1234567890",
				latestBuild: {
					commit: "def1234567890def1234567890def1234567890",
					builtAt: "2026-07-14T04:00:00Z",
					url: "https://github.com/example/run",
				},
				updateAvailable: true,
				autoUpdateEnabled: true,
				updateIntervalSeconds: 600,
				updaterConnection: "connected",
				image: "ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest",
				checkedAt: "2026-07-14T04:01:00Z",
			},
			isLoading: false,
			isFetching: false,
			isError: false,
			refetch,
		});
		(api.admin.triggerSystemUpdate.useMutation as jest.Mock).mockImplementation(
			(options) => {
				mutationOptions = options;
				return {
					mutate: triggerUpdate,
					isLoading: false,
				};
			},
		);
		(useModalStore as unknown as jest.Mock).mockReturnValue(callModal);
	});

	const renderPage = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<SystemUpdate />
			</NextIntlClientProvider>,
		);

	it("shows update state and exposes the protected update action", async () => {
		const user = userEvent.setup();
		renderPage();

		expect(screen.getByText("A newer image build is available.")).toBeInTheDocument();
		expect(screen.getByText("abc123456789")).toBeInTheDocument();
		expect(screen.getByText("def123456789")).toBeInTheDocument();
		expect(screen.getByText("10 minutes")).toBeInTheDocument();
		expect(screen.getByText("Connected")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Check now" }));
		expect(refetch).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole("button", { name: "Check and install" }));
		expect(callModal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Check and install updates",
				yesAction: expect.any(Function),
			}),
		);

		act(() => callModal.mock.calls[0][0].yesAction());
		expect(triggerUpdate).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Submitting update request")).toBeInTheDocument();
		expect(screen.getByText("Live")).toBeInTheDocument();

		act(() => mutationOptions.onSuccess?.());
		expect(screen.getByText("Downloading and installing image")).toBeInTheDocument();
		expect(screen.getByText("Install")).toBeInTheDocument();
	});

	it("shows a live animation for manual update checks", async () => {
		const user = userEvent.setup();
		let finishRefetch: (value: unknown) => void;
		refetch.mockReturnValueOnce(
			new Promise((resolve) => {
				finishRefetch = resolve;
			}),
		);
		renderPage();

		await user.click(screen.getByRole("button", { name: "Check now" }));

		expect(screen.getByText("Checking for updates")).toBeInTheDocument();
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();

		act(() => finishRefetch(undefined));
		await waitFor(() =>
			expect(screen.queryByText("Checking for updates")).not.toBeInTheDocument(),
		);
	});

	it("restores update progress after the application container reconnects", async () => {
		window.localStorage.setItem(
			"ztnet-system-update-progress",
			JSON.stringify({
				phase: "reconnecting",
				targetCommit: "def1234567890def1234567890def1234567890",
				startedAt: Date.now(),
				sawDisconnect: true,
			}),
		);

		renderPage();

		expect(await screen.findByText("Verifying the new build")).toBeInTheDocument();
		expect(
			screen.getByText(
				"The application is reachable again and the running build is being verified.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
		expect(api.admin.getSystemUpdateStatus.useQuery).toHaveBeenLastCalledWith(
			undefined,
			expect.objectContaining({ refetchInterval: 2_000 }),
		);
	});
});
