import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import toast from "react-hot-toast";
import Downloads from "~/pages/downloads";
import enTranslation from "~/locales/en/common.json";
import { api } from "~/utils/api";

jest.mock("~/utils/api", () => ({
	api: {
		settings: {
			getAllOptions: { useQuery: jest.fn() },
		},
	},
}));
jest.mock("~/server/getServerSideProps", () => ({
	getServerSideProps: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
	__esModule: true,
	default: { success: jest.fn(), error: jest.fn() },
}));

const getAllOptions = api.settings.getAllOptions.useQuery as unknown as jest.Mock;

function renderPage() {
	return render(
		<NextIntlClientProvider locale="en" messages={enTranslation}>
			<Downloads />
		</NextIntlClientProvider>,
	);
}

describe("Client downloads page", () => {
	let anchorClick: jest.SpyInstance;
	let downloadedFilename: string | undefined;

	beforeEach(() => {
		downloadedFilename = undefined;
		getAllOptions.mockReturnValue({
			data: { siteName: "ZTNET", customPlanetUsed: true },
			isLoading: false,
		});
		Object.defineProperty(window.URL, "createObjectURL", {
			configurable: true,
			value: jest.fn(() => "blob:planet"),
		});
		Object.defineProperty(window.URL, "revokeObjectURL", {
			configurable: true,
			value: jest.fn(),
		});
		anchorClick = jest
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(function (this: HTMLAnchorElement) {
				downloadedFilename = this.download;
			});
	});

	afterEach(() => {
		anchorClick.mockRestore();
		jest.restoreAllMocks();
	});

	it("downloads the response as an extensionless planet file", async () => {
		let resolveDownload: (response: Response) => void;
		global.fetch = jest.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveDownload = resolve;
				}),
		) as jest.Mock;
		renderPage();

		fireEvent.click(screen.getByRole("button", { name: "Download planet" }));
		expect(screen.getByRole("button", { name: "Downloading" })).toBeDisabled();

		resolveDownload(
			new Response(new Blob([new Uint8Array([0x01, 0x00, 0xff])]), { status: 200 }),
		);

		await waitFor(() => expect(downloadedFilename).toBe("planet"));
		expect(global.fetch).toHaveBeenCalledWith("/api/planet", { cache: "no-store" });
		expect(window.URL.revokeObjectURL).toHaveBeenCalledWith("blob:planet");
		expect(toast.success).toHaveBeenCalledWith("Planet download started");
	});

	it("disables download while a custom Planet is unavailable", () => {
		getAllOptions.mockReturnValue({
			data: { siteName: "ZTNET", customPlanetUsed: false },
			isLoading: false,
		});

		renderPage();

		expect(screen.getByRole("button", { name: "Download planet" })).toBeDisabled();
		expect(
			screen.getByText("The administrator has not enabled a custom Planet."),
		).toBeInTheDocument();
	});

	it("keeps the page open and reports a failed download", async () => {
		global.fetch = jest.fn().mockResolvedValue(new Response("missing", { status: 404 }));
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		renderPage();

		fireEvent.click(screen.getByRole("button", { name: "Download planet" }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Unable to download Planet. Try again later.",
			),
		);
		expect(anchorClick).not.toHaveBeenCalled();
	});
});
