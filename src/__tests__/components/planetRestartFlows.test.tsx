import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import PrivateRoot from "~/components/adminPage/controller/privateRoot";
import RootForm from "~/components/adminPage/controller/rootForm";
import { usePlanetRestartPrompt } from "~/components/adminPage/controller/planetRestartPrompt";
import enTranslation from "~/locales/en/common.json";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

jest.mock("~/utils/api", () => ({
	api: {
		admin: {
			getPlanet: { useQuery: jest.fn() },
			getIdentity: { useQuery: jest.fn() },
			makeWorld: { useMutation: jest.fn() },
			resetWorld: { useMutation: jest.fn() },
		},
	},
}));
jest.mock("~/utils/store", () => ({
	useModalStore: jest.fn(),
}));
jest.mock("~/components/adminPage/controller/planetRestartPrompt", () => ({
	usePlanetRestartPrompt: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
	__esModule: true,
	default: { success: jest.fn(), error: jest.fn() },
}));

const showPlanetRestartPrompt = jest.fn();
const callModal = jest.fn();
const refetchPlanet = jest.fn();
let makeWorldOptions: { onSuccess?: () => void };
let resetWorldOptions: { onSuccess?: () => void };

function renderWithMessages(component: ReactNode) {
	return render(
		<NextIntlClientProvider locale="en" messages={enTranslation}>
			{component}
		</NextIntlClientProvider>,
	);
}

describe("Planet restart success flows", () => {
	beforeEach(() => {
		makeWorldOptions = {};
		resetWorldOptions = {};
		(usePlanetRestartPrompt as jest.Mock).mockReturnValue(showPlanetRestartPrompt);
		(useModalStore as unknown as jest.Mock).mockImplementation((selector) =>
			selector({ callModal }),
		);
		(api.admin.getIdentity.useQuery as jest.Mock).mockReturnValue({
			data: { ip: "203.0.113.10", identity: "abcdef:0:identity" },
		});
		(api.admin.makeWorld.useMutation as jest.Mock).mockImplementation((options) => {
			makeWorldOptions = options;
			return { mutate: jest.fn(), isLoading: false };
		});
		(api.admin.resetWorld.useMutation as jest.Mock).mockImplementation((options) => {
			resetWorldOptions = options;
			return { mutate: jest.fn(), isLoading: false };
		});
	});

	it("prompts after local generation or update succeeds", () => {
		(api.admin.getPlanet.useQuery as jest.Mock).mockReturnValue({
			data: null,
			refetch: refetchPlanet,
		});
		renderWithMessages(<RootForm onClose={jest.fn()} />);

		act(() => makeWorldOptions.onSuccess?.());

		expect(showPlanetRestartPrompt).toHaveBeenCalledWith("generated");
	});

	it("prompts after an uploaded Planet configuration succeeds", async () => {
		(api.admin.getPlanet.useQuery as jest.Mock).mockReturnValue({
			data: null,
			refetch: refetchPlanet,
		});
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue({ message: "ok" }),
		});
		const { container } = renderWithMessages(<PrivateRoot />);
		const fileInput = container.querySelector("#fileInput") as HTMLInputElement;

		fireEvent.change(fileInput, {
			target: { files: [new File(["world"], "world.zip", { type: "application/zip" })] },
		});

		await waitFor(() => expect(showPlanetRestartPrompt).toHaveBeenCalledWith("imported"));
		expect(refetchPlanet).toHaveBeenCalled();
	});

	it("prompts after restoring the original Planet succeeds", () => {
		(api.admin.getPlanet.useQuery as jest.Mock).mockReturnValue({
			data: {
				id: 1,
				rootNodes: [
					{
						id: 1,
						comments: "local",
						endpoints: ["203.0.113.10/9993"],
						identity: "abcdef:0:identity",
					},
				],
			},
			refetch: refetchPlanet,
		});
		renderWithMessages(<PrivateRoot />);

		act(() => resetWorldOptions.onSuccess?.());

		expect(showPlanetRestartPrompt).toHaveBeenCalledWith("restored");
		expect(refetchPlanet).toHaveBeenCalled();
	});
});
