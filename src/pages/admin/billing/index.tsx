import {
	ArrowPathIcon,
	BanknotesIcon,
	CheckCircleIcon,
	ClockIcon,
	CreditCardIcon,
	EyeIcon,
	EyeSlashIcon,
	ExclamationCircleIcon,
	PencilSquareIcon,
	PlusIcon,
	ReceiptPercentIcon,
	TrashIcon,
	UserGroupIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { LayoutAdminAuthenticated } from "~/components/layouts/layout";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api, type RouterInputs, type RouterOutputs } from "~/utils/api";

type ApiError = { message?: string };
type AdminPlan = RouterOutputs["billingAdmin"]["getPlans"]["plans"][number];
type SubscriptionSummary =
	RouterOutputs["billingAdmin"]["getDashboard"]["subscriptions"][number];
type SaveAlipayConfigInput = RouterInputs["billingAdmin"]["saveAlipayConfig"];

const billingAdminApi = api.billingAdmin;

type AdminTab = "overview" | "plans" | "orders" | "alipay";

type PlanDraft = {
	id?: string;
	name: string;
	description: string;
	priceYuan: string;
	durationMonths: string;
	level: string;
	isActive: boolean;
	userGroupId: string;
};

type RenewalDraft = {
	userId: string;
	planId: string;
	durationMonths: string;
	amountYuan: string;
	note: string;
};

type AlipayGateway = typeof ALIPAY_PRODUCTION_GATEWAY | typeof ALIPAY_SANDBOX_GATEWAY;

type AlipayDraft = {
	enabled: boolean;
	appId: string;
	gateway: AlipayGateway;
	alipayPublicKey: string;
	privateKey: string;
	feeRatePercent: string;
};

const ALIPAY_PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do";
const ALIPAY_SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

const EMPTY_PLAN: PlanDraft = {
	name: "",
	description: "",
	priceYuan: "",
	durationMonths: "1",
	level: "0",
	isActive: true,
	userGroupId: "",
};

const EMPTY_RENEWAL: RenewalDraft = {
	userId: "",
	planId: "",
	durationMonths: "1",
	amountYuan: "0",
	note: "",
};

const EMPTY_ALIPAY: AlipayDraft = {
	enabled: false,
	appId: "",
	gateway: ALIPAY_PRODUCTION_GATEWAY,
	alipayPublicKey: "",
	privateKey: "",
	feeRatePercent: "0",
};

