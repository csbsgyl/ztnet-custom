import {
	ArrowPathIcon,
	CheckIcon,
	CheckCircleIcon,
	CloudArrowDownIcon,
	ExclamationTriangleIcon,
	SignalIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type ReactElement, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { LayoutAdminAuthenticated } from "~/components/layouts/layout";
import MenuSectionDividerWrapper from "~/components/shared/menuSectionDividerWrapper";
import { useTrpcApiErrorHandler } from "~/hooks/useTrpcApiHandler";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api, type RouterOutputs } from "~/utils/api";
import { useModalStore } from "~/utils/store";

const UPDATE_PROGRESS_STORAGE_KEY = "ztnet-system-update-progress";
const UPDATE_POLL_INTERVAL_MS = 2_000;
const UPDATE_TIMEOUT_MS = 15 * 60 * 1_000;
const UPDATE_RELOAD_DELAY_MS = 3_500;

const updatePhases = [
	"requesting",
	"installing",
	"reconnecting",
	"verifying",
	"complete",
	"failed",
] as const;
type UpdatePhase = (typeof updatePhases)[number];
type ProgressPhase = "checking" | UpdatePhase;

interface UpdateProgressState {
	phase: UpdatePhase;
	targetCommit: string | null;
	startedAt: number;
	sawDisconnect: boolean;
}

type SystemUpdateStatus = RouterOutputs["admin"]["getSystemUpdateStatus"];

const activeUpdatePhases: UpdatePhase[] = [
	"requesting",
	"installing",
	"reconnecting",
	"verifying",
];

const isActiveUpdatePhase = (phase: UpdatePhase) => activeUpdatePhases.includes(phase);

const isStoredUpdateProgress = (value: unknown): value is UpdateProgressState => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<UpdateProgressState>;
	return (
		updatePhases.includes(candidate.phase as UpdatePhase) &&
		(candidate.targetCommit === null || typeof candidate.targetCommit === "string") &&
		typeof candidate.startedAt === "number" &&
		typeof candidate.sawDisconnect === "boolean"
	);
};

const shortVersion = (version: string | null | undefined) => {
	if (!version) return null;
	return version.length > 12 ? version.slice(0, 12) : version;
};

const commitsMatch = (current: string, target: string) =>
	current.startsWith(target) || target.startsWith(current);

