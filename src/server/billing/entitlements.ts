export const SUBSCRIPTION_EXPIRED_REASON = "SUBSCRIPTION_EXPIRED" as const;
export const MANUAL_SUSPENSION_REASON = "MANUAL" as const;

export type BillingRole = "ADMIN" | "USER" | "READ_ONLY" | string;

export type AccountAccessState =
	| "ACTIVE"
	| "INACTIVE"
	| "MANUALLY_SUSPENDED"
	| "SUBSCRIPTION_EXPIRED"
	| "ENTITLEMENT_EXPIRED"
	| "NO_ENTITLEMENT";

export type EntitlementSource =
	| "ADMIN"
	| "SUBSCRIPTION"
	| "LEGACY_USER_GROUP"
	| "LEGACY_UNGROUPED"
	| "NONE";

export type EntitlementErrorCode =
	| "USER_NOT_FOUND"
	| "ACCOUNT_INACTIVE"
	| "ACCOUNT_MANUALLY_SUSPENDED"
	| "SUBSCRIPTION_EXPIRED"
	| "ENTITLEMENT_EXPIRED"
	| "NO_ACTIVE_ENTITLEMENT"
	| "NETWORK_LIMIT_REACHED";

export class EntitlementError extends Error {
	readonly code: EntitlementErrorCode;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(
		code: EntitlementErrorCode,
		message: string,
		details?: Readonly<Record<string, unknown>>,
	) {
		super(message);
		this.name = "EntitlementError";
		this.code = code;
		this.details = details;
	}
}

export interface EntitlementUserRecord {
	id: string;
	role: BillingRole;
	isActive: boolean;
	suspensionReason: string | null;
	expiresAt: Date | null;
	legacyBillingExempt: boolean;
	userGroup: {
		id: number;
		maxNetworks: number;
		expiresAt: Date | null;
	} | null;
}

export interface EntitlementSubscriptionRecord {
	id: string;
	userId: string;
	status: string;
	startsAt: Date;
	expiresAt: Date;
	maxNetworksSnapshot?: number | null;
	userGroupIdSnapshot?: number | null;
	plan: {
		id: string;
		userGroup: {
			id: number;
			maxNetworks: number;
		} | null;
	} | null;
}

export interface EntitlementPrisma {
	user: {
		findUnique(args: {
			where: { id: string };
			select: {
				id: true;
				role: true;
				isActive: true;
				suspensionReason: true;
				expiresAt: true;
				legacyBillingExempt: true;
				userGroup: {
					select: { id: true; maxNetworks: true; expiresAt: true };
				};
			};
		}): Promise<EntitlementUserRecord | null>;
	};
	subscription: {
		findFirst(args: {
			where: Readonly<Record<string, unknown>>;
			orderBy: { expiresAt: "desc" };
			select: Readonly<Record<string, unknown>>;
		}): Promise<EntitlementSubscriptionRecord | null>;
	};
	network: {
		count(args: {
			where: { authorId: string; organizationId: null };
		}): Promise<number>;
	};
}

export interface NetworkQuotaReservationRecord {
	id: string;
	userId: string;
	createdAt: Date;
	expiresAt: Date;
}

interface NetworkQuotaReservationDelegate {
	count(args: {
		where: { userId: string; expiresAt: { gt: Date } };
	}): Promise<number>;
	create(args: {
		data: { userId: string; expiresAt: Date };
		select: { id: true; expiresAt: true };
	}): Promise<Pick<NetworkQuotaReservationRecord, "id" | "expiresAt">>;
	deleteMany(args: {
		where:
			| { id: string }
			| { id: string; userId: string }
			| { expiresAt: { lte: Date } }
			| { userId: string; expiresAt: { lte: Date } };
	}): Promise<{ count: number }>;
}

export interface NetworkQuotaReservationTransaction extends EntitlementPrisma {
	$queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
	networkQuotaReservation: NetworkQuotaReservationDelegate;
}

export interface NetworkQuotaReservationPrisma {
	$transaction<T>(
		operation: (transaction: NetworkQuotaReservationTransaction) => Promise<T>,
	): Promise<T>;
	networkQuotaReservation: Pick<NetworkQuotaReservationDelegate, "deleteMany">;
}

