import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import toast from "react-hot-toast";
import {
	PlanetRestartPrompt,
	usePlanetRestartPrompt,
} from "~/components/adminPage/controller/planetRestartPrompt";
import enTranslation from "~/locales/en/common.json";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

jest.mock("~/utils/api", () => ({
	api: {
		admin: {
			getZeroTierRestartStatus: { useQuery: jest.fn() },
			restartZeroTier: { useMutation: jest.fn() },
		},
	},
}));
jest.mock("~/utils/store", () => ({
	useModalStore: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
	__esModule: true,
	default: { success: jest.fn(), error: jest.fn() },
}));

const closeModal = jest.fn();
const callModal = jest.fn();
const restartZeroTier = jest.fn();
let mutationOptions: {
	onSuccess?: (result: { alreadyRunning: boolean }) => void;
	onError?: (error: Error) => void;
};

function renderPrompt(operation: "generated" | "imported" | "restored" = "generated") {
	return render(
		<NextIntlClientProvider locale="en" messages={enTranslation}>
			<PlanetRestartPrompt operation={operation} />
		</NextIntlClientProvider>,
	);
}

describe("PlanetRestartPrompt", () => {
	beforeEach(() => {
		mutationOptions = {};
		(api.admin.getZeroTierRestartStatus.useQuery as jest.Mock).mockReturnValue({
			data: {
				connection: "connected",
				manualCommand: "docker compose restart zerotier",
			},
			isLoading: false,
			isError: false,
			isFetching: false,
		});
		(api.admin.restartZeroTier.useMutation as jest.Mock).mockImplementation((options) => {
			mutationOptions = options;
			return {
				mutate: restartZeroTier,
				isLoading: false,
				isError: false,
				isFetching: false,
			};
		});
		(useModalStore as unknown as jest.Mock).mockImplementation((selector) =>
			selector({ closeModal, callModal }),
		);
	});

	it("offers one-click restart without showing the manual fallback", () => {
		renderPrompt();

		expect(
			screen.getByText("The Planet was generated and saved successfully."),
		).toBeVisible();
		expect(screen.queryByText("docker compose restart zerotier")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Restart ZeroTier now" }));
		expect(restartZeroTier).toHaveBeenCalledTimes(1);
	});

	it("disables one-click restart when the helper is unavailable", () => {
		(api.admin.getZeroTierRestartStatus.useQuery as jest.Mock).mockReturnValue({
			data: {
				connection: "unavailable",
				manualCommand: "sudo systemctl restart zerotier-one",
			},
			isLoading: false,
			isError: false,
		});

		renderPrompt("imported");

		expect(screen.getByRole("button", { name: "Restart ZeroTier now" })).toBeDisabled();
		expect(screen.getByText("sudo systemctl restart zerotier-one")).toBeVisible();
		expect(screen.getByRole("button", { name: "Later" })).toBeEnabled();
	});

	it("prevents duplicate actions while a restart is pending", () => {
		(api.admin.restartZeroTier.useMutation as jest.Mock).mockReturnValue({
			mutate: restartZeroTier,
			isLoading: true,
			isError: false,
		});

		renderPrompt("restored");

		expect(screen.getByRole("button", { name: "Restarting ZeroTier" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Later" })).toBeDisabled();
	});

	it("closes only after restart succeeds", () => {
		renderPrompt();

		act(() => mutationOptions.onSuccess?.({ alreadyRunning: false }));

		expect(toast.success).toHaveBeenCalledWith("ZeroTier restarted successfully");
		expect(closeModal).toHaveBeenCalledTimes(1);
	});

	it("does not report an in-progress restart as completed", () => {
		renderPrompt();

		act(() => mutationOptions.onSuccess?.({ alreadyRunning: true }));

		expect(toast.error).toHaveBeenCalledWith(
			"A ZeroTier restart is already in progress. Wait a moment, then try again.",
		);
		expect(toast.success).not.toHaveBeenCalled();
		expect(closeModal).not.toHaveBeenCalled();
	});

	it("waits for a fresh health check before enabling a cached connection", () => {
		(api.admin.getZeroTierRestartStatus.useQuery as jest.Mock).mockReturnValue({
			data: {
				connection: "connected",
				manualCommand: "docker compose restart zerotier",
			},
			isLoading: false,
			isError: false,
			isFetching: true,
		});

		renderPrompt();

		expect(
			screen.getByText("Checking whether one-click restart is available..."),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Restart ZeroTier now" })).toBeDisabled();
	});

	it("keeps the saved Planet and recovery command visible after restart fails", () => {
		(api.admin.restartZeroTier.useMutation as jest.Mock).mockImplementation((options) => {
			mutationOptions = options;
			return {
				mutate: restartZeroTier,
				isLoading: false,
				isError: true,
			};
		});

		renderPrompt();
		act(() => mutationOptions.onError?.(new Error("helper unavailable")));

		expect(screen.getByText("docker compose restart zerotier")).toBeVisible();
		expect(
			screen.getByText(
				"The Planet configuration is saved, but ZeroTier could not be " +
					"restarted. Use the manual command above.",
			),
		).toBeVisible();
		expect(toast.error).toHaveBeenCalledWith("Unable to restart ZeroTier");
		expect(closeModal).not.toHaveBeenCalled();
	});

	it("opens a dedicated modal with its own asynchronous buttons", () => {
		function Harness() {
			const showPrompt = usePlanetRestartPrompt();
			return (
				<button type="button" onClick={() => showPrompt("restored")}>
					Open
				</button>
			);
		}

		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<Harness />
			</NextIntlClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(callModal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Apply Planet configuration",
				showButtons: false,
				disableClickOutside: true,
				content: expect.any(Object),
			}),
		);
	});
});