const AdminBilling = () => {
	const t = useTranslations("billing.admin");
	const billingT = useTranslations("billing");
	const locale = useLocale();
	const [activeTab, setActiveTab] = useState<AdminTab>("overview");
	const [planDraft, setPlanDraft] = useState<PlanDraft>(EMPTY_PLAN);
	const [showPlanEditor, setShowPlanEditor] = useState(false);
	const [renewalDraft, setRenewalDraft] = useState<RenewalDraft>(EMPTY_RENEWAL);
	const [showRenewalEditor, setShowRenewalEditor] = useState(false);
	const [alipayDraft, setAlipayDraft] = useState<AlipayDraft>(EMPTY_ALIPAY);
	const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
	const [togglingPlanId, setTogglingPlanId] = useState<string | null>(null);
	const [queryingOrderId, setQueryingOrderId] = useState<string | null>(null);

	const dashboard = billingAdminApi.getDashboard.useQuery(undefined);
	const plansResult = billingAdminApi.getPlans.useQuery(undefined);
	const ordersResult = billingAdminApi.getOrders.useQuery(undefined);
	const alipayConfig = billingAdminApi.getAlipayConfig.useQuery(undefined);

	const showError = (error: ApiError) =>
		toast.error(error.message || t("messages.operationFailed"));

	const savePlanMutation = billingAdminApi.savePlan.useMutation({
		onSuccess: () => {
			toast.success(t("messages.planSaved"));
			setShowPlanEditor(false);
			setPlanDraft(EMPTY_PLAN);
			void plansResult.refetch();
			void dashboard.refetch();
		},
		onError: showError,
	});

	const deletePlanMutation = billingAdminApi.deletePlan.useMutation({
		onSuccess: () => {
			toast.success(t("messages.planDeleted"));
			setDeletingPlanId(null);
			void plansResult.refetch();
			void dashboard.refetch();
		},
		onError: (error) => {
			setDeletingPlanId(null);
			showError(error);
		},
	});

	const togglePlanMutation = billingAdminApi.savePlan.useMutation({
		onSuccess: () => {
			toast.success(t("messages.planAvailabilitySaved"));
			setTogglingPlanId(null);
			void plansResult.refetch();
			void dashboard.refetch();
		},
		onError: (error) => {
			setTogglingPlanId(null);
			showError(error);
		},
	});

	const queryOrderMutation = billingAdminApi.queryOrder.useMutation({
		onSuccess: async () => {
			await Promise.all([ordersResult.refetch(), dashboard.refetch()]);
			toast.success(t("messages.orderQueried"));
			setQueryingOrderId(null);
		},
		onError: (error) => {
			setQueryingOrderId(null);
			showError(error);
		},
	});

	const manualRenewMutation = billingAdminApi.manualRenew.useMutation({
		onSuccess: () => {
			toast.success(t("messages.renewed"));
			setShowRenewalEditor(false);
			setRenewalDraft(EMPTY_RENEWAL);
			void dashboard.refetch();
			void ordersResult.refetch();
		},
		onError: showError,
	});

	const saveAlipayMutation = billingAdminApi.saveAlipayConfig.useMutation({
		onSuccess: () => {
			toast.success(t("messages.alipaySaved"));
			setAlipayDraft((current) => ({
				...current,
				alipayPublicKey: "",
				privateKey: "",
			}));
			void alipayConfig.refetch();
		},
		onError: showError,
	});

	useEffect(() => {
		if (!alipayConfig.data) return;
		const gateway =
			alipayConfig.data.gateway === ALIPAY_SANDBOX_GATEWAY
				? ALIPAY_SANDBOX_GATEWAY
				: ALIPAY_PRODUCTION_GATEWAY;
		setAlipayDraft({
			enabled: alipayConfig.data.enabled,
			appId: alipayConfig.data.appId,
			gateway,
			alipayPublicKey: "",
			privateKey: "",
			feeRatePercent: String(alipayConfig.data.feeRateBps / 100),
		});
	}, [alipayConfig.data]);

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
		if (!value) return billingT("notAvailable");
		const date = new Date(value);
		return Number.isNaN(date.getTime())
			? billingT("notAvailable")
			: dateFormatter.format(date);
	};

	const openPlanEditor = (plan?: AdminPlan) => {
		setPlanDraft(
			plan
				? {
						id: plan.id,
						name: plan.name,
						description: plan.description ?? "",
						priceYuan: String(plan.priceCents / 100),
						durationMonths: String(plan.durationMonths),
						level: String(plan.level),
						isActive: plan.isActive,
						userGroupId: String(plan.userGroupId),
					}
				: EMPTY_PLAN,
		);
		setShowPlanEditor(true);
	};

	const submitPlan = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const price = Number(planDraft.priceYuan);
		const durationMonths = Number(planDraft.durationMonths);
		const level = Number(planDraft.level);
		const userGroupId = Number(planDraft.userGroupId);
		if (
			!planDraft.name.trim() ||
			!planDraft.userGroupId ||
			!Number.isFinite(price) ||
			price <= 0 ||
			!Number.isInteger(durationMonths) ||
			durationMonths < 1 ||
			!Number.isInteger(level) ||
			!Number.isInteger(userGroupId) ||
			userGroupId < 1
		) {
			toast.error(t("validation.plan"));
			return;
		}

		savePlanMutation.mutate({
			...(planDraft.id ? { id: planDraft.id } : {}),
			name: planDraft.name.trim(),
			description: planDraft.description.trim(),
			priceCents: Math.round(price * 100),
			durationMonths,
			level,
			isActive: planDraft.isActive,
			userGroupId,
		});
	};

	const togglePlanAvailability = (plan: AdminPlan) => {
		setTogglingPlanId(plan.id);
		togglePlanMutation.mutate({
			id: plan.id,
			name: plan.name,
			description: plan.description ?? "",
			priceCents: plan.priceCents,
			durationMonths: plan.durationMonths,
			level: plan.level,
			isActive: !plan.isActive,
			userGroupId: plan.userGroupId,
		});
	};

	const requestDeletePlan = (plan: AdminPlan) => {
		if (!window.confirm(t("plans.deleteConfirm", { name: plan.name }))) return;
		setDeletingPlanId(plan.id);
		deletePlanMutation.mutate({ id: plan.id });
	};

	const openRenewalEditor = (subscription?: SubscriptionSummary) => {
		const selectedPlan =
			plansResult.data?.plans.find((plan) => plan.id === subscription?.planId) ??
			plansResult.data?.plans[0];
		setRenewalDraft({
			...EMPTY_RENEWAL,
			userId: subscription?.userId ?? dashboard.data?.renewableUsers[0]?.id ?? "",
			planId: selectedPlan?.id ?? "",
			durationMonths: String(selectedPlan?.durationMonths ?? 1),
			amountYuan: selectedPlan ? String(selectedPlan.priceCents / 100) : "0",
		});
		setShowRenewalEditor(true);
	};

	const selectRenewalPlan = (planId: string) => {
		const plan = plansResult.data?.plans.find((item) => item.id === planId);
		setRenewalDraft((current) => ({
			...current,
			planId,
			durationMonths: String(plan?.durationMonths ?? 1),
			amountYuan: plan ? String(plan.priceCents / 100) : current.amountYuan,
		}));
	};

	const submitRenewal = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const durationMonths = Number(renewalDraft.durationMonths);
		const amount = Number(renewalDraft.amountYuan);
		if (
			!renewalDraft.userId ||
			!renewalDraft.planId ||
			!Number.isInteger(durationMonths) ||
			durationMonths < 1 ||
			!Number.isFinite(amount) ||
			amount < 0
		) {
			toast.error(t("validation.renewal"));
			return;
		}
		manualRenewMutation.mutate({
			userId: renewalDraft.userId,
			planId: renewalDraft.planId,
			durationMonths,
			amountCents: Math.round(amount * 100),
			note: renewalDraft.note.trim(),
		});
	};

	const submitAlipay = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const feeRateText = alipayDraft.feeRatePercent.trim();
		if (!/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/.test(feeRateText)) {
			toast.error(t("validation.alipayFee"));
			return;
		}
		const feeRateBps = Math.round(Number(feeRateText) * 100);
		if (
			alipayDraft.enabled &&
			(!alipayDraft.appId.trim() ||
				(!alipayConfig.data?.hasPublicKey && !alipayDraft.alipayPublicKey.trim()) ||
				(!alipayConfig.data?.hasPrivateKey && !alipayDraft.privateKey.trim()))
		) {
			toast.error(t("validation.alipay"));
			return;
		}

		const baseConfig: SaveAlipayConfigInput = {
			enabled: alipayDraft.enabled,
			appId: alipayDraft.appId.trim(),
			gateway: alipayDraft.gateway,
			feeRateBps,
		};
		const alipayPublicKey = alipayDraft.alipayPublicKey.trim();
		const privateKey = alipayDraft.privateKey.trim();
		saveAlipayMutation.mutate({
			...baseConfig,
			...(alipayPublicKey ? { alipayPublicKey } : {}),
			...(privateKey ? { privateKey } : {}),
		});
	};

	const tabs: Array<{ id: AdminTab; label: string }> = [
		{ id: "overview", label: t("tabs.overview") },
		{ id: "plans", label: t("tabs.plans") },
		{ id: "orders", label: t("tabs.orders") },
		{ id: "alipay", label: t("tabs.alipay") },
	];

	const renderQueryError = (
		title: string,
		message: string | undefined,
		refetch: () => Promise<unknown> | undefined,
	) => (
		<div role="alert" className="alert alert-error">
			<ExclamationCircleIcon className="h-6 w-6 shrink-0" />
			<div className="min-w-0 flex-1">
				<p className="font-semibold">{title}</p>
				<p className="text-sm">{message || t("errors.load")}</p>
			</div>
			<button type="button" className="btn btn-sm" onClick={() => void refetch()}>
				<ArrowPathIcon className="h-4 w-4" />
				{billingT("retry")}
			</button>
		</div>
	);

	const renderLoading = (label: string) => (
		<div
			role="status"
			className="flex min-h-48 items-center justify-center gap-3 text-base-content/65"
		>
			<span className="loading loading-spinner loading-md text-primary" />
			<span>{label}</span>
		</div>
	);

	return (
		<main className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
			<header className="flex flex-wrap items-end justify-between gap-4 border-b border-base-300 pb-5">
				<div>
					<h1 className="text-2xl font-semibold">{t("title")}</h1>
					<p className="mt-1 text-sm text-base-content/65">{t("description")}</p>
				</div>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={() => openRenewalEditor()}
				>
					<ClockIcon className="h-4 w-4" />
					{t("renewal.open")}
				</button>
			</header>

			<div
				role="tablist"
				aria-label={t("tabs.label")}
				className="tabs tabs-bordered overflow-x-auto"
			>
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						aria-selected={activeTab === tab.id}
						className={`tab min-w-28 ${activeTab === tab.id ? "tab-active" : ""}`}
						onClick={() => setActiveTab(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{showRenewalEditor ? (
				<section
					aria-labelledby="renewal-title"
					className="border border-primary/40 bg-primary/5 p-5"
				>
					<div className="flex items-start justify-between gap-4">
						<div>
							<h2 id="renewal-title" className="text-lg font-semibold">
								{t("renewal.title")}
							</h2>
							<p className="mt-1 text-sm text-base-content/65">
								{t("renewal.description")}
							</p>
						</div>
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-square"
							onClick={() => setShowRenewalEditor(false)}
							aria-label={t("close")}
							title={t("close")}
						>
							<XMarkIcon className="h-5 w-5" />
						</button>
					</div>
					<form
						className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
						onSubmit={submitRenewal}
					>
						<label className="form-control w-full">
							<span className="label-text mb-2">{t("renewal.user")}</span>
							<select
								className="select select-bordered w-full"
								value={renewalDraft.userId}
								onChange={(event) =>
									setRenewalDraft((current) => ({
										...current,
										userId: event.target.value,
									}))
								}
								required
							>
								<option value="">{t("renewal.selectUser")}</option>
								{dashboard.data?.renewableUsers.map((user) => (
									<option key={user.id} value={user.id}>
										{user.name ? `${user.name} - ` : ""}
										{user.email}
									</option>
								))}
							</select>
						</label>
						<label className="form-control w-full">
							<span className="label-text mb-2">{t("renewal.plan")}</span>
							<select
								className="select select-bordered w-full"
								value={renewalDraft.planId}
								onChange={(event) => selectRenewalPlan(event.target.value)}
								required
							>
								<option value="">{t("renewal.selectPlan")}</option>
								{plansResult.data?.plans.map((plan) => (
									<option key={plan.id} value={plan.id}>
										{plan.name}
									</option>
								))}
							</select>
						</label>
						<label className="form-control w-full">
							<span className="label-text mb-2">{t("renewal.durationMonths")}</span>
							<input
								type="number"
								min="1"
								step="1"
								className="input input-bordered w-full"
								value={renewalDraft.durationMonths}
								onChange={(event) =>
									setRenewalDraft((current) => ({
										...current,
										durationMonths: event.target.value,
									}))
								}
								required
							/>
						</label>
						<label className="form-control w-full">
							<span className="label-text mb-2">{t("renewal.amount")}</span>
							<input
								type="number"
								min="0"
								step="0.01"
								className="input input-bordered w-full"
								value={renewalDraft.amountYuan}
								onChange={(event) =>
									setRenewalDraft((current) => ({
										...current,
										amountYuan: event.target.value,
									}))
								}
								required
							/>
						</label>
						<label className="form-control w-full md:col-span-2 xl:col-span-3">
							<span className="label-text mb-2">{t("renewal.note")}</span>
							<textarea
								className="textarea textarea-bordered min-h-20 w-full"
								value={renewalDraft.note}
								onChange={(event) =>
									setRenewalDraft((current) => ({ ...current, note: event.target.value }))
								}
							/>
						</label>
						<div className="flex justify-end gap-2 md:col-span-2 xl:col-span-3">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setShowRenewalEditor(false)}
							>
								{t("cancel")}
							</button>
							<button
								type="submit"
								className="btn btn-primary"
								disabled={manualRenewMutation.isLoading}
							>
								{manualRenewMutation.isLoading ? (
									<span className="loading loading-spinner loading-sm" />
								) : null}
								{t("renewal.submit")}
							</button>
						</div>
					</form>
				</section>
			) : null}

			{activeTab === "overview" ? (
				<section aria-labelledby="dashboard-title" className="space-y-5">
					<h2 id="dashboard-title" className="sr-only">
						{t("tabs.overview")}
					</h2>
					{dashboard.isLoading ? renderLoading(t("loading.dashboard")) : null}
					{dashboard.isError
						? renderQueryError(
								t("errors.dashboardTitle"),
								dashboard.error?.message,
								dashboard.refetch,
							)
						: null}
					{dashboard.data ? (
						<>
							<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
								<div className="border border-base-300 p-4">
									<UserGroupIcon className="h-6 w-6 text-primary" />
									<p className="mt-3 text-2xl font-semibold">
										{dashboard.data.metrics.activeSubscriptions}
									</p>
									<p className="text-sm text-base-content/60">
										{t("metrics.activeSubscriptions")}
									</p>
								</div>
								<div className="border border-base-300 p-4">
									<ClockIcon className="h-6 w-6 text-warning" />
									<p className="mt-3 text-2xl font-semibold">
										{dashboard.data.metrics.expiringSoon}
									</p>
									<p className="text-sm text-base-content/60">
										{t("metrics.expiringSoon")}
									</p>
								</div>
								<div className="border border-base-300 p-4">
									<ReceiptPercentIcon className="h-6 w-6 text-info" />
									<p className="mt-3 text-2xl font-semibold">
										{dashboard.data.metrics.pendingOrders}
									</p>
									<p className="text-sm text-base-content/60">
										{t("metrics.pendingOrders")}
									</p>
								</div>
								<div className="border border-base-300 p-4">
									<BanknotesIcon className="h-6 w-6 text-success" />
									<p className="mt-3 text-2xl font-semibold">
										{currencyFormatter.format(dashboard.data.metrics.revenueCents / 100)}
									</p>
									<p className="text-sm text-base-content/60">{t("metrics.revenue")}</p>
								</div>
							</div>

							<div>
								<div className="mb-3 flex flex-wrap items-end justify-between gap-3">
									<div>
										<h3 className="text-lg font-semibold">{t("subscriptions.title")}</h3>
										<p className="text-sm text-base-content/60">
											{t("subscriptions.description")}
										</p>
									</div>
								</div>
								{dashboard.data.subscriptions.length === 0 ? (
									<div className="border border-dashed border-base-300 p-8 text-center text-base-content/60">
										{t("subscriptions.empty")}
									</div>
								) : (
									<div className="overflow-x-auto border border-base-300">
										<table className="table table-zebra">
											<thead>
												<tr>
													<th>{t("subscriptions.user")}</th>
													<th>{t("subscriptions.plan")}</th>
													<th>{t("subscriptions.status")}</th>
													<th>{t("subscriptions.expires")}</th>
													<th>{t("subscriptions.networks")}</th>
													<th className="text-right">{t("subscriptions.actions")}</th>
												</tr>
											</thead>
											<tbody>
												{dashboard.data.subscriptions.map((subscription) => (
													<tr key={subscription.id}>
														<td>
															<p className="font-medium">
																{subscription.userName || subscription.userEmail}
															</p>
															{subscription.userName ? (
																<p className="text-xs text-base-content/60">
																	{subscription.userEmail}
																</p>
															) : null}
														</td>
														<td>{subscription.planName}</td>
														<td>
															<span className="badge badge-outline">
																{billingT(`status.${subscription.status.toLowerCase()}`)}
															</span>
														</td>
														<td>{formatDate(subscription.expiresAt)}</td>
														<td>
															{subscription.networkUsage} /{" "}
															{subscription.networkLimit ?? billingT("usage.unlimited")}
														</td>
														<td className="text-right">
															<button
																type="button"
																className="btn btn-ghost btn-xs"
																onClick={() => openRenewalEditor(subscription)}
															>
																<ClockIcon className="h-4 w-4" />
																{t("renewal.open")}
															</button>
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</div>
						</>
					) : null}
				</section>
			) : null}

			{activeTab === "plans" ? (
				<section aria-labelledby="plans-admin-title" className="space-y-5">
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div>
							<h2 id="plans-admin-title" className="text-lg font-semibold">
								{t("plans.title")}
							</h2>
							<p className="text-sm text-base-content/60">{t("plans.description")}</p>
						</div>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => openPlanEditor()}
						>
							<PlusIcon className="h-4 w-4" />
							{t("plans.add")}
						</button>
					</div>

					{showPlanEditor ? (
						<form
							className="border border-primary/40 bg-primary/5 p-5"
							onSubmit={submitPlan}
						>
							<div className="flex items-center justify-between gap-3">
								<h3 className="font-semibold">
									{planDraft.id ? t("plans.edit") : t("plans.create")}
								</h3>
								<button
									type="button"
									className="btn btn-ghost btn-sm btn-square"
									onClick={() => setShowPlanEditor(false)}
									aria-label={t("close")}
									title={t("close")}
								>
									<XMarkIcon className="h-5 w-5" />
								</button>
							</div>
							<div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("plans.fields.name")}</span>
									<input
										className="input input-bordered w-full"
										value={planDraft.name}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												name: event.target.value,
											}))
										}
										required
									/>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("plans.fields.group")}</span>
									<select
										className="select select-bordered w-full"
										value={planDraft.userGroupId}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												userGroupId: event.target.value,
											}))
										}
										required
									>
										<option value="">{t("plans.fields.selectGroup")}</option>
										{plansResult.data?.userGroups.map((group) => (
											<option key={group.id} value={group.id}>
												{group.name} ({group.maxNetworks ?? billingT("usage.unlimited")})
											</option>
										))}
									</select>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("plans.fields.price")}</span>
									<input
										type="number"
										min="0.01"
										step="0.01"
										className="input input-bordered w-full"
										value={planDraft.priceYuan}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												priceYuan: event.target.value,
											}))
										}
										required
									/>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("plans.fields.duration")}</span>
									<input
										type="number"
										min="1"
										step="1"
										className="input input-bordered w-full"
										value={planDraft.durationMonths}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												durationMonths: event.target.value,
											}))
										}
										required
									/>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("plans.fields.level")}</span>
									<input
										type="number"
										step="1"
										className="input input-bordered w-full"
										value={planDraft.level}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												level: event.target.value,
											}))
										}
										required
									/>
								</label>
								<label className="form-control md:col-span-2 xl:col-span-3">
									<span className="label-text mb-2">{t("plans.fields.description")}</span>
									<textarea
										className="textarea textarea-bordered min-h-20 w-full"
										value={planDraft.description}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												description: event.target.value,
											}))
										}
									/>
								</label>
								<label className="flex cursor-pointer items-center gap-3 md:col-span-2 xl:col-span-3">
									<input
										type="checkbox"
										className="toggle toggle-primary"
										checked={planDraft.isActive}
										onChange={(event) =>
											setPlanDraft((current) => ({
												...current,
												isActive: event.target.checked,
											}))
										}
									/>
									<span>{t("plans.fields.active")}</span>
								</label>
							</div>
							<div className="mt-5 flex justify-end gap-2">
								<button
									type="button"
									className="btn btn-ghost"
									onClick={() => setShowPlanEditor(false)}
								>
									{t("cancel")}
								</button>
								<button
									type="submit"
									className="btn btn-primary"
									disabled={savePlanMutation.isLoading}
								>
									{savePlanMutation.isLoading ? (
										<span className="loading loading-spinner loading-sm" />
									) : null}
									{t("plans.save")}
								</button>
							</div>
						</form>
					) : null}

					{plansResult.isLoading ? renderLoading(t("loading.plans")) : null}
					{plansResult.isError
						? renderQueryError(
								t("errors.plansTitle"),
								plansResult.error?.message,
								plansResult.refetch,
							)
						: null}
					{plansResult.data ? (
						plansResult.data.plans.length === 0 ? (
							<div className="border border-dashed border-base-300 p-8 text-center text-base-content/60">
								<CreditCardIcon className="mx-auto h-8 w-8" />
								<p className="mt-3">{t("plans.empty")}</p>
							</div>
						) : (
							<div className="overflow-x-auto border border-base-300">
								<table className="table table-zebra min-w-[64rem]">
									<thead>
										<tr>
											<th>{t("plans.columns.name")}</th>
											<th>{t("plans.columns.group")}</th>
											<th>{t("plans.columns.price")}</th>
											<th>{t("plans.columns.duration")}</th>
											<th>{t("plans.columns.subscribers")}</th>
											<th>{t("plans.columns.status")}</th>
											<th className="text-right">{t("plans.columns.actions")}</th>
										</tr>
									</thead>
									<tbody>
										{plansResult.data.plans.map((plan) => (
											<tr key={plan.id}>
												<td>
													<p className="font-medium">{plan.name}</p>
													<p className="max-w-xs truncate text-xs text-base-content/55">
														{plan.description || billingT("plans.noDescription")}
													</p>
												</td>
												<td>
													{plan.userGroupName} (
													{plan.maxNetworks ?? billingT("usage.unlimited")})
												</td>
												<td>{currencyFormatter.format(plan.priceCents / 100)}</td>
												<td>{t("plans.months", { count: plan.durationMonths })}</td>
												<td>{plan.subscriberCount}</td>
												<td>
													<span
														className={`badge ${plan.isActive ? "badge-success" : "badge-ghost"}`}
													>
														{plan.isActive ? t("plans.active") : t("plans.inactive")}
													</span>
												</td>
												<td>
													<div className="flex justify-end gap-1">
														<button
															type="button"
															className="btn btn-ghost btn-sm btn-square"
															onClick={() => togglePlanAvailability(plan)}
															disabled={togglePlanMutation.isLoading}
															aria-label={
																plan.isActive
																	? t("plans.hideNamed", { name: plan.name })
																	: t("plans.publishNamed", { name: plan.name })
															}
															title={
																plan.isActive
																	? t("plans.hideNamed", { name: plan.name })
																	: t("plans.publishNamed", { name: plan.name })
															}
														>
															{togglePlanMutation.isLoading &&
															togglingPlanId === plan.id ? (
																<span className="loading loading-spinner loading-xs" />
															) : plan.isActive ? (
																<EyeSlashIcon className="h-4 w-4" />
															) : (
																<EyeIcon className="h-4 w-4" />
															)}
														</button>
														<button
															type="button"
															className="btn btn-ghost btn-sm btn-square"
															onClick={() => openPlanEditor(plan)}
															aria-label={t("plans.editNamed", { name: plan.name })}
															title={t("plans.editNamed", { name: plan.name })}
														>
															<PencilSquareIcon className="h-4 w-4" />
														</button>
														<button
															type="button"
															className="btn btn-ghost btn-sm btn-square text-error"
															onClick={() => requestDeletePlan(plan)}
															disabled={
																deletePlanMutation.isLoading && deletingPlanId === plan.id
															}
															aria-label={t("plans.deleteNamed", { name: plan.name })}
															title={t("plans.deleteNamed", { name: plan.name })}
														>
															{deletePlanMutation.isLoading &&
															deletingPlanId === plan.id ? (
																<span className="loading loading-spinner loading-xs" />
															) : (
																<TrashIcon className="h-4 w-4" />
															)}
														</button>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)
					) : null}
				</section>
			) : null}

			{activeTab === "orders" ? (
				<section aria-labelledby="admin-orders-title" className="space-y-4">
					<div>
						<h2 id="admin-orders-title" className="text-lg font-semibold">
							{t("orders.title")}
						</h2>
						<p className="text-sm text-base-content/60">{t("orders.description")}</p>
					</div>
					{queryOrderMutation.isLoading && queryingOrderId ? (
						<div
							role="status"
							aria-live="polite"
							className="border border-info/40 bg-info/5 p-4"
						>
							<div className="flex items-center gap-3 text-sm">
								<ArrowPathIcon className="h-5 w-5 animate-spin text-info" />
								<span>{t("orders.querying")}</span>
							</div>
							<progress className="progress progress-info mt-3 h-1.5 w-full" />
						</div>
					) : null}
					{ordersResult.isLoading ? renderLoading(t("loading.orders")) : null}
					{ordersResult.isError
						? renderQueryError(
								t("errors.ordersTitle"),
								ordersResult.error?.message,
								ordersResult.refetch,
							)
						: null}
					{ordersResult.data ? (
						ordersResult.data.orders.length === 0 ? (
							<div className="border border-dashed border-base-300 p-8 text-center text-base-content/60">
								{t("orders.empty")}
							</div>
						) : (
							<div className="overflow-x-auto border border-base-300">
								<table className="table table-zebra min-w-[72rem]">
									<thead>
										<tr>
											<th>{t("orders.number")}</th>
											<th>{t("orders.user")}</th>
											<th>{t("orders.plan")}</th>
											<th>{t("orders.amount")}</th>
											<th>{t("orders.status")}</th>
											<th>{t("orders.createdAt")}</th>
											<th>{t("orders.tradeNo")}</th>
											<th className="text-right">{t("orders.actions")}</th>
										</tr>
									</thead>
									<tbody>
										{ordersResult.data.orders.map((order) => (
											<tr key={order.id}>
												<td className="font-mono text-xs">{order.merchantOrderNo}</td>
												<td>{order.userEmail}</td>
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
													<span className="badge badge-outline">
														{billingT(`status.${order.status.toLowerCase()}`)}
													</span>
												</td>
												<td>{formatDate(order.createdAt)}</td>
												<td className="font-mono text-xs">
													{order.alipayTradeNo || billingT("notAvailable")}
												</td>
												<td className="text-right">
													{["PENDING", "PAID"].includes(order.status.toUpperCase()) ? (
														<button
															type="button"
															className="btn btn-ghost btn-sm btn-square"
															disabled={queryOrderMutation.isLoading}
															onClick={() => {
																setQueryingOrderId(order.id);
																queryOrderMutation.mutate({ orderId: order.id });
															}}
															aria-label={t("orders.queryNamed", {
																orderNo: order.merchantOrderNo,
															})}
															title={t("orders.queryNamed", {
																orderNo: order.merchantOrderNo,
															})}
														>
															{queryOrderMutation.isLoading &&
															queryingOrderId === order.id ? (
																<span className="loading loading-spinner loading-xs" />
															) : (
																<ArrowPathIcon className="h-4 w-4" />
															)}
														</button>
													) : (
														<span className="text-base-content/35">-</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)
					) : null}
				</section>
			) : null}

			{activeTab === "alipay" ? (
				<section aria-labelledby="alipay-title" className="space-y-5">
					<div>
						<h2 id="alipay-title" className="text-lg font-semibold">
							{t("alipay.title")}
						</h2>
						<p className="text-sm text-base-content/60">{t("alipay.description")}</p>
					</div>
					{alipayConfig.isLoading ? renderLoading(t("loading.alipay")) : null}
					{alipayConfig.isError
						? renderQueryError(
								t("errors.alipayTitle"),
								alipayConfig.error?.message,
								alipayConfig.refetch,
							)
						: null}
					{alipayConfig.data ? (
						<form className="space-y-5" onSubmit={submitAlipay}>
							<div className="flex flex-wrap items-center justify-between gap-4 border-y border-base-300 py-4">
								<div>
									<p className="font-medium">{t("alipay.enable")}</p>
									<p className="text-sm text-base-content/60">
										{t("alipay.enableDescription")}
									</p>
								</div>
								<input
									type="checkbox"
									className="toggle toggle-primary"
									checked={alipayDraft.enabled}
									onChange={(event) =>
										setAlipayDraft((current) => ({
											...current,
											enabled: event.target.checked,
										}))
									}
									aria-label={t("alipay.enable")}
								/>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								<label className="form-control w-full md:col-span-2">
									<span className="label-text mb-2">{t("alipay.appId")}</span>
									<input
										className="input input-bordered w-full font-mono"
										value={alipayDraft.appId}
										onChange={(event) =>
											setAlipayDraft((current) => ({
												...current,
												appId: event.target.value,
											}))
										}
									/>
								</label>
								<label className="form-control w-full md:col-span-2">
									<span className="label-text mb-2 flex flex-wrap items-center gap-2">
										{t("alipay.privateKey")}
										{alipayConfig.data.hasPrivateKey ? (
											<span className="badge badge-success badge-outline gap-1">
												<CheckCircleIcon className="h-3.5 w-3.5" />
												{t("alipay.privateKeyConfigured")}
											</span>
										) : null}
									</span>
									<textarea
										className="textarea textarea-bordered min-h-32 w-full font-mono text-xs"
										name="new-alipay-private-key"
										autoComplete="new-password"
										spellCheck={false}
										value={alipayDraft.privateKey}
										onChange={(event) =>
											setAlipayDraft((current) => ({
												...current,
												privateKey: event.target.value,
											}))
										}
										placeholder={
											alipayConfig.data.hasPrivateKey
												? t("alipay.privateKeyKeep")
												: t("alipay.privateKeyRequired")
										}
										aria-describedby="private-key-help"
									/>
									<span
										id="private-key-help"
										className="mt-2 text-xs text-base-content/60"
									>
										{t("alipay.privateKeyHelp")}
									</span>
								</label>
								<label className="form-control w-full md:col-span-2">
									<span className="label-text mb-2 flex flex-wrap items-center gap-2">
										{t("alipay.publicKey")}
										{alipayConfig.data.hasPublicKey ? (
											<span className="badge badge-success badge-outline gap-1">
												<CheckCircleIcon className="h-3.5 w-3.5" />
												{t("alipay.publicKeyConfigured")}
											</span>
										) : null}
									</span>
									<textarea
										className="textarea textarea-bordered min-h-32 w-full font-mono text-xs"
										name="new-alipay-public-key"
										autoComplete="off"
										spellCheck={false}
										value={alipayDraft.alipayPublicKey}
										onChange={(event) =>
											setAlipayDraft((current) => ({
												...current,
												alipayPublicKey: event.target.value,
											}))
										}
										placeholder={
											alipayConfig.data.hasPublicKey
												? t("alipay.publicKeyKeep")
												: t("alipay.publicKeyRequired")
										}
										aria-describedby="alipay-public-key-help"
									/>
									<span
										id="alipay-public-key-help"
										className="mt-2 text-xs text-base-content/60"
									>
										{t("alipay.publicKeyHelp")}
									</span>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("alipay.feeRate")}</span>
									<div className="join w-full">
										<input
											type="number"
											min="0"
											max="100"
											step="0.01"
											className="input join-item input-bordered w-full"
											value={alipayDraft.feeRatePercent}
											onChange={(event) =>
												setAlipayDraft((current) => ({
													...current,
													feeRatePercent: event.target.value,
												}))
											}
										/>
										<span className="join-item flex items-center border border-base-300 bg-base-200 px-4">
											%
										</span>
									</div>
									<span className="mt-2 text-xs text-base-content/60">
										{t("alipay.feeRateHelp")}
									</span>
								</label>
								<label className="form-control w-full">
									<span className="label-text mb-2">{t("alipay.gateway")}</span>
									<input
										type="url"
										className="input input-bordered w-full font-mono text-sm"
										value={alipayDraft.gateway}
										readOnly
									/>
									<span className="mt-2 text-xs text-base-content/60">
										{t("alipay.gatewayHelp")}
									</span>
								</label>
							</div>
							<label className="flex cursor-pointer items-center gap-3 border-y border-base-300 py-4">
								<input
									type="checkbox"
									className="checkbox checkbox-primary"
									checked={alipayDraft.gateway === ALIPAY_SANDBOX_GATEWAY}
									onChange={(event) =>
										setAlipayDraft((current) => ({
											...current,
											gateway: event.target.checked
												? ALIPAY_SANDBOX_GATEWAY
												: ALIPAY_PRODUCTION_GATEWAY,
										}))
									}
								/>
								<span>
									<span className="block font-medium">{t("alipay.sandbox")}</span>
									<span className="block text-sm text-base-content/60">
										{t("alipay.sandboxDescription")}
									</span>
								</span>
							</label>
							<dl className="grid gap-3 text-sm md:grid-cols-[12rem_1fr]">
								<dt className="text-base-content/60">{t("alipay.notifyUrl")}</dt>
								<dd className="break-all font-mono text-xs">
									{alipayConfig.data.notifyUrl}
								</dd>
								<dt className="text-base-content/60">{t("alipay.returnUrl")}</dt>
								<dd className="break-all font-mono text-xs">
									{alipayConfig.data.returnUrl}
								</dd>
							</dl>
							<div className="flex justify-end">
								<button
									type="submit"
									className="btn btn-primary"
									disabled={saveAlipayMutation.isLoading}
								>
									{saveAlipayMutation.isLoading ? (
										<span className="loading loading-spinner loading-sm" />
									) : null}
									{t("alipay.save")}
								</button>
							</div>
						</form>
					) : null}
				</section>
			) : null}
		</main>
	);
};

AdminBilling.getLayout = function getLayout(page: ReactElement) {
	return <LayoutAdminAuthenticated props={page?.props}>{page}</LayoutAdminAuthenticated>;
};

export { getServerSideProps };
export default AdminBilling;
