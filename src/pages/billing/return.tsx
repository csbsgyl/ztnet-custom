import {
	ArrowLeftIcon,
	ArrowPathIcon,
	CheckCircleIcon,
	ClockIcon,
	ExclamationCircleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { LayoutAuthenticated } from "~/components/layouts/layout";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api } from "~/utils/api";

const ORDER_POLL_INTERVAL_MS = 2_000;

type ReturnPhase = "pending" | "confirming" | "success" | "failed";

const getReturnPhase = (status?: string): ReturnPhase => {
	const normalized = status?.toUpperCase();
	if (["FULFILLED", "SUCCESS", "COMPLETED"].includes(normalized ?? "")) {
		return "success";
	}
	if (["PAID", "CONFIRMING", "PROCESSING", "FULFILLING"].includes(normalized ?? "")) {
		return "confirming";
	}
	if (["FAILED", "FULFILLMENT_FAILED", "CLOSED", "REFUNDED"].includes(normalized ?? "")) {
		return "failed";
	}
	return "pending";
};

const isTerminalStatus = (status?: string) => {
	const phase = getReturnPhase(status);
	return phase === "success" || phase === "failed";
};

const BillingReturn = () => {
	const t = useTranslations("billing.return");
	const router = useRouter();
	const orderId =
		typeof router.query.orderId === "string" ? router.query.orderId.trim() : "";
	const queryEnabled = router.isReady && orderId.length > 0;

	// This page is observational only. Server-side notification/query processing owns fulfillment.
	const orderStatus = api.billing.getOrderStatus.useQuery(
		{ orderId },
		{
			enabled: queryEnabled,
			refetchInterval: (data) =>
				isTerminalStatus(data?.status) ? false : ORDER_POLL_INTERVAL_MS,
			refetchIntervalInBackground: true,
		},
	);

	if (!router.isReady || (queryEnabled && orderStatus.isLoading)) {
		return (
			<main className="flex min-h-[50vh] items-center justify-center p-5">
				<div
					role="status"
					className="flex flex-col items-center gap-3 text-base-content/65"
				>
					<span className="loading loading-spinner loading-lg text-primary" />
					<span>{t("loading")}</span>
				</div>
			</main>
		);
	}

	if (!queryEnabled) {
		return (
			<main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
				<div role="alert" className="alert alert-error">
					<ExclamationCircleIcon className="h-6 w-6 shrink-0" />
					<div>
						<p className="font-semibold">{t("missingTitle")}</p>
						<p className="text-sm">{t("missingDescription")}</p>
					</div>
					<Link href="/billing" className="btn btn-sm">
						<ArrowLeftIcon className="h-4 w-4" />
						{t("back")}
					</Link>
				</div>
			</main>
		);
	}

	if (orderStatus.isError || !orderStatus.data) {
		return (
			<main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
				<div role="alert" className="alert alert-error">
					<ExclamationCircleIcon className="h-6 w-6 shrink-0" />
					<div className="min-w-0 flex-1">
						<p className="font-semibold">{t("errorTitle")}</p>
						<p className="text-sm">
							{orderStatus.error?.message || t("errorDescription")}
						</p>
					</div>
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => void orderStatus.refetch()}
					>
						<ArrowPathIcon className="h-4 w-4" />
						{t("retry")}
					</button>
				</div>
			</main>
		);
	}

	const phase = getReturnPhase(orderStatus.data.status);
	const isWaiting = phase === "pending" || phase === "confirming";

	return (
		<main className="mx-auto flex min-h-[55vh] w-full max-w-3xl items-center p-4 sm:p-6 lg:p-8">
			<section
				aria-labelledby="return-status-title"
				aria-live="polite"
				className={`w-full border p-5 sm:p-7 ${
					phase === "success"
						? "border-success/50 bg-success/5"
						: phase === "failed"
							? "border-error/50 bg-error/5"
							: "border-primary/40 bg-primary/5"
				}`}
			>
				<div className="flex items-start gap-4">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center">
						{phase === "success" ? (
							<CheckCircleIcon className="h-9 w-9 text-success" />
						) : phase === "failed" ? (
							<ExclamationCircleIcon className="h-9 w-9 text-error" />
						) : phase === "confirming" ? (
							<ArrowPathIcon className="h-9 w-9 animate-spin text-primary" />
						) : (
							<ClockIcon className="h-9 w-9 animate-pulse text-primary" />
						)}
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<h1 id="return-status-title" className="text-xl font-semibold">
									{t(`${phase}Title`)}
								</h1>
								<p className="mt-1 text-sm text-base-content/65">
									{t(`${phase}Description`)}
								</p>
							</div>
							{isWaiting ? (
								<span className="badge badge-primary badge-outline gap-2">
									<span className="relative flex h-2 w-2">
										<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
										<span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
									</span>
									{t("live")}
								</span>
							) : null}
						</div>
						{isWaiting ? (
							<progress className="progress progress-primary mt-5 h-1.5 w-full" />
						) : (
							<progress
								className={`progress mt-5 h-1.5 w-full ${
									phase === "success" ? "progress-success" : "progress-error"
								}`}
								value="100"
								max="100"
							/>
						)}
						<div className="mt-5 flex flex-wrap items-center justify-between gap-3">
							<span className="break-all font-mono text-xs text-base-content/55">
								{orderStatus.data.orderNo}
							</span>
							<Link href="/billing" className="btn btn-primary btn-sm">
								<ArrowLeftIcon className="h-4 w-4" />
								{t("back")}
							</Link>
						</div>
						{phase === "failed" && orderStatus.data.message ? (
							<p className="mt-4 text-sm text-error">{orderStatus.data.message}</p>
						) : null}
						{orderStatus.isFetching && isWaiting ? (
							<span className="sr-only">{t("refreshing")}</span>
						) : null}
					</div>
				</div>
			</section>
		</main>
	);
};

BillingReturn.getLayout = function getLayout(page: ReactElement) {
	return <LayoutAuthenticated>{page}</LayoutAuthenticated>;
};

export { getServerSideProps };
export default BillingReturn;
