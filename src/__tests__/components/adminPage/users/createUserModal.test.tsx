import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import toast from "react-hot-toast";
import CreateUserModal from "~/components/adminPage/users/createUserModal";
import enTranslation from "~/locales/en/common.json";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

jest.mock("~/utils/api", () => ({
	api: {
		admin: {
			getUserGroups: { useQuery: jest.fn() },
			getUsers: { useQuery: jest.fn() },
			createUser: { useMutation: jest.fn() },
		},
		org: {
			getAllOrg: { useQuery: jest.fn() },
		},
	},
}));

jest.mock("~/utils/store", () => ({
	useModalStore: jest.fn(),
}));

jest.mock("~/hooks/useTrpcApiHandler", () => ({
	useTrpcApiErrorHandler: () => jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
	__esModule: true,
	default: {
		success: jest.fn(),
		error: jest.fn(),
	},
}));

describe("CreateUserModal email validation", () => {
	const createUser = jest.fn();
	const closeModal = jest.fn();

	beforeEach(() => {
		(api.admin.getUserGroups.useQuery as jest.Mock).mockReturnValue({ data: [] });
		(api.org.getAllOrg.useQuery as jest.Mock).mockReturnValue({ data: [] });
		(api.admin.getUsers.useQuery as jest.Mock).mockReturnValue({
			refetch: jest.fn(),
		});
		(api.admin.createUser.useMutation as jest.Mock).mockReturnValue({
			mutate: createUser,
			isLoading: false,
		});
		(useModalStore as unknown as jest.Mock).mockImplementation((selector) =>
			selector({ closeModal }),
		);
	});

	const renderModal = () =>
		render(
			<NextIntlClientProvider locale="en" messages={enTranslation}>
				<CreateUserModal />
			</NextIntlClientProvider>,
		);

	it("shows an immediate error and blocks submission when email contains uppercase letters", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.type(screen.getByPlaceholderText("Enter user name"), "Heodel");
		const emailInput = screen.getByRole("textbox", { name: "Email" });
		await user.type(emailInput, "User@example.com");

		expect(emailInput).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByText("Email address cannot contain uppercase letters"),
		).toBeInTheDocument();
		const submitButton = screen.getByRole("button", { name: "Create User" });
		expect(submitButton).toBeDisabled();

		fireEvent.submit(submitButton.closest("form") as HTMLFormElement);
		expect(toast.error).toHaveBeenCalledWith(
			"Email address cannot contain uppercase letters",
		);
		expect(createUser).not.toHaveBeenCalled();
	});

	it("allows a lowercase email to be submitted unchanged", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.type(screen.getByPlaceholderText("Enter user name"), "Heodel");
		await user.type(screen.getByRole("textbox", { name: "Email" }), "heodel@163.com");
		await user.type(screen.getByPlaceholderText("Enter password"), "!xxB1Yl6L55$");

		const submitButton = screen.getByRole("button", { name: "Create User" });
		expect(submitButton).toBeEnabled();
		await user.click(submitButton);

		expect(createUser).toHaveBeenCalledWith(
			expect.objectContaining({ email: "heodel@163.com" }),
		);
	});
});
