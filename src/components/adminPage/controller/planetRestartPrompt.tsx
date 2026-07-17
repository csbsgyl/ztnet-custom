import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import toast from "react-hot-toast";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";

export type PlanetRestartOperation = "generated" | "imported" | "restored";

interface PlanetRestartPromptProps {
	operation: PlanetRestartOperation;
}

export function PlanetRestartPrompt({ operation }: PlanetRestartPromptProps) {
	const t = useTranslations("admin.controller.generatePlanet.restartPrompt");
	const closeModal = useModalStore((state) => state.closeModal);
	const status = api.admin.getZeroTierRestartStatus.useQuery(undefined, {
		retry: false,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
	});
	const restart = api.admin.restartZeroTier.useMutation({
		onSuccess: (result) => {
			if (result.alreadyRunning) {
				toast.error(t("restartInProgress"));
				return;
			}
			toast.success(t("restartSuccess"));
			closeModal?.();
		},
		onError: () => {
			toast.error(t("restartError"));
		},
	});

	const connection = status.data?.connection;
	const manualCommand = status.data?.manualCommand?.trim();
	const canRestart = connection === "connected" && !status.isError && !status.isFetching;

	let statusMessage = t("checking");
	if (status.isFetching) statusMessage = t("checking");
	else if (status.isError) statusMessage = t("statusCheckFailed");
	else if (connection === "connected") statusMessage = t("connected");
	else if (connection === "error") statusMessage = t("connectionError");
	else if (connection === "unavailable") statusMessage = t("unavailable");

	return (
		<div className="space-y-4">
			<div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm">
				{t(`operation.${operation}`)}
			</div>

			<div className="space-y-2">
				<p className="text-sm">{t("description")}</p>
				<p className="text-sm text-base-content/70" aria-live="polite">
					{statusMessage}
				</p>
			</div>

			{manualCommand && (!canRestart || restart.isError) ? (
				<div className="space-y-1">
					<p className="text-xs font-medium text-base-content/60">{t("manualCommand")}</p>
					<code className="block break-all rounded bg-base-200 px-3 py-2 text-xs">
						{manualCommand}
					</code>
				</div>
			) : null}

			{restart.isError ? (
				<p role="alert" className="text-sm text-error">
					{t("restartErrorHint")}
				</p>
			) : null}
			{restart.data?.alreadyRunning ? (
				<p role="status" className="text-sm text-warning">
					{t("restartInProgress")}
				</p>
			) : null}

			<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
				<button
					type="button"
					className="btn btn-ghost"
					disabled={restart.isLoading}
					onClick={() => closeModal?.()}
				>
					{t("later")}
				</button>
				<button
					type="button"
					className="btn btn-primary gap-2"
					disabled={!canRestart || restart.isLoading}
					onClick={() => restart.mutate()}
				>
					<ArrowPathIcon
						className={`h-5 w-5 ${restart.isLoading ? "animate-spin" : ""}`}
					/>
					<span>{restart.isLoading ? t("restarting") : t("restartNow")}</span>
				</button>
			</div>
		</div>
	);
}

export function usePlanetRestartPrompt() {
	const t = useTranslations("admin.controller.generatePlanet.restartPrompt");
	const callModal = useModalStore((state) => state.callModal);

	return useCallback(
		(operation: PlanetRestartOperation) => {
			callModal({
				title: t("title"),
				content: <PlanetRestartPrompt operation={operation} />,
				rootStyle: "text-left border border-warning/30",
				showButtons: false,
				disableClickOutside: true,
			});
		},
		[callModal, t],
	);
}
