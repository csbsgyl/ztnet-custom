import {
	ArrowPathIcon,
	CheckCircleIcon,
	CloudArrowDownIcon,
	ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import toast from "react-hot-toast";
import { LayoutAdminAuthenticated } from "~/components/layouts/layout";
import MenuSectionDividerWrapper from "~/components/shared/menuSectionDividerWrapper";
import { useTrpcApiErrorHandler } from "~/hooks/useTrpcApiHandler";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

const shortVersion = (version: string | null | undefined) => {
	if (!version) return null;
	return version.length > 12 ? version.slice(0, 12) : version;
};

const SystemUpdate = () => {
	const t = useTranslations("admin.systemUpdate");
	const callModal = useModalStore((state) => state.callModal);
	const handleApiError = useTrpcApiErrorHandler();
	const {
		data: status,
		isLoading,
		isFetching,
		refetch,
	} = api.admin.getSystemUpdateStatus.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});
	const { mutate: triggerUpdate, isLoading: isTriggering } =
		api.admin.triggerSystemUpdate.useMutation({
			onSuccess: () => {
				toast.success(t("updateRequested"));
				setTimeout(() => void refetch(), 3000);
			},
			onError: handleApiError,
		});

	const formatDate = (value: string | null | undefined) =>
		value
			? new Intl.DateTimeFormat(undefined, {
					dateStyle: "medium",
					timeStyle: "medium",
				}).format(new Date(value))
			: t("unknown");

	const formatInterval = (seconds: number | undefined) => {
		if (!seconds) return t("unknown");
		if (seconds % 3600 === 0) return t("hours", { count: seconds / 3600 });
		if (seconds % 60 === 0) return t("minutes", { count: seconds / 60 });
		return t("seconds", { count: seconds });
	};

	const connectionLabel = status
		? t(`connection.${status.updaterConnection}`)
		: t("unknown");
	const canTrigger = status?.updaterConnection === "connected";
	const updateState =
		status?.updateAvailable === true
			? "available"
			: status?.updateAvailable === false
				? "current"
				: "unknown";

	const requestUpdate = () => {
		callModal({
			title: t("confirmTitle"),
			description: t("confirmDescription"),
			yesAction: () => triggerUpdate(),
		});
	};

	if (isLoading) {
		return (
			<div className="flex min-h-48 items-center justify-center">
				<span className="loading loading-spinner loading-md" />
			</div>
		);
	}

	return (
		<main className="space-y-8">
			<MenuSectionDividerWrapper title={t("statusTitle")} className="space-y-5">
				<div
					role="status"
					className={`alert ${
						updateState === "available"
							? "alert-warning"
							: updateState === "current"
								? "alert-success"
								: "alert-info"
					}`}
				>
					{updateState === "available" ? (
						<ExclamationTriangleIcon className="h-6 w-6 shrink-0" />
					) : updateState === "current" ? (
						<CheckCircleIcon className="h-6 w-6 shrink-0" />
					) : (
						<ArrowPathIcon className="h-6 w-6 shrink-0" />
					)}
					<span>{t(`state.${updateState}`)}</span>
				</div>

				<dl className="border-y border-base-300 divide-y divide-base-300">
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("currentBuild")}</dt>
						<dd className="font-mono text-sm break-all">
							{shortVersion(status?.currentCommit || status?.currentVersion) ||
								t("unknown")}
						</dd>
					</div>
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("latestBuild")}</dt>
						<dd className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
							{status?.latestBuild ? (
								<>
									<a
										className="link link-primary font-mono"
										href={status.latestBuild.url || undefined}
										target="_blank"
										rel="noreferrer"
									>
										{shortVersion(status.latestBuild.commit)}
									</a>
									<span className="text-base-content/55">
										{formatDate(status.latestBuild.builtAt)}
									</span>
								</>
							) : (
								t("unknown")
							)}
						</dd>
					</div>
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("imageSource")}</dt>
						<dd className="font-mono text-sm break-all">
							{status?.image || t("unknown")}
						</dd>
					</div>
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("lastChecked")}</dt>
						<dd className="text-sm">{formatDate(status?.checkedAt)}</dd>
					</div>
				</dl>

				<div className="flex flex-wrap justify-end gap-2">
					<button
						className="btn btn-sm btn-ghost"
						onClick={() => void refetch()}
						disabled={isFetching}
					>
						<ArrowPathIcon className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
						{t("checkNow")}
					</button>
					<button
						className="btn btn-sm btn-primary"
						onClick={requestUpdate}
						disabled={!canTrigger || isTriggering}
					>
						{isTriggering ? (
							<span className="loading loading-spinner loading-xs" />
						) : (
							<CloudArrowDownIcon className="h-4 w-4" />
						)}
						{t("installNow")}
					</button>
				</div>
			</MenuSectionDividerWrapper>

			<MenuSectionDividerWrapper title={t("automationTitle")} className="space-y-5">
				<dl className="border-y border-base-300 divide-y divide-base-300">
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("automaticUpdates")}</dt>
						<dd>
							<span
								className={`badge ${status?.autoUpdateEnabled ? "badge-success" : "badge-ghost"}`}
							>
								{status?.autoUpdateEnabled ? t("enabled") : t("disabled")}
							</span>
						</dd>
					</div>
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("checkInterval")}</dt>
						<dd className="text-sm">{formatInterval(status?.updateIntervalSeconds)}</dd>
					</div>
					<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
						<dt className="text-sm text-base-content/65">{t("updaterConnection")}</dt>
						<dd>
							<span
								className={`badge ${
									status?.updaterConnection === "connected"
										? "badge-success"
										: status?.updaterConnection === "error"
											? "badge-error"
											: "badge-ghost"
								}`}
							>
								{connectionLabel}
							</span>
						</dd>
					</div>
				</dl>
				{!canTrigger ? (
					<div className="alert alert-warning">
						<ExclamationTriangleIcon className="h-6 w-6 shrink-0" />
						<span>{t("configurationRequired")}</span>
					</div>
				) : null}
			</MenuSectionDividerWrapper>
		</main>
	);
};

SystemUpdate.getLayout = function getLayout(page: ReactElement) {
	return <LayoutAdminAuthenticated props={page?.props}>{page}</LayoutAdminAuthenticated>;
};

export { getServerSideProps };
export default SystemUpdate;