const OperationProgress = ({
	phase,
	startedAt,
	onDismiss,
}: {
	phase: ProgressPhase;
	startedAt: number;
	onDismiss?: () => void;
}) => {
	const t = useTranslations("admin.systemUpdate");
	const [now, setNow] = useState(Date.now());
	const isAnimated = phase !== "complete" && phase !== "failed";
	const stepIndex =
		phase === "requesting"
			? 0
			: phase === "installing"
				? 1
				: phase === "reconnecting"
					? 2
					: phase === "verifying"
						? 3
						: phase === "complete"
							? 4
							: -1;

	useEffect(() => {
		if (!isAnimated) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [isAnimated]);

	const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	const steps = ["request", "install", "restart", "verify"] as const;

	return (
		<div
			role="status"
			aria-live="polite"
			className="border-y border-base-300 bg-base-200/40 px-4 py-4 sm:px-5"
		>
			<div className="flex min-h-12 items-start gap-3">
				<div className="flex h-9 w-9 shrink-0 items-center justify-center">
					{phase === "complete" ? (
						<CheckCircleIcon className="h-7 w-7 text-success" />
					) : phase === "failed" ? (
						<ExclamationTriangleIcon className="h-7 w-7 text-error" />
					) : phase === "installing" ? (
						<CloudArrowDownIcon className="h-7 w-7 animate-pulse text-primary" />
					) : phase === "reconnecting" ? (
						<SignalIcon className="h-7 w-7 animate-pulse text-primary" />
					) : (
						<ArrowPathIcon className="h-7 w-7 animate-spin text-primary" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div>
							<p className="font-semibold">{t(`progress.${phase}Title`)}</p>
							<p className="mt-0.5 text-sm text-base-content/65">
								{t(`progress.${phase}Description`)}
							</p>
						</div>
						<div className="flex items-center gap-2 text-xs text-base-content/60">
							{isAnimated ? (
								<span className="badge badge-primary badge-outline gap-2">
									<span className="relative flex h-2 w-2">
										<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
										<span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
									</span>
									{t("progress.live")}
								</span>
							) : null}
							<span>{t("progress.elapsed", { seconds: elapsedSeconds })}</span>
							{phase === "failed" && onDismiss ? (
								<button
									type="button"
									className="btn btn-ghost btn-xs btn-square"
									onClick={onDismiss}
									aria-label={t("progress.dismiss")}
									title={t("progress.dismiss")}
								>
									<XMarkIcon className="h-4 w-4" />
								</button>
							) : null}
						</div>
					</div>

					{isAnimated ? (
						<progress className="progress progress-primary mt-3 h-1.5 w-full" />
					) : (
						<progress
							className={`progress mt-3 h-1.5 w-full ${phase === "complete" ? "progress-success" : "progress-error"}`}
							value="100"
							max="100"
						/>
					)}

					{phase !== "checking" ? (
						<ol className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
							{steps.map((step, index) => {
								const completed = phase === "complete" || index < stepIndex;
								const active = isAnimated && index === stepIndex;
								return (
									<li
										key={step}
										className={`flex items-center gap-2 text-xs ${
											completed || active ? "text-base-content" : "text-base-content/40"
										}`}
									>
										<span
											className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
												completed
													? "border-success bg-success text-success-content"
													: active
														? "border-primary text-primary"
														: "border-base-300"
											}`}
										>
											{completed ? (
												<CheckIcon className="h-4 w-4" />
											) : active ? (
												<ArrowPathIcon className="h-4 w-4 animate-spin" />
											) : (
												<span className="h-1.5 w-1.5 rounded-full bg-current" />
											)}
										</span>
										<span>{t(`progress.steps.${step}`)}</span>
									</li>
								);
							})}
						</ol>
					) : null}
				</div>
			</div>
		</div>
	);
};

const SystemUpdate = () => {
	const t = useTranslations("admin.systemUpdate");
	const callModal = useModalStore((state) => state.callModal);
	const handleApiError = useTrpcApiErrorHandler();
	const [checkingStartedAt, setCheckingStartedAt] = useState<number | null>(null);
	const [checkedStatus, setCheckedStatus] = useState<SystemUpdateStatus | null>(null);
	const [updateProgress, setUpdateProgress] = useState<UpdateProgressState | null>(null);
	const [progressRestored, setProgressRestored] = useState(false);
	const updateIsActive = Boolean(
		updateProgress && isActiveUpdatePhase(updateProgress.phase),
	);
	const {
		data: queriedStatus,
		isLoading,
		isFetching,
		isError,
		refetch,
	} = api.admin.getSystemUpdateStatus.useQuery(undefined, {
		refetchOnWindowFocus: false,
		refetchInterval: updateIsActive ? UPDATE_POLL_INTERVAL_MS : false,
		refetchIntervalInBackground: true,
		retry: false,
	});
	const status = checkedStatus || queriedStatus;
	const { mutateAsync: checkSystemUpdateStatus } =
		api.admin.checkSystemUpdateStatus.useMutation();
	const { mutate: triggerUpdate, isLoading: isTriggering } =
		api.admin.triggerSystemUpdate.useMutation({
			onSuccess: (result) => {
				setUpdateProgress((current) =>
					current ? { ...current, phase: "installing" } : current,
				);
				toast.success(
					t(result.alreadyRunning ? "updateAlreadyRunning" : "updateRequested"),
				);
				void refetch();
			},
			onError: (error) => {
				setUpdateProgress((current) =>
					current ? { ...current, phase: "failed" } : current,
				);
				handleApiError(error);
			},
		});

	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(UPDATE_PROGRESS_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as unknown;
				if (
					isStoredUpdateProgress(parsed) &&
					Date.now() - parsed.startedAt < UPDATE_TIMEOUT_MS
				) {
					setUpdateProgress(parsed);
				} else {
					window.localStorage.removeItem(UPDATE_PROGRESS_STORAGE_KEY);
				}
			}
		} catch {
			// Ignore malformed or unavailable browser storage.
		} finally {
			setProgressRestored(true);
		}
	}, []);

	useEffect(() => {
		if (!progressRestored) return;
		try {
			if (!updateProgress || updateProgress.phase === "complete") {
				window.localStorage.removeItem(UPDATE_PROGRESS_STORAGE_KEY);
			} else {
				window.localStorage.setItem(
					UPDATE_PROGRESS_STORAGE_KEY,
					JSON.stringify(updateProgress),
				);
			}
		} catch {
			// The live status still works when browser storage is unavailable.
		}
	}, [progressRestored, updateProgress]);

	useEffect(() => {
		if (!updateProgress || !isActiveUpdatePhase(updateProgress.phase)) return;

		if (Date.now() - updateProgress.startedAt >= UPDATE_TIMEOUT_MS) {
			setUpdateProgress((current) =>
				current ? { ...current, phase: "failed" } : current,
			);
			return;
		}

		if (isError) {
			setUpdateProgress((current) =>
				current && current.phase !== "reconnecting"
					? { ...current, phase: "reconnecting", sawDisconnect: true }
					: current,
			);
			return;
		}

		if (isFetching || !status || updateProgress.phase === "requesting") return;

		const currentCommit = status.currentCommit || status.currentVersion;
		const reachedTarget =
			updateProgress.targetCommit && currentCommit
				? commitsMatch(currentCommit, updateProgress.targetCommit)
				: updateProgress.sawDisconnect && status.updateAvailable === false;

		if (reachedTarget) {
			setUpdateProgress((current) =>
				current ? { ...current, phase: "complete" } : current,
			);
			return;
		}

		if (updateProgress.sawDisconnect && updateProgress.phase === "reconnecting") {
			setUpdateProgress((current) =>
				current ? { ...current, phase: "verifying" } : current,
			);
		}
	}, [isError, isFetching, status, updateProgress]);

	useEffect(() => {
		if (updateProgress?.phase !== "complete") return;
		toast.success(t("progress.completeTitle"));
		const timer = window.setTimeout(
			() => window.location.reload(),
			UPDATE_RELOAD_DELAY_MS,
		);
		return () => window.clearTimeout(timer);
	}, [t, updateProgress?.phase]);

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
	const isChecking = checkingStartedAt !== null;
	const updateState =
		status?.updateAvailable === true
			? "available"
			: status?.updateAvailable === false
				? "current"
				: "unknown";

	const checkNow = async () => {
		setCheckingStartedAt(Date.now());
		try {
			setCheckedStatus(await checkSystemUpdateStatus());
		} catch (error) {
			handleApiError(error);
		} finally {
			setCheckingStartedAt(null);
		}
	};

	const beginUpdate = () => {
		setCheckedStatus(null);
		setUpdateProgress({
			phase: "requesting",
			targetCommit: status?.latestBuild?.commit || null,
			startedAt: Date.now(),
			sawDisconnect: false,
		});
		triggerUpdate();
	};

	const requestUpdate = () => {
		callModal({
			title: t("confirmTitle"),
			description: t("confirmDescription"),
			yesAction: beginUpdate,
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

				{isChecking && checkingStartedAt ? (
					<OperationProgress phase="checking" startedAt={checkingStartedAt} />
				) : updateProgress ? (
					<OperationProgress
						phase={updateProgress.phase}
						startedAt={updateProgress.startedAt}
						onDismiss={() => setUpdateProgress(null)}
					/>
				) : null}

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
						onClick={() => void checkNow()}
						disabled={isChecking || updateIsActive}
					>
						<ArrowPathIcon className={`h-4 w-4 ${isChecking ? "animate-spin" : ""}`} />
						{isChecking ? t("progress.checkingButton") : t("checkNow")}
					</button>
					<button
						className="btn btn-sm btn-primary"
						onClick={requestUpdate}
						disabled={!canTrigger || isTriggering || isChecking || updateIsActive}
					>
						{isTriggering || updateIsActive ? (
							<span className="loading loading-spinner loading-xs" />
						) : (
							<CloudArrowDownIcon className="h-4 w-4" />
						)}
						{isTriggering || updateIsActive
							? t("progress.updatingButton")
							: t("installNow")}
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
