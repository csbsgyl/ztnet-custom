import {
	ArrowPathIcon,
	CheckCircleIcon,
	ClockIcon,
	ExclamationCircleIcon,
	ReceiptPercentIcon,
	RocketLaunchIcon,
} from "@heroicons/react/24/outline";
import { useLocale, useTranslations } from "next-intl";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { LayoutAuthenticated } from "~/components/layouts/layout";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api, type RouterOutputs } from "~/utils/api";

const ORDER_POLL_INTERVAL_MS = 2_000;

type CreatedOrder = RouterOutputs["billing"]["createOrder"];

type PaymentPhase = "pending" | "confirming" | "success" | "failed";

const getPaymentPhase = (status?: string): PaymentPhase => {
	const normalized = status?.toUpperCase();
	if (["SUCCESS", "COMPLETED", "FULFILLED"].includes(normalized ?? "")) {
		return "success";
	}
	if (["PAID", "CONFIRMING", "PROCESSING", "FULFILLING"].includes(normalized ?? "")) {
		return "confirming";
	}
	if (
		[
			"FAILED",
			"FULFILLMENT_FAILED",
			"CLOSED",
			"CANCELLED",
			"EXPIRED",
			"REFUNDED",
		].includes(normalized ?? "")
	) {
		return "failed";
	}
	return "pending";
};

const isTerminalOrderStatus = (status?: string) => {
	const phase = getPaymentPhase(status);
	return phase === "success" || phase === "failed";
};

const getStatusBadgeClass = (status?: string) => {
	switch (status?.toUpperCase()) {
		case "ACTIVE":
		case "FULFILLED":
		case "SUCCESS":
		case "COMPLETED":
			return "badge-success";
		case "PENDING":
		case "PAID":
		case "CONFIRMING":
		case "PROCESSING":
		case "FULFILLING":
			return "badge-warning";
		case "FAILED":
		case "FULFILLMENT_FAILED":
		case "CLOSED":
		case "CANCELLED":
		case "EXPIRED":
		case "PAST_DUE":
		case "REFUNDED":
		case "SUSPENDED":
			return "badge-error";
		default:
			return "badge-ghost";
	}
};

