import {
	ArrowPathIcon,
	ArrowTopRightOnSquareIcon,
	CalendarDaysIcon,
	CheckCircleIcon,
	ClockIcon,
	ExclamationCircleIcon,
	GlobeAltIcon,
	MinusIcon,
	PlusIcon,
	ReceiptPercentIcon,
	RocketLaunchIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useLocale, useTranslations } from "next-intl";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { LayoutAuthenticated } from "~/components/layouts/layout";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api, type RouterOutputs } from "~/utils/api";

const ORDER_POLL_INTERVAL_MS = 2_000;

type CreatedOrder = RouterOutputs["billing"]["createOrder"];
type PendingOrder = NonNullable<RouterOutputs["billing"]["getOverview"]["pendingOrder"]>;

type ActiveOrder = {
	orderId: string;
	orderNo: string;
	status: string;
	planId: string | null;
	planName: string;
	amountCents: number;
	subtotalCents: number;
	feeRateBps: number;
	feeAmountCents: number;
	durationMonths: number;
	paymentUrl: string | null;
	expiresAt: string | Date;
};

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

const restoredOrder = (order: PendingOrder): ActiveOrder => ({
	orderId: order.id,
	orderNo: order.orderNo,
	status: order.status,
	planId: order.planId,
	planName: order.planName,
	amountCents: order.amountCents,
	subtotalCents: order.subtotalCents,
	feeRateBps: order.feeRateBps,
	feeAmountCents: order.feeAmountCents,
	durationMonths: order.durationMonths,
	paymentUrl: null,
	expiresAt: order.expiresAt,
});

