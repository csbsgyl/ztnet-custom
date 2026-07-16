import { CheckIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { api, type RouterOutputs } from "~/utils/api";

type AdminUser = NonNullable<RouterOutputs["admin"]["getUser"]>;

interface UserPlanProps {
	user: AdminUser;
}

function toLocalDateInput(value: Date | string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function endOfLocalDay(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		23,
		59,
		59,
		999,
	);
	return Number.isNaN(date.getTime()) ? null : date;
}

const UserPlan = ({ user }: UserPlanProps) => {
	const billingT = useTranslations("billing.admin");
	const plansResult = api.billingAdmin.getPlans.useQuery(undefined);
	const { refetch: refetchUser } = api.admin.getUser.useQuery({ userId: user.id });
	const { refetch: refetchUsers } = api.admin.getUsers.useQuery({ isAdmin: false });
	const [planId, setPlanId] = useState(user.subscription?.planId ?? "");
	const [expiration, setExpiration] = useState(
		toLocalDateInput(user.subscription?.expiresAt ?? user.expiresAt),
	);

	useEffect(() => {
		setPlanId(user.subscription?.planId ?? "");
		setExpiration(toLocalDateInput(user.subscription?.expiresAt ?? user.expiresAt));
	}, [user.expiresAt, user.subscription?.expiresAt, user.subscription?.planId]);

	const selectedPlan = useMemo(
		() => plansResult.data?.plans.find((plan) => plan.id === planId),
		[planId, plansResult.data?.plans],
	);
	const savedExpiration = toLocalDateInput(
		user.subscription?.expiresAt ?? user.expiresAt,
	);
	const hasChanges =
		planId !== (user.subscription?.planId ?? "") || expiration !== savedExpiration;
	const needsRestoreRetry = user.suspensionReason === "SUBSCRIPTION_EXPIRED";

	const assignment = api.billingAdmin.assignPlan.useMutation({
		onSuccess: async (result) => {
			await Promise.all([refetchUser(), refetchUsers()]);
			if (result.restoration?.state === "PARTIAL_FAILURE") {
				toast.error(billingT("messages.assignmentRestorePartial"));
				return;
			}
			toast.success(billingT("messages.assignmentSaved"));
		},
		onError: (error) => toast.error(error.message),
	});

	const submit = () => {
		const expiresAt = endOfLocalDay(expiration);
		if (!planId || !expiresAt || expiresAt.getTime() <= Date.now()) {
			toast.error(billingT("validation.assignment"));
			return;
		}
		assignment.mutate({ userId: user.id, planId, expiresAt });
	};

	const today = toLocalDateInput(new Date());

	return (
		<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(11rem,0.7fr)_auto] sm:items-end">
			<label className="form-control min-w-0">
				<span className="label-text mb-1">{billingT("renewal.plan")}</span>
				<select
					className="select select-sm select-bordered w-full"
					value={planId}
					onChange={(event) => setPlanId(event.target.value)}
					disabled={plansResult.isLoading || assignment.isLoading}
				>
					<option value="">{billingT("renewal.selectPlan")}</option>
					{plansResult.data?.plans.map((plan) => (
						<option
							key={plan.id}
							value={plan.id}
							disabled={!plan.isActive && plan.id !== user.subscription?.planId}
						>
							{plan.name} ({plan.maxNetworks})
							{plan.isActive ? "" : ` - ${billingT("plans.inactive")}`}
						</option>
					))}
				</select>
			</label>
			<label className="form-control min-w-0">
				<span className="label-text mb-1">{billingT("subscriptions.expires")}</span>
				<input
					type="date"
					min={today}
					className="input input-sm input-bordered w-full"
					value={expiration}
					onChange={(event) => setExpiration(event.target.value)}
					disabled={assignment.isLoading}
				/>
			</label>
			<button
				type="button"
				className="btn btn-sm btn-primary sm:min-w-24"
				onClick={submit}
				disabled={
					assignment.isLoading ||
					!selectedPlan ||
					!expiration ||
					(!hasChanges && !needsRestoreRetry)
				}
			>
				{assignment.isLoading ? (
					<span className="loading loading-spinner loading-xs" />
				) : (
					<CheckIcon className="h-4 w-4" />
				)}
				{billingT("plans.save")}
			</button>
		</div>
	);
};

export default UserPlan;
