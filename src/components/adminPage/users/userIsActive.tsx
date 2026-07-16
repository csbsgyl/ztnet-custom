import { User } from "@prisma/client";
import { useTranslations } from "next-intl";
import React from "react";
import toast from "react-hot-toast";
import { api } from "~/utils/api";
import {
	useTrpcApiErrorHandler,
	useTrpcApiSuccessHandler,
} from "~/hooks/useTrpcApiHandler";

interface Iuser {
	user: Partial<User>;
}

const UserIsActive = ({ user }: Iuser) => {
	const t = useTranslations("admin");

	const handleApiError = useTrpcApiErrorHandler();
	const handleApiSuccess = useTrpcApiSuccessHandler();

	// Updates this modal as it uses key "getUser"
	// !TODO should rework to update local cache instead.. but this works for now
	const { refetch: refetchUser } = api.admin.getUser.useQuery({
		userId: user?.id,
	});
	const { refetch: refetchUsers } = api.admin.getUsers.useQuery({
		isAdmin: false,
	});

	const { mutate: updateUser } = api.admin.updateUser.useMutation({
		onError: handleApiError,
		onSuccess: handleApiSuccess({ actions: [refetchUser, refetchUsers] }),
	});
	return (
		<div>
			<div className="form-control">
				<div className="max-w-xs">
					<header className="text-sm">
						{t("users.users.userOptionModal.account.userAccountLabel")}
					</header>
					<select
						value={user?.isActive ? "Active" : "Disabled"}
						onChange={(e) => {
							updateUser(
								{
									id: user?.id,
									params: { isActive: e.target.value === "Active" },
								},
								{
									onSuccess: () => {
										toast.success("User updated successfully");
									},
								},
							);
						}}
						className="select select-sm select-bordered select-ghost max-w-xs"
					>
						<option value="Active">Active</option>
						<option value="Disabled">Disabled</option>
					</select>
				</div>
			</div>
		</div>
	);
};

export default UserIsActive;