const formatCountdown = (milliseconds: number) => {
	const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
	const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null);
	const [purchasingPlanId, setPurchasingPlanId] = useState<string | null>(null);
	const [planQuantities, setPlanQuantities] = useState<Record<string, number>>({});
	const [clockMs, setClockMs] = useState(() => Date.now());
	const handledSuccessOrder = useRef<string | null>(null);
	const handledExpiredOrder = useRef<string | null>(null);
	const paymentWindowRef = useRef<Window | null>(null);
	const paymentWindowRedirectedRef = useRef(false);
	const paymentStatusRef = useRef<HTMLElement | null>(null);

	const overview = api.billing.getOverview.useQuery(undefined);

	const openPaymentOrder = (order: CreatedOrder) => {
		setActiveOrder(order);
		setClockMs(Date.now());
		const paymentWindow = paymentWindowRef.current;
		if (paymentWindow && !paymentWindow.closed) {
			paymentWindow.opener = null;
			paymentWindowRedirectedRef.current = true;
			paymentWindow.location.replace(order.paymentUrl);
		} else {
			paymentWindowRef.current = null;
			paymentWindowRedirectedRef.current = false;
			toast(t("payment.popupBlocked"));
		}
	};

	const createOrderMutation = api.billing.createOrder.useMutation({
		onSuccess: (order) => {
			setPurchasingPlanId(null);
			openPaymentOrder(order);
		},
		onError: (error) => {
			paymentWindowRef.current?.close();
			paymentWindowRef.current = null;
			paymentWindowRedirectedRef.current = false;
			setPurchasingPlanId(null);
			toast.error(error.message || t("messages.operationFailed"));
			void overview.refetch();
		},
	});
	const resumeOrderMutation = api.billing.resumeOrder.useMutation({
		onSuccess: openPaymentOrder,
		onError: (error) => {
			paymentWindowRef.current?.close();
			paymentWindowRef.current = null;
			paymentWindowRedirectedRef.current = false;
			toast.error(error.message || t("errors.resumeOrder"));
			void overview.refetch();
		},
	});
	const cancelOrderMutation = api.billing.cancelOrder.useMutation({
		onSuccess: () => {
			paymentWindowRef.current?.close();
			paymentWindowRef.current = null;
			paymentWindowRedirectedRef.current = false;
			setActiveOrder(null);
			toast.success(t("messages.orderCancelled"));
			void overview.refetch();
		},
		onError: (error) => {
			toast.error(error.message || t("errors.cancelOrder"));
			void overview.refetch();
		},
	});

	useEffect(() => {
		const pendingOrder = overview.data?.pendingOrder;
		if (!pendingOrder) return;
		setActiveOrder((current) => {
			if (current?.orderId === pendingOrder.id) {
				return { ...restoredOrder(pendingOrder), paymentUrl: current.paymentUrl };
			}
			if (current && !isTerminalOrderStatus(current.status)) return current;
			return restoredOrder(pendingOrder);
		});
		setClockMs(Date.now());
	}, [overview.data?.pendingOrder]);

	useEffect(
		() => () => {
			if (!paymentWindowRedirectedRef.current) {
				paymentWindowRef.current?.close();
			}
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

	const activeStatus = activeOrder
		? (orderStatus.data?.status ?? activeOrder.status)
		: undefined;
	const expiresAtMs = activeOrder ? new Date(activeOrder.expiresAt).getTime() : 0;
	const remainingMs = Number.isFinite(expiresAtMs)
		? Math.max(0, expiresAtMs - clockMs)
		: 0;
	const displayedStatus =
		activeStatus?.toUpperCase() === "PENDING" && remainingMs <= 0
			? "CLOSED"
			: activeStatus;
	const paymentPhase = getPaymentPhase(displayedStatus);
	const canResumePayment = activeStatus?.toUpperCase() === "PENDING" && remainingMs > 0;
	const hasBlockingOrder =
		canResumePayment || getPaymentPhase(activeStatus) === "confirming";

	useEffect(() => {
		if (!activeOrder || isTerminalOrderStatus(activeStatus)) return;
		const tick = () => setClockMs(Date.now());
		tick();
		const interval = window.setInterval(tick, 1_000);
		return () => window.clearInterval(interval);
	}, [activeOrder, activeStatus]);

	useEffect(() => {
		if (!activeOrder || activeStatus?.toUpperCase() !== "PENDING" || remainingMs > 0) {
			return;
		}
		if (handledExpiredOrder.current === activeOrder.orderId) return;
		handledExpiredOrder.current = activeOrder.orderId;
		void orderStatus.refetch();
		void overview.refetch();
	}, [activeOrder, activeStatus, orderStatus.refetch, overview.refetch, remainingMs]);

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

	const setPlanQuantity = (planId: string, quantity: number, maxQuantity: number) => {
		const nextQuantity = Math.min(maxQuantity, Math.max(1, Math.floor(quantity)));
		setPlanQuantities((current) => ({ ...current, [planId]: nextQuantity }));
	};

	const startPurchase = (planId: string, quantity: number) => {
		if (hasBlockingOrder) {
			toast(t("messages.pendingOrderExists"));
			paymentStatusRef.current?.scrollIntoView?.({
				behavior: "smooth",
				block: "center",
			});
			return;
		}
		paymentWindowRef.current?.close();
		paymentWindowRedirectedRef.current = false;
		paymentWindowRef.current = window.open("about:blank", "_blank");
		if (paymentWindowRef.current) paymentWindowRef.current.opener = null;
		setPurchasingPlanId(planId);
		createOrderMutation.mutate({ planId, quantity });
	};

	const resumePayment = () => {
		if (!activeOrder || !canResumePayment) return;
		paymentWindowRef.current?.close();
		paymentWindowRedirectedRef.current = false;
		paymentWindowRef.current = window.open("about:blank", "_blank");
		if (paymentWindowRef.current) paymentWindowRef.current.opener = null;
		resumeOrderMutation.mutate({ orderId: activeOrder.orderId });
	};

	const cancelPayment = () => {
		if (!activeOrder || !canResumePayment) return;
		if (!window.confirm(t("payment.cancelConfirm"))) return;
		cancelOrderMutation.mutate({ orderId: activeOrder.orderId });
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

			<section aria-labelledby="subscription-title" className="grid gap-4 lg:grid-cols-2">
				<div className="rounded-lg border border-base-300 bg-base-100 p-5 shadow-sm">
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
								className={`badge badge-outline h-7 min-w-[4.5rem] shrink-0 whitespace-nowrap px-3 leading-none ${getStatusBadgeClass(subscription.status)}`}
							>
								{t(`status.${subscription.status.toLowerCase()}`)}
							</span>
						) : null}
					</div>
				</div>

				<div className="rounded-lg border border-base-300 bg-base-100 p-5 shadow-sm">
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
					ref={paymentStatusRef}
					aria-labelledby="payment-status-title"
					aria-live="polite"
					className={`scroll-mt-6 rounded-lg border p-5 shadow-sm ${
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
										{paymentPhase === "pending"
											? t("payment.unpaidTitle")
											: t(`payment.${paymentPhase}Title`)}
									</h2>
									<p className="mt-1 text-sm text-base-content/65">
										{paymentPhase === "pending"
											? t("payment.unpaidDescription")
											: t(`payment.${paymentPhase}Description`)}
									</p>
								</div>
								{canResumePayment ? (
									<div className="flex shrink-0 items-center gap-3 rounded-md border border-primary/25 bg-base-100 px-3 py-2">
										<span className="relative flex h-2 w-2">
											<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
											<span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
										</span>
										<div>
											<p className="text-[0.6875rem] text-base-content/55">
												{t("payment.expiresIn")}
											</p>
											<p className="font-mono text-base font-semibold tabular-nums text-primary">
												{formatCountdown(remainingMs)}
											</p>
										</div>
									</div>
								) : paymentPhase === "confirming" ? (
									<span className="badge badge-primary badge-outline h-7 whitespace-nowrap px-3">
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
								<span className="text-base-content/35">|</span>
								<span className="font-medium">{activeOrder.planName}</span>
								{isTerminalOrderStatus(displayedStatus) ? (
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => setActiveOrder(null)}
									>
										{t("payment.dismiss")}
									</button>
								) : null}
							</div>
							{canResumePayment ? (
								<div className="mt-4 flex flex-wrap gap-2">
									<button
										type="button"
										className="btn btn-primary btn-sm"
										disabled={
											resumeOrderMutation.isLoading || cancelOrderMutation.isLoading
										}
										onClick={resumePayment}
									>
										{resumeOrderMutation.isLoading ? (
											<span className="loading loading-spinner loading-xs" />
										) : (
											<ArrowTopRightOnSquareIcon className="h-4 w-4" />
										)}
										{t("payment.resume")}
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm text-error"
										disabled={
											resumeOrderMutation.isLoading || cancelOrderMutation.isLoading
										}
										onClick={cancelPayment}
									>
										{cancelOrderMutation.isLoading ? (
											<span className="loading loading-spinner loading-xs" />
										) : (
											<XMarkIcon className="h-4 w-4" />
										)}
										{t("payment.cancel")}
									</button>
								</div>
							) : null}
							<dl className="mt-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-base-300 pt-3 text-sm">
								<dt className="text-base-content/65">{t("payment.duration")}</dt>
								<dd className="text-right">
									{t("plans.months", { count: activeOrder.durationMonths })}
								</dd>
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
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
						{plans.map((plan) => {
							const isCurrent = subscription?.plan.id === plan.id;
							const isDowngrade = hasActiveSubscription && plan.rank < currentRank;
							const maxQuantity = Math.max(1, Math.floor(120 / plan.durationMonths));
							const quantity = Math.min(maxQuantity, planQuantities[plan.id] ?? 1);
							const totalDurationMonths = plan.durationMonths * quantity;
							const planSubtotalCents = plan.priceCents * quantity;
							const orderSubtotalCents = planSubtotalCents + plan.upgradeAmountCents;
							const estimatedFeeCents = Math.round(
								(orderSubtotalCents * paymentFeeRateBps) / 10_000,
							);
							const isPurchasing =
								createOrderMutation.isLoading && purchasingPlanId === plan.id;
							return (
								<article
									key={plan.id}
									className={`flex h-full flex-col overflow-hidden rounded-lg border bg-base-100 shadow-sm transition-[border-color,box-shadow] duration-200 hover:shadow-md ${
										isCurrent
											? "border-primary ring-1 ring-primary/20"
											: "border-base-300 hover:border-base-content/25"
									}`}
								>
									<div className="flex min-h-[6.25rem] items-start justify-between gap-3 p-4 pb-3">
										<div className="min-w-0">
											<h3 className="text-lg font-semibold">{plan.name}</h3>
											<p className="mt-1 line-clamp-2 text-sm leading-5 text-base-content/60">
												{plan.description || t("plans.noDescription")}
											</p>
										</div>
										{isCurrent ? (
											<span className="badge badge-primary badge-outline h-7 shrink-0 whitespace-nowrap px-2 leading-none">
												{t("plans.current")}
											</span>
										) : null}
									</div>
									<div className="border-y border-base-300/80 px-4 py-4">
										<p className="text-2xl font-semibold leading-none">
											{currencyFormatter.format(plan.priceCents / 100)}
											<span className="ml-1 text-xs font-normal text-base-content/55">
												/ {t("plans.months", { count: plan.durationMonths })}
											</span>
										</p>
										<p className="mt-3 flex items-center gap-2 text-sm font-medium">
											<GlobeAltIcon className="h-4 w-4 shrink-0 text-primary" />
											{t("plans.networkLimit", {
												count: plan.maxNetworks ?? t("usage.unlimited"),
											})}
										</p>
									</div>
									<div className="mx-4 mt-4 rounded-md bg-base-200/70 p-3">
										<div className="flex flex-col gap-2">
											<div>
												<p className="text-sm font-medium">{t("plans.quantity")}</p>
												<p className="mt-0.5 text-xs text-base-content/55">
													{t("plans.quantityUnit", {
														months: plan.durationMonths,
													})}
												</p>
											</div>
											<div
												className="join grid w-full grid-cols-[2rem_1fr_2rem]"
												role="group"
												aria-label={t("plans.quantity")}
											>
												<button
													type="button"
													className="btn btn-square btn-sm join-item border-base-300 bg-base-100"
													title={t("plans.decreaseQuantity")}
													aria-label={t("plans.decreaseQuantity")}
													disabled={quantity <= 1 || createOrderMutation.isLoading}
													onClick={() =>
														setPlanQuantity(plan.id, quantity - 1, maxQuantity)
													}
												>
													<MinusIcon className="h-4 w-4" />
												</button>
												<input
													type="number"
													className="input input-bordered input-sm join-item w-full appearance-none bg-base-100 px-1 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
													min={1}
													max={maxQuantity}
													step={1}
													value={quantity}
													aria-label={t("plans.quantity")}
													disabled={createOrderMutation.isLoading}
													onChange={(event) => {
														const value = Number(event.target.value);
														if (Number.isFinite(value)) {
															setPlanQuantity(plan.id, value, maxQuantity);
														}
													}}
												/>
												<button
													type="button"
													className="btn btn-square btn-sm join-item border-base-300 bg-base-100"
													title={t("plans.increaseQuantity")}
													aria-label={t("plans.increaseQuantity")}
													disabled={
														quantity >= maxQuantity || createOrderMutation.isLoading
													}
													onClick={() =>
														setPlanQuantity(plan.id, quantity + 1, maxQuantity)
													}
												>
													<PlusIcon className="h-4 w-4" />
												</button>
											</div>
										</div>
									</div>
									<div className="flex flex-1 flex-col px-4 pb-4 pt-4">
										<dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
											<dt className="flex items-center gap-1.5 text-base-content/60">
												<CalendarDaysIcon className="h-4 w-4" />
												{t("plans.totalDuration")}
											</dt>
											<dd className="text-right font-medium">
												{t("plans.months", { count: totalDurationMonths })}
											</dd>
											<dt className="text-base-content/60">{t("plans.subtotal")}</dt>
											<dd className="text-right font-medium">
												{currencyFormatter.format(planSubtotalCents / 100)}
											</dd>
											{plan.upgradeAmountCents > 0 ? (
												<>
													<dt className="text-base-content/60">
														{t("plans.upgradeSupplement")}
													</dt>
													<dd className="text-right font-medium">
														{currencyFormatter.format(plan.upgradeAmountCents / 100)}
													</dd>
												</>
											) : null}
											<dt className="mt-1 border-t border-base-300 pt-2 font-medium">
												{t("plans.estimatedTotal")}
											</dt>
											<dd className="mt-1 border-t border-base-300 pt-2 text-right font-semibold text-primary">
												{currencyFormatter.format(
													(orderSubtotalCents + estimatedFeeCents) / 100,
												)}
											</dd>
										</dl>
										{paymentFeeRateBps > 0 ? (
											<p className="mt-2 min-h-8 text-xs leading-4 text-base-content/55">
												{t("plans.feeNotice", {
													rate: (paymentFeeRateBps / 100).toFixed(2),
												})}
											</p>
										) : (
											<div className="min-h-8" />
										)}
										<button
											type="button"
											className="btn btn-primary mt-auto h-auto min-h-12 w-full whitespace-normal py-2 leading-5"
											disabled={
												isDowngrade || createOrderMutation.isLoading || !plan.isActive
											}
											onClick={() => startPurchase(plan.id, quantity)}
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
									</div>
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
									<th>{t("orders.duration")}</th>
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
										<td>{t("plans.months", { count: order.durationMonths })}</td>
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
										<td className="whitespace-nowrap">
											<span
												className={`badge badge-outline h-7 min-w-[4.5rem] whitespace-nowrap px-3 leading-none ${getStatusBadgeClass(order.status)}`}
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