const Billing = () => {
	const t = useTranslations("billing");
	const locale = useLocale();
	const [activeOrder, setActiveOrder] = useState<CreatedOrder | null>(null);
	const [purchasingPlanId, setPurchasingPlanId] = useState<string | null>(null);
	const handledSuccessOrder = useRef<string | null>(null);
	const paymentWindowRef = useRef<Window | null>(null);

	const overview = api.billing.getOverview.useQuery(undefined);
	const createOrderMutation = api.billing.createOrder.useMutation({
		onSuccess: (order) => {
			setPurchasingPlanId(null);
			setActiveOrder(order);
			const paymentWindow = paymentWindowRef.current;
			paymentWindowRef.current = null;
			if (paymentWindow && !paymentWindow.closed) {
				paymentWindow.opener = null;
				paymentWindow.location.replace(order.paymentUrl);
			} else {
				toast(t("payment.popupBlocked"));
			}
		},
		onError: (error) => {
			paymentWindowRef.current?.close();
			paymentWindowRef.current = null;
			setPurchasingPlanId(null);
			toast.error(error.message || t("messages.operationFailed"));
		},
	});

	useEffect(
		() => () => {
			paymentWindowRef.current?.close();
		},
		[],
	);

	const orderStatus = api.billing.getOrderStatus.useQuery(
		{ orderId: activeOrder?.orderId ?? "" },
		{
			enabled: Boolean(activeOrder?.orderId),
			refetchInterval: (data) =>
				isTerminalOrderStatus(data?.status) ? false : ORDER_POLL_INTERVAL_MS,
			refetchIntervalInBackground: true,
		},
	);

	const activeStatus = orderStatus.data?.status ?? activeOrder?.status;
	const paymentPhase = getPaymentPhase(activeStatus);

	useEffect(() => {
		if (!activeOrder || paymentPhase !== "success") return;
		if (handledSuccessOrder.current === activeOrder.orderId) return;
		handledSuccessOrder.current = activeOrder.orderId;
		toast.success(t("messages.paymentSuccess"));
		void overview.refetch();
	}, [activeOrder, overview.refetch, paymentPhase, t]);

	const currencyFormatter = useMemo(
		() =>
			new Intl.NumberFormat(locale, {
				style: "currency",
				currency: "CNY",
			}),
		[locale],
	);
	const dateFormatter = useMemo(
		() =>
			new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "short",
			}),
		[locale],
	);

	const formatDate = (value?: string | Date | null) => {
		if (!value) return t("notAvailable");
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? t("notAvailable") : dateFormatter.format(date);
	};

	if (overview.isLoading) {
		return (
			<main className="flex min-h-[45vh] items-center justify-center p-5">
				<div
					role="status"
					className="flex flex-col items-center gap-3 text-base-content/70"
				>
					<span className="loading loading-spinner loading-lg text-primary" />
					<span>{t("loading")}</span>
				</div>
			</main>
		);
	}

	if (overview.isError || !overview.data) {
		return (
			<main className="mx-auto w-full max-w-6xl p-5 sm:p-6">
				<div role="alert" className="alert alert-error">
					<ExclamationCircleIcon className="h-6 w-6 shrink-0" />
					<div className="min-w-0 flex-1">
						<p className="font-semibold">{t("errors.overviewTitle")}</p>
						<p className="text-sm">{overview.error?.message || t("errors.overview")}</p>
					</div>
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => void overview.refetch()}
					>
						<ArrowPathIcon className="h-4 w-4" />
						{t("retry")}
					</button>
				</div>
			</main>
		);
	}

	const { subscription, networkUsage, plans, orders, paymentFeeRateBps } = overview.data;
	const hasActiveSubscription = subscription?.status.toUpperCase() === "ACTIVE";
	const currentRank = hasActiveSubscription ? (subscription?.plan.rank ?? -1) : -1;
	const usagePercent =
		networkUsage.limit && networkUsage.limit > 0
			? Math.min(100, Math.round((networkUsage.used / networkUsage.limit) * 100))
			: 0;

	const startPurchase = (planId: string) => {
		paymentWindowRef.current?.close();
		paymentWindowRef.current = window.open("about:blank", "_blank");
		if (paymentWindowRef.current) paymentWindowRef.current.opener = null;
		setPurchasingPlanId(planId);
		createOrderMutation.mutate({ planId });
	};

	return (
		<main className="mx-auto w-full max-w-7xl space-y-8 p-4 sm:p-6 lg:p-8">
			<header className="flex flex-wrap items-end justify-between gap-4 border-b border-base-300 pb-5">
				<div>
					<h1 className="text-2xl font-semibold">{t("title")}</h1>
					<p className="mt-1 text-sm text-base-content/65">{t("description")}</p>
				</div>
				{overview.isFetching ? (
					<span
						role="status"
						className="flex items-center gap-2 text-sm text-base-content/60"
					>
						<span className="loading loading-spinner loading-xs" />
						{t("refreshing")}
					</span>
				) : null}
			</header>

			<section aria-labelledby="subscription-title" className="grid gap-5 lg:grid-cols-2">
				<div className="border border-base-300 bg-base-100 p-5">
					<div className="flex items-start justify-between gap-4">
						<div>
							<p id="subscription-title" className="text-sm text-base-content/60">
								{t("subscription.title")}
							</p>
							{subscription ? (
								<>
									<h2 className="mt-2 text-xl font-semibold">{subscription.plan.name}</h2>
									<p className="mt-1 text-sm text-base-content/65">
										{t("subscription.validUntil", {
											date: formatDate(subscription.endsAt),
										})}
									</p>
								</>
							) : (
								<>
									<h2 className="mt-2 text-xl font-semibold">{t("subscription.none")}</h2>
									<p className="mt-1 text-sm text-base-content/65">
										{t("subscription.noneDescription")}
									</p>
								</>
							)}
						</div>
						{subscription ? (
							<span
								className={`badge badge-outline ${getStatusBadgeClass(subscription.status)}`}
							>
								{t(`status.${subscription.status.toLowerCase()}`)}
							</span>
						) : null}
					</div>
				</div>

				<div className="border border-base-300 bg-base-100 p-5">
					<div className="flex items-start justify-between gap-4">
						<div>
							<p className="text-sm text-base-content/60">{t("usage.title")}</p>
							<p className="mt-2 text-xl font-semibold">
								{networkUsage.used} / {networkUsage.limit ?? t("usage.unlimited")}
							</p>
							<p className="mt-1 text-sm text-base-content/65">
								{t("usage.description")}
							</p>
						</div>
						<RocketLaunchIcon className="h-7 w-7 text-primary" />
					</div>
					{networkUsage.limit !== null ? (
						<progress
							className="progress progress-primary mt-4 h-2 w-full"
							value={usagePercent}
							max="100"
							aria-label={t("usage.progressLabel", { percent: usagePercent })}
						/>
					) : null}
				</div>
			</section>

			{activeOrder ? (
				<section
					aria-labelledby="payment-status-title"
					aria-live="polite"
					className={`border p-5 ${
						paymentPhase === "success"
							? "border-success/50 bg-success/5"
							: paymentPhase === "failed"
								? "border-error/50 bg-error/5"
								: "border-primary/40 bg-primary/5"
					}`}
				>
					<div className="flex items-start gap-4">
						<div className="flex h-10 w-10 shrink-0 items-center justify-center">
							{paymentPhase === "success" ? (
								<CheckCircleIcon className="h-8 w-8 text-success" />
							) : paymentPhase === "failed" ? (
								<ExclamationCircleIcon className="h-8 w-8 text-error" />
							) : paymentPhase === "confirming" ? (
								<ArrowPathIcon className="h-8 w-8 animate-spin text-primary" />
							) : (
								<ClockIcon className="h-8 w-8 animate-pulse text-primary" />
							)}
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div>
									<h2 id="payment-status-title" className="font-semibold">
										{t(`payment.${paymentPhase}Title`)}
									</h2>
									<p className="mt-1 text-sm text-base-content/65">
										{t(`payment.${paymentPhase}Description`)}
									</p>
								</div>
								{paymentPhase === "pending" || paymentPhase === "confirming" ? (
									<span className="badge badge-primary badge-outline gap-2">
										<span className="relative flex h-2 w-2">
											<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
											<span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
										</span>
										{t("payment.live")}
									</span>
								) : null}
							</div>
							{paymentPhase === "pending" || paymentPhase === "confirming" ? (
								<progress className="progress progress-primary mt-4 h-1.5 w-full" />
							) : (
								<progress
									className={`progress mt-4 h-1.5 w-full ${
										paymentPhase === "success" ? "progress-success" : "progress-error"
									}`}
									value="100"
									max="100"
								/>
							)}
							<div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
								<span className="font-mono text-xs text-base-content/60">
									{activeOrder.orderNo}
								</span>
								{orderStatus.data?.paymentUrl || activeOrder.paymentUrl ? (
									<a
										href={orderStatus.data?.paymentUrl || activeOrder.paymentUrl}
										target="_blank"
										rel="noreferrer"
										className="link link-primary"
									>
										{t("payment.openAlipay")}
									</a>
								) : null}
								{isTerminalOrderStatus(activeStatus) ? (
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => setActiveOrder(null)}
									>
										{t("payment.dismiss")}
									</button>
								) : null}
							</div>
							<dl className="mt-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-base-300 pt-3 text-sm">
								<dt className="text-base-content/65">{t("payment.subtotal")}</dt>
								<dd className="text-right">
									{currencyFormatter.format(activeOrder.subtotalCents / 100)}
								</dd>
								<dt className="text-base-content/65">
									{t("payment.fee", {
										rate: (activeOrder.feeRateBps / 100).toFixed(2),
									})}
								</dt>
								<dd className="text-right">
									{currencyFormatter.format(activeOrder.feeAmountCents / 100)}
								</dd>
								<dt className="font-medium">{t("payment.total")}</dt>
								<dd className="text-right font-semibold">
									{currencyFormatter.format(activeOrder.amountCents / 100)}
								</dd>
							</dl>
							{paymentPhase === "failed" && orderStatus.data?.message ? (
								<p className="mt-3 text-sm text-error">{orderStatus.data.message}</p>
							) : null}
							{orderStatus.isError ? (
								<div
									role="alert"
									className="mt-4 flex flex-wrap items-center gap-2 text-sm text-error"
								>
									<span>{orderStatus.error?.message || t("errors.orderStatus")}</span>
									<button
										type="button"
										className="btn btn-error btn-outline btn-xs"
										onClick={() => void orderStatus.refetch()}
									>
										{t("retry")}
									</button>
								</div>
							) : null}
						</div>
					</div>
				</section>
			) : null}

			<section aria-labelledby="plans-title" className="space-y-4">
				<div>
					<h2 id="plans-title" className="text-lg font-semibold">
						{t("plans.title")}
					</h2>
					<p className="mt-1 text-sm text-base-content/65">{t("plans.description")}</p>
				</div>
				{plans.length === 0 ? (
					<div className="border border-dashed border-base-300 p-8 text-center text-base-content/60">
						<ReceiptPercentIcon className="mx-auto h-8 w-8" />
						<p className="mt-3 font-medium">{t("plans.empty")}</p>
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{plans.map((plan) => {
							const isCurrent = subscription?.plan.id === plan.id;
							const isDowngrade = hasActiveSubscription && plan.rank < currentRank;
							const isPurchasing =
								createOrderMutation.isLoading && purchasingPlanId === plan.id;
							return (
								<article
									key={plan.id}
									className={`border bg-base-100 p-5 ${
										isCurrent ? "border-primary" : "border-base-300"
									}`}
								>
									<div className="flex min-h-14 items-start justify-between gap-3">
										<div>
											<h3 className="text-lg font-semibold">{plan.name}</h3>
											<p className="mt-1 text-sm text-base-content/60">
												{plan.description || t("plans.noDescription")}
											</p>
										</div>
										{isCurrent ? (
											<span className="badge badge-primary badge-outline shrink-0">
												{t("plans.current")}
											</span>
										) : null}
									</div>
									<p className="mt-5 text-2xl font-semibold">
										{currencyFormatter.format(plan.priceCents / 100)}
										<span className="ml-1 text-sm font-normal text-base-content/60">
											/ {t("plans.months", { count: plan.durationMonths })}
										</span>
									</p>
									<p className="mt-3 text-sm">
										{t("plans.networkLimit", {
											count: plan.maxNetworks ?? t("usage.unlimited"),
										})}
									</p>
									{paymentFeeRateBps > 0 ? (
										<p className="mt-2 text-xs text-base-content/60">
											{t("plans.feeNotice", {
												rate: (paymentFeeRateBps / 100).toFixed(2),
											})}
										</p>
									) : null}
									<button
										type="button"
										className="btn btn-primary mt-5 w-full"
										disabled={
											isDowngrade || createOrderMutation.isLoading || !plan.isActive
										}
										onClick={() => startPurchase(plan.id)}
									>
										{isPurchasing ? (
											<span className="loading loading-spinner loading-sm" />
										) : null}
										{isDowngrade
											? t("plans.downgradeBlocked")
											: isCurrent
												? t("plans.renew")
												: subscription
													? t("plans.upgrade")
													: t("plans.buy")}
									</button>
								</article>
							);
						})}
					</div>
				)}
			</section>

			<section aria-labelledby="orders-title" className="space-y-4">
				<div>
					<h2 id="orders-title" className="text-lg font-semibold">
						{t("orders.title")}
					</h2>
					<p className="mt-1 text-sm text-base-content/65">{t("orders.description")}</p>
				</div>
				{orders.length === 0 ? (
					<div className="border border-dashed border-base-300 p-8 text-center text-base-content/60">
						<p>{t("orders.empty")}</p>
					</div>
				) : (
					<div className="overflow-x-auto border border-base-300">
						<table className="table table-zebra min-w-[46rem]">
							<thead>
								<tr>
									<th>{t("orders.number")}</th>
									<th>{t("orders.plan")}</th>
									<th>{t("orders.amount")}</th>
									<th>{t("orders.status")}</th>
									<th>{t("orders.createdAt")}</th>
								</tr>
							</thead>
							<tbody>
								{orders.map((order) => (
									<tr key={order.id}>
										<td className="font-mono text-xs">{order.orderNo}</td>
										<td>{order.planName}</td>
										<td>
											<p className="font-medium">
												{currencyFormatter.format(order.amountCents / 100)}
											</p>
											{order.feeAmountCents > 0 ? (
												<p className="text-xs text-base-content/55">
													{t("orders.feeIncluded", {
														fee: currencyFormatter.format(order.feeAmountCents / 100),
														rate: (order.feeRateBps / 100).toFixed(2),
													})}
												</p>
											) : null}
										</td>
										<td>
											<span
												className={`badge badge-outline ${getStatusBadgeClass(order.status)}`}
											>
												{t(`status.${order.status.toLowerCase()}`)}
											</span>
										</td>
										<td>{formatDate(order.createdAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</main>
	);
};

Billing.getLayout = function getLayout(page: ReactElement) {
	return <LayoutAuthenticated>{page}</LayoutAuthenticated>;
};

export { getServerSideProps };
export default Billing;