async function lockNetworkQuotaUser(
	transaction: NetworkQuotaReservationTransaction,
	userId: string,
): Promise<void> {
	await transaction.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
	`;
}

export interface EntitlementDependencies {
	prisma: EntitlementPrisma;
	now?: () => Date;
}

export interface EffectiveEntitlement {
	userId: string;
	role: BillingRole;
	accountState: AccountAccessState;
	source: EntitlementSource;
	hasActiveEntitlement: boolean;
	maxNetworks: number | null;
	subscriptionId: string | null;
	validUntil: Date | null;
	groupId: number | null;
}

export interface NetworkQuota extends EffectiveEntitlement {
	currentNetworks: number;
	reservedNetworks: number;
	requestedNetworks: number;
	remainingNetworks: number | null;
}

export interface NetworkQuotaReservation {
	id: string | null;
	expiresAt: Date | null;
	quota: NetworkQuota;
}

export const NETWORK_QUOTA_RESERVATION_TTL_MS = 5 * 60 * 1000;

const subscriptionSelect = {
	id: true,
	userId: true,
	status: true,
	startsAt: true,
	expiresAt: true,
	maxNetworksSnapshot: true,
	userGroupIdSnapshot: true,
	plan: {
		select: {
			id: true,
			userGroup: { select: { id: true, maxNetworks: true } },
		},
	},
} as const;

function resolveStoredAccountState(user: EntitlementUserRecord): AccountAccessState {
	if (user.isActive) return "ACTIVE";
	if (user.suspensionReason === SUBSCRIPTION_EXPIRED_REASON) {
		return "SUBSCRIPTION_EXPIRED";
	}
	if (
		user.suspensionReason === MANUAL_SUSPENSION_REASON ||
		user.suspensionReason === "ADMIN"
	) {
		return "MANUALLY_SUSPENDED";
	}
	return "INACTIVE";
}

function isCurrentSubscription(
	subscription: EntitlementSubscriptionRecord,
	now: Date,
): boolean {
	return (
		subscription.status === "ACTIVE" &&
		subscription.startsAt.getTime() <= now.getTime() &&
		subscription.expiresAt.getTime() > now.getTime()
	);
}

function subscriptionNetworkLimit(
	subscription: EntitlementSubscriptionRecord,
): { maxNetworks: number; groupId: number } | null {
	const snapshotLimit = subscription.maxNetworksSnapshot;
	const snapshotGroupId = subscription.userGroupIdSnapshot;
	if (
		typeof snapshotLimit === "number" &&
		Number.isInteger(snapshotLimit) &&
		snapshotLimit >= 0 &&
		typeof snapshotGroupId === "number" &&
		Number.isInteger(snapshotGroupId)
	) {
		return { maxNetworks: snapshotLimit, groupId: snapshotGroupId };
	}

	if (!subscription.plan?.userGroup) return null;
	return {
		maxNetworks: subscription.plan.userGroup.maxNetworks,
		groupId: subscription.plan.userGroup.id,
	};
}

function emptyEntitlement(
	user: EntitlementUserRecord,
	accountState: AccountAccessState,
	validUntil: Date | null = null,
): EffectiveEntitlement {
	return {
		userId: user.id,
		role: user.role,
		accountState,
		source: "NONE",
		hasActiveEntitlement: false,
		maxNetworks: null,
		subscriptionId: null,
		validUntil,
		groupId: null,
	};
}

/**
 * Resolves the one effective entitlement for a user. Subscription history is an
 * ownership boundary: once a user has any subscription, an inactive/expired one
 * may not silently fall back to the legacy UserGroup allowance.
 */
export async function getEffectiveEntitlement(
	dependencies: EntitlementDependencies,
	userId: string,
): Promise<EffectiveEntitlement> {
	const now = dependencies.now?.() ?? new Date();
	const user = await dependencies.prisma.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			role: true,
			isActive: true,
			suspensionReason: true,
			expiresAt: true,
			legacyBillingExempt: true,
			userGroup: {
				select: { id: true, maxNetworks: true, expiresAt: true },
			},
		},
	});

	if (!user) {
		throw new EntitlementError("USER_NOT_FOUND", "User account was not found.", {
			userId,
		});
	}

	const storedAccountState = resolveStoredAccountState(user);
	if (user.role === "ADMIN") {
		return {
			userId: user.id,
			role: user.role,
			accountState: storedAccountState,
			source: "ADMIN",
			hasActiveEntitlement: true,
			maxNetworks: null,
			subscriptionId: null,
			validUntil: null,
			groupId: null,
		};
	}

	if (storedAccountState !== "ACTIVE") {
		return emptyEntitlement(user, storedAccountState);
	}

	const currentSubscription = await dependencies.prisma.subscription.findFirst({
		where: {
			userId,
			status: "ACTIVE",
			startsAt: { lte: now },
			expiresAt: { gt: now },
		},
		orderBy: { expiresAt: "desc" },
		select: subscriptionSelect,
	});
	const currentLimit = currentSubscription
		? subscriptionNetworkLimit(currentSubscription)
		: null;

	if (
		currentSubscription &&
		isCurrentSubscription(currentSubscription, now) &&
		currentLimit
	) {
		return {
			userId: user.id,
			role: user.role,
			accountState: "ACTIVE",
			source: "SUBSCRIPTION",
			hasActiveEntitlement: true,
			maxNetworks: currentLimit.maxNetworks,
			subscriptionId: currentSubscription.id,
			validUntil: currentSubscription.expiresAt,
			groupId: currentLimit.groupId,
		};
	}

	const latestSubscription = await dependencies.prisma.subscription.findFirst({
		where: { userId },
		orderBy: { expiresAt: "desc" },
		select: subscriptionSelect,
	});

	if (latestSubscription) {
		const subscriptionExpired =
			latestSubscription.status === "EXPIRED" ||
			latestSubscription.expiresAt.getTime() <= now.getTime();
		return emptyEntitlement(
			user,
			subscriptionExpired ? "SUBSCRIPTION_EXPIRED" : "NO_ENTITLEMENT",
			latestSubscription.expiresAt,
		);
	}

	if (user.expiresAt && user.expiresAt.getTime() <= now.getTime()) {
		return emptyEntitlement(user, "ENTITLEMENT_EXPIRED", user.expiresAt);
	}

	// Before billing, accounts without a group were intentionally unlimited. The
	// migration marks only those existing accounts so new ungrouped users do not
	// bypass billing.
	if (!user.userGroup && user.legacyBillingExempt) {
		return {
			userId: user.id,
			role: user.role,
			accountState: "ACTIVE",
			source: "LEGACY_UNGROUPED",
			hasActiveEntitlement: true,
			maxNetworks: null,
			subscriptionId: null,
			validUntil: null,
			groupId: null,
		};
	}
	if (!user.userGroup) return emptyEntitlement(user, "NO_ENTITLEMENT");
	if (user.userGroup.expiresAt && user.userGroup.expiresAt.getTime() <= now.getTime()) {
		return emptyEntitlement(user, "ENTITLEMENT_EXPIRED", user.userGroup.expiresAt);
	}

	return {
		userId: user.id,
		role: user.role,
		accountState: "ACTIVE",
		source: "LEGACY_USER_GROUP",
		hasActiveEntitlement: true,
		maxNetworks: user.userGroup.maxNetworks,
		subscriptionId: null,
		validUntil: user.userGroup.expiresAt,
		groupId: user.userGroup.id,
	};
}

function errorForAccountState(entitlement: EffectiveEntitlement): EntitlementError {
	const details = { userId: entitlement.userId, validUntil: entitlement.validUntil };
	switch (entitlement.accountState) {
		case "MANUALLY_SUSPENDED":
			return new EntitlementError(
				"ACCOUNT_MANUALLY_SUSPENDED",
				"This account was suspended manually.",
				details,
			);
		case "SUBSCRIPTION_EXPIRED":
			return new EntitlementError(
				"SUBSCRIPTION_EXPIRED",
				"This account's subscription has expired.",
				details,
			);
		case "ENTITLEMENT_EXPIRED":
			return new EntitlementError(
				"ENTITLEMENT_EXPIRED",
				"This account's legacy entitlement has expired.",
				details,
			);
		case "NO_ENTITLEMENT":
			return new EntitlementError(
				"NO_ACTIVE_ENTITLEMENT",
				"This account has no active service entitlement.",
				details,
			);
		default:
			return new EntitlementError(
				"ACCOUNT_INACTIVE",
				"This account is inactive.",
				details,
			);
	}
}

export async function assertAccountActive(
	dependencies: EntitlementDependencies,
	userId: string,
): Promise<EffectiveEntitlement> {
	const entitlement = await getEffectiveEntitlement(dependencies, userId);
	if (entitlement.accountState !== "ACTIVE") {
		throw errorForAccountState(entitlement);
	}
	if (!entitlement.hasActiveEntitlement) {
		throw new EntitlementError(
			"NO_ACTIVE_ENTITLEMENT",
			"This account has no active service entitlement.",
			{ userId },
		);
	}
	return entitlement;
}

export async function assertNetworkQuota(
	dependencies: EntitlementDependencies,
	userId: string,
	requestedNetworks = 1,
	reservedNetworks = 0,
): Promise<NetworkQuota> {
	if (!Number.isInteger(requestedNetworks) || requestedNetworks < 1) {
		throw new RangeError("requestedNetworks must be a positive integer");
	}
	if (!Number.isInteger(reservedNetworks) || reservedNetworks < 0) {
		throw new RangeError("reservedNetworks must be a non-negative integer");
	}

	const entitlement = await assertAccountActive(dependencies, userId);
	if (entitlement.source === "ADMIN" || entitlement.source === "LEGACY_UNGROUPED") {
		return {
			...entitlement,
			currentNetworks: 0,
			reservedNetworks: 0,
			requestedNetworks,
			remainingNetworks: null,
		};
	}

	const currentNetworks = await dependencies.prisma.network.count({
		where: { authorId: userId, organizationId: null },
	});
	const maxNetworks = entitlement.maxNetworks;
	if (
		maxNetworks === null ||
		currentNetworks + reservedNetworks + requestedNetworks > maxNetworks
	) {
		throw new EntitlementError(
			"NETWORK_LIMIT_REACHED",
			"The account has reached its personal network limit.",
			{
				userId,
				currentNetworks,
				reservedNetworks,
				requestedNetworks,
				maxNetworks,
			},
		);
	}

	return {
		...entitlement,
		currentNetworks,
		reservedNetworks,
		requestedNetworks,
		remainingNetworks:
			maxNetworks - currentNetworks - reservedNetworks - requestedNetworks,
	};
}

/**
 * Serializes quota allocation per user and leaves a short-lived database row
 * covering the controller call that happens outside the transaction.
 */
export async function reserveNetworkQuota(
	dependencies: {
		prisma: NetworkQuotaReservationPrisma;
		now?: () => Date;
		reservationTtlMs?: number;
	},
	userId: string,
): Promise<NetworkQuotaReservation> {
	const now = dependencies.now?.() ?? new Date();
	const reservationTtlMs =
		dependencies.reservationTtlMs ?? NETWORK_QUOTA_RESERVATION_TTL_MS;
	if (!Number.isInteger(reservationTtlMs) || reservationTtlMs < 1) {
		throw new RangeError("reservationTtlMs must be a positive integer");
	}

	return dependencies.prisma.$transaction(async (transaction) => {
		await lockNetworkQuotaUser(transaction, userId);
		await transaction.networkQuotaReservation.deleteMany({
			where: { userId, expiresAt: { lte: now } },
		});
		const reservedNetworks = await transaction.networkQuotaReservation.count({
			where: { userId, expiresAt: { gt: now } },
		});
		const quota = await assertNetworkQuota(
			{ prisma: transaction, now: () => now },
			userId,
			1,
			reservedNetworks,
		);

		if (quota.maxNetworks === null) {
			return { id: null, expiresAt: null, quota };
		}

		const reservation = await transaction.networkQuotaReservation.create({
			data: {
				userId,
				expiresAt: new Date(now.getTime() + reservationTtlMs),
			},
			select: { id: true, expiresAt: true },
		});
		return { ...reservation, quota };
	});
}

/**
 * Atomically replaces one reservation with its database-side network write.
 * Quota is checked again so an expired reservation cannot commit after another
 * request has claimed the released slot.
 */
export async function consumeNetworkQuotaReservation<T>(
	dependencies: {
		prisma: NetworkQuotaReservationPrisma;
		now?: () => Date;
	},
	userId: string,
	reservationId: string,
	operation: (transaction: NetworkQuotaReservationTransaction) => Promise<T>,
): Promise<T> {
	const now = dependencies.now?.() ?? new Date();

	return dependencies.prisma.$transaction(async (transaction) => {
		await lockNetworkQuotaUser(transaction, userId);
		await transaction.networkQuotaReservation.deleteMany({
			where: { id: reservationId, userId },
		});
		const reservedNetworks = await transaction.networkQuotaReservation.count({
			where: { userId, expiresAt: { gt: now } },
		});
		await assertNetworkQuota(
			{ prisma: transaction, now: () => now },
			userId,
			1,
			reservedNetworks,
		);

		return operation(transaction);
	});
}

export async function releaseNetworkQuotaReservation(
	prisma: Pick<NetworkQuotaReservationPrisma, "networkQuotaReservation">,
	reservationId: string | null,
): Promise<number> {
	if (!reservationId) return 0;
	const result = await prisma.networkQuotaReservation.deleteMany({
		where: { id: reservationId },
	});
	return result.count;
}

export async function cleanupExpiredNetworkQuotaReservations(
	prisma: Pick<NetworkQuotaReservationPrisma, "networkQuotaReservation">,
	now = new Date(),
): Promise<number> {
	const result = await prisma.networkQuotaReservation.deleteMany({
		where: { expiresAt: { lte: now } },
	});
	return result.count;
}
