import { MANUAL_SUSPENSION_REASON, SUBSCRIPTION_EXPIRED_REASON } from "./entitlements";
import { disconnectUserSockets } from "~/server/socketRegistry";

export const ADMIN_SUSPENSION_REASON = "ADMIN" as const;

export interface SuspensionUserRecord {
	id: string;
	role: string;
	isActive: boolean;
	suspensionReason: string | null;
}

export interface SuspensionSubscriptionRecord {
	id: string;
	userId: string;
	status: string;
	startsAt: Date;
	expiresAt: Date;
}

export interface SuspensionSnapshotRecord {
	id: string;
	userId: string;
	subscriptionId: string | null;
	networkId: string;
	memberId: string;
	wasAuthorized: boolean;
	suspendedAt: Date | null;
	restoredAt: Date | null;
	lastError: string | null;
	createdAt: Date;
}

export interface PersonalNetworkMemberRecord {
	id: string;
	nwid: string;
}

interface UserDelegate {
	findUnique(args: {
		where: { id: string };
		select: { id: true; role: true; isActive: true; suspensionReason: true };
	}): Promise<SuspensionUserRecord | null>;
	update(args: {
		where: { id: string };
		data: { isActive: boolean; suspensionReason: string };
	}): Promise<unknown>;
}

interface SubscriptionDelegate {
	findUnique(args: {
		where: { id: string };
		select: { id: true; userId: true; status: true; startsAt: true; expiresAt: true };
	}): Promise<SuspensionSubscriptionRecord | null>;
	findFirst(args: {
		where: Readonly<Record<string, unknown>>;
		orderBy: { expiresAt: "desc" };
		select: { id: true; userId: true; status: true; startsAt: true; expiresAt: true };
	}): Promise<SuspensionSubscriptionRecord | null>;
	findMany(args: {
		where: Readonly<Record<string, unknown>>;
		orderBy: { expiresAt: "asc" };
		take: number;
		select: { id: true };
	}): Promise<Array<{ id: string }>>;
	update(args: {
		where: { id: string };
		data: { status: "EXPIRED" };
	}): Promise<unknown>;
}

interface ApiTokenDelegate {
	updateMany(args: {
		where: Readonly<Record<string, unknown>>;
		data: { isActive: boolean };
	}): Promise<{ count: number }>;
}

interface SessionDelegate {
	deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
}

interface NetworkMemberDelegate {
	findMany(args: {
		where: Readonly<Record<string, unknown>>;
		select: { id: true; nwid: true };
	}): Promise<PersonalNetworkMemberRecord[]>;
}

interface SuspensionSnapshotDelegate {
	findMany(args: {
		where: Readonly<Record<string, unknown>>;
		orderBy?: Array<{ networkId: "asc" } | { memberId: "asc" }>;
	}): Promise<SuspensionSnapshotRecord[]>;
	upsert(args: {
		where: {
			userId_networkId_memberId: {
				userId: string;
				networkId: string;
				memberId: string;
			};
		};
		create: {
			userId: string;
			subscriptionId: string;
			networkId: string;
			memberId: string;
			wasAuthorized: true;
		};
		update: Readonly<Record<string, unknown>>;
	}): Promise<SuspensionSnapshotRecord>;
	update(args: {
		where: { id: string };
		data: Readonly<Record<string, unknown>>;
	}): Promise<SuspensionSnapshotRecord>;
}

export interface SuspensionDatabase {
	$executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
	user: UserDelegate;
	subscription: SubscriptionDelegate;
	aPIToken: ApiTokenDelegate;
	session: SessionDelegate;
	network_members: NetworkMemberDelegate;
	subscriptionSuspensionSnapshot: SuspensionSnapshotDelegate;
}

export interface SuspensionPrisma extends SuspensionDatabase {
	$transaction<T>(operation: (transaction: SuspensionDatabase) => Promise<T>): Promise<T>;
}

export interface ControllerUpdateInput {
	userId: string;
	networkId: string;
	memberId: string;
	authorized: boolean;
}

export interface SuspensionDependencies {
	prisma: SuspensionPrisma;
	controllerUpdate(input: ControllerUpdateInput): Promise<unknown>;
	now?: () => Date;
}

export type SuspendResultState =
	| "SUSPENDED"
	| "ALREADY_SUSPENDED"
	| "PARTIAL_FAILURE"
	| "SKIPPED_NOT_FOUND"
	| "SKIPPED_NOT_EXPIRED"
	| "SKIPPED_ADMIN"
	| "SKIPPED_MANUAL"
	| "SKIPPED_INACTIVE";

export interface SuspendExpiredSubscriptionResult {
	state: SuspendResultState;
	subscriptionId: string;
	userId: string | null;
	snapshotIds: string[];
	attemptedMembers: number;
	succeededMembers: number;
	failedMembers: number;
}

export type RestoreResultState =
	| "RESTORED"
	| "ALREADY_ACTIVE"
	| "PARTIAL_FAILURE"
	| "SKIPPED_NOT_FOUND"
	| "SKIPPED_ADMIN"
	| "SKIPPED_MANUAL"
	| "SKIPPED_INACTIVE"
	| "SKIPPED_NO_ACTIVE_SUBSCRIPTION";

export interface RestoreSubscriptionExpiredUserResult {
	state: RestoreResultState;
	userId: string;
	snapshotIds: string[];
	attemptedMembers: number;
	succeededMembers: number;
	failedMembers: number;
	skippedMembers: number;
}

export interface ReconcileExpiredSubscriptionsResult {
	scanned: number;
	suspended: number;
	alreadySuspended: number;
	partialFailures: number;
	skipped: number;
	errors: Array<{ subscriptionId: string; message: string }>;
}

const subscriptionSelect = {
	id: true,
	userId: true,
	status: true,
	startsAt: true,
	expiresAt: true,
} as const;

const userSelect = {
	id: true,
	role: true,
	isActive: true,
	suspensionReason: true,
} as const;

function isManualSuspension(reason: string | null): boolean {
	return reason === MANUAL_SUSPENSION_REASON || reason === ADMIN_SUSPENSION_REASON;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function memberKey(networkId: string, memberId: string): string {
	return `${networkId}:${memberId}`;
}

function emptySuspendResult(
	state: SuspendResultState,
	subscriptionId: string,
	userId: string | null,
): SuspendExpiredSubscriptionResult {
	return {
		state,
		subscriptionId,
		userId,
		snapshotIds: [],
		attemptedMembers: 0,
		succeededMembers: 0,
		failedMembers: 0,
	};
}

async function updateSnapshot(
	database: SuspensionDatabase,
	snapshot: SuspensionSnapshotRecord,
	data: Readonly<Record<string, unknown>>,
): Promise<SuspensionSnapshotRecord> {
	return database.subscriptionSuspensionSnapshot.update({
		where: { id: snapshot.id },
		data,
	});
}

async function rollbackRestoredMembers(
	dependencies: SuspensionDependencies,
	userId: string,
	snapshots: SuspensionSnapshotRecord[],
	reason: string,
): Promise<number> {
	let rollbackFailures = 0;
	for (const snapshot of snapshots.toReversed()) {
		let controllerRolledBack = false;
		try {
			await dependencies.controllerUpdate({
				userId,
				networkId: snapshot.networkId,
				memberId: snapshot.memberId,
				authorized: false,
			});
			controllerRolledBack = true;
			await updateSnapshot(dependencies.prisma, snapshot, {
				restoredAt: null,
				lastError: reason,
			});
		} catch (error) {
			rollbackFailures += 1;
			await updateSnapshot(dependencies.prisma, snapshot, {
				...(controllerRolledBack ? { restoredAt: null } : {}),
				lastError: `Restoration rollback failed: ${errorMessage(error)}`,
			});
		}
	}
	return rollbackFailures;
}

async function prepareSnapshots(
	database: SuspensionDatabase,
	subscription: SuspensionSubscriptionRecord,
): Promise<SuspensionSnapshotRecord[]> {
	const members = await database.network_members.findMany({
		where: {
			authorized: true,
			deleted: false,
			permanentlyDeleted: false,
			nwid_ref: { authorId: subscription.userId, organizationId: null },
		},
		select: { id: true, nwid: true },
	});
	if (members.length === 0) return [];

	const existingSnapshots = await database.subscriptionSuspensionSnapshot.findMany({
		where: {
			userId: subscription.userId,
			OR: members.map((member) => ({
				networkId: member.nwid,
				memberId: member.id,
			})),
		},
	});
	const existingByMember = new Map(
		existingSnapshots.map((snapshot) => [
			memberKey(snapshot.networkId, snapshot.memberId),
			snapshot,
		]),
	);

	return Promise.all(
		members.map((member) => {
			const existing = existingByMember.get(memberKey(member.nwid, member.id));
			const startsNewCycle =
				existing?.suspendedAt !== null && existing?.suspendedAt !== undefined;
			return database.subscriptionSuspensionSnapshot.upsert({
				where: {
					userId_networkId_memberId: {
						userId: subscription.userId,
						networkId: member.nwid,
						memberId: member.id,
					},
				},
				create: {
					userId: subscription.userId,
					subscriptionId: subscription.id,
					networkId: member.nwid,
					memberId: member.id,
					wasAuthorized: true,
				},
				update: {
					subscriptionId: subscription.id,
					wasAuthorized: true,
					...(startsNewCycle
						? { suspendedAt: null, restoredAt: null, lastError: null }
						: {}),
				},
			});
		}),
	);
}

/**
 * Deauthorizes all saved personal-network members before atomically disabling
 * the account. A snapshot receives suspendedAt only after controllerUpdate
 * succeeds. The account is disabled even when a controller call fails, and
 * failed rows remain retryable through the expiration reconciler.
 */
export async function suspendExpiredSubscription(
	dependencies: SuspensionDependencies,
	subscriptionId: string,
): Promise<SuspendExpiredSubscriptionResult> {
	const now = dependencies.now?.() ?? new Date();
	const prepared = await dependencies.prisma.$transaction(async (transaction) => {
		const initial = await transaction.subscription.findUnique({
			where: { id: subscriptionId },
			select: subscriptionSelect,
		});
		if (!initial) {
			return { result: emptySuspendResult("SKIPPED_NOT_FOUND", subscriptionId, null) };
		}
		const userLockKey = `billing-user:${initial.userId}`;
		await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
		const subscription = await transaction.subscription.findUnique({
			where: { id: subscriptionId },
			select: subscriptionSelect,
		});
		if (!subscription) {
			return { result: emptySuspendResult("SKIPPED_NOT_FOUND", subscriptionId, null) };
		}
		const user = await transaction.user.findUnique({
			where: { id: subscription.userId },
			select: userSelect,
		});
		if (!user) {
			return {
				result: emptySuspendResult(
					"SKIPPED_NOT_FOUND",
					subscriptionId,
					subscription.userId,
				),
			};
		}
		if (user.role === "ADMIN") {
			return { result: emptySuspendResult("SKIPPED_ADMIN", subscriptionId, user.id) };
		}
		if (isManualSuspension(user.suspensionReason)) {
			return { result: emptySuspendResult("SKIPPED_MANUAL", subscriptionId, user.id) };
		}
		const alreadySuspended =
			!user.isActive && user.suspensionReason === SUBSCRIPTION_EXPIRED_REASON;
		if (!user.isActive && !alreadySuspended) {
			return { result: emptySuspendResult("SKIPPED_INACTIVE", subscriptionId, user.id) };
		}
		if (
			subscription.expiresAt.getTime() > now.getTime() ||
			!(["ACTIVE", "EXPIRED"] as string[]).includes(subscription.status)
		) {
			return {
				result: emptySuspendResult("SKIPPED_NOT_EXPIRED", subscriptionId, user.id),
			};
		}

		await prepareSnapshots(transaction, subscription);
		await transaction.user.update({
			where: { id: user.id },
			data: { isActive: false, suspensionReason: SUBSCRIPTION_EXPIRED_REASON },
		});
		await transaction.aPIToken.updateMany({
			where: { userId: user.id, isActive: true },
			data: { isActive: false },
		});
		await transaction.session.deleteMany({ where: { userId: user.id } });
		await transaction.subscription.update({
			where: { id: subscription.id },
			data: { status: "EXPIRED" },
		});
		return { subscription, user, alreadySuspended };
	});
	if ("result" in prepared) return prepared.result;
	const { user, alreadySuspended } = prepared;
	disconnectUserSockets(user.id);

	const unfinishedSnapshots =
		await dependencies.prisma.subscriptionSuspensionSnapshot.findMany({
			where: {
				userId: user.id,
				subscriptionId,
				wasAuthorized: true,
				suspendedAt: null,
				restoredAt: null,
			},
			orderBy: [{ networkId: "asc" }, { memberId: "asc" }],
		});
	let succeededMembers = 0;

	for (const snapshot of unfinishedSnapshots) {
		try {
			await dependencies.controllerUpdate({
				userId: user.id,
				networkId: snapshot.networkId,
				memberId: snapshot.memberId,
				authorized: false,
			});
			await updateSnapshot(dependencies.prisma, snapshot, {
				suspendedAt: now,
				lastError: null,
			});
			succeededMembers += 1;
		} catch (error) {
			await updateSnapshot(dependencies.prisma, snapshot, {
				lastError: errorMessage(error),
			});
		}
	}

	const stillUnfinished =
		await dependencies.prisma.subscriptionSuspensionSnapshot.findMany({
			where: {
				userId: user.id,
				subscriptionId,
				wasAuthorized: true,
				suspendedAt: null,
				restoredAt: null,
			},
		});
	if (stillUnfinished.length > 0) {
		return {
			state: "PARTIAL_FAILURE",
			subscriptionId,
			userId: user.id,
			snapshotIds: unfinishedSnapshots.map((snapshot) => snapshot.id),
			attemptedMembers: unfinishedSnapshots.length,
			succeededMembers,
			failedMembers: stillUnfinished.length,
		};
	}

	return {
		state: alreadySuspended ? "ALREADY_SUSPENDED" : "SUSPENDED",
		subscriptionId,
		userId: user.id,
		snapshotIds: unfinishedSnapshots.map((snapshot) => snapshot.id),
		attemptedMembers: unfinishedSnapshots.length,
		succeededMembers,
		failedMembers: 0,
	};
}

function emptyRestoreResult(
	state: RestoreResultState,
	userId: string,
): RestoreSubscriptionExpiredUserResult {
	return {
		state,
		userId,
		snapshotIds: [],
		attemptedMembers: 0,
		succeededMembers: 0,
		failedMembers: 0,
		skippedMembers: 0,
	};
}

/**
 * Explicit post-fulfilment restore. This function is intentionally not called
 * by order fulfilment: the caller decides when the paid entitlement is durable,
 * then invokes restoration. Only snapshots with a successful suspendedAt are
 * considered, and only successful controller restores receive restoredAt.
 */
export async function restoreSubscriptionExpiredUser(
	dependencies: SuspensionDependencies,
	userId: string,
): Promise<RestoreSubscriptionExpiredUserResult> {
	const now = dependencies.now?.() ?? new Date();
	const user = await dependencies.prisma.user.findUnique({
		where: { id: userId },
		select: userSelect,
	});
	if (!user) return emptyRestoreResult("SKIPPED_NOT_FOUND", userId);
	if (user.role === "ADMIN") return emptyRestoreResult("SKIPPED_ADMIN", userId);
	if (isManualSuspension(user.suspensionReason)) {
		return emptyRestoreResult("SKIPPED_MANUAL", userId);
	}
	if (user.isActive) return emptyRestoreResult("ALREADY_ACTIVE", userId);
	if (user.suspensionReason !== SUBSCRIPTION_EXPIRED_REASON) {
		return emptyRestoreResult("SKIPPED_INACTIVE", userId);
	}

	const activeSubscription = await dependencies.prisma.subscription.findFirst({
		where: {
			userId,
			status: "ACTIVE",
			startsAt: { lte: now },
			expiresAt: { gt: now },
		},
		orderBy: { expiresAt: "desc" },
		select: subscriptionSelect,
	});
	if (
		!activeSubscription ||
		activeSubscription.startsAt.getTime() > now.getTime() ||
		activeSubscription.expiresAt.getTime() <= now.getTime()
	) {
		return emptyRestoreResult("SKIPPED_NO_ACTIVE_SUBSCRIPTION", userId);
	}
	const pendingSuspensions =
		await dependencies.prisma.subscriptionSuspensionSnapshot.findMany({
			where: {
				userId,
				wasAuthorized: true,
				suspendedAt: null,
				restoredAt: null,
			},
		});
	if (pendingSuspensions.length > 0) {
		return {
			state: "PARTIAL_FAILURE",
			userId,
			snapshotIds: pendingSuspensions.map((snapshot) => snapshot.id),
			attemptedMembers: pendingSuspensions.length,
			succeededMembers: 0,
			failedMembers: pendingSuspensions.length,
			skippedMembers: 0,
		};
	}

	const snapshots = await dependencies.prisma.subscriptionSuspensionSnapshot.findMany({
		where: {
			userId,
			wasAuthorized: true,
			suspendedAt: { not: null },
			restoredAt: null,
		},
		orderBy: [{ networkId: "asc" }, { memberId: "asc" }],
	});
	const currentMembers =
		snapshots.length === 0
			? []
			: await dependencies.prisma.network_members.findMany({
					where: {
						OR: snapshots.map((snapshot) => ({
							id: snapshot.memberId,
							nwid: snapshot.networkId,
						})),
						deleted: false,
						permanentlyDeleted: false,
						nwid_ref: { authorId: userId, organizationId: null },
					},
					select: { id: true, nwid: true },
				});
	const currentMemberKeys = new Set(
		currentMembers.map((member) => memberKey(member.nwid, member.id)),
	);

	let succeededMembers = 0;
	let failedMembers = 0;
	let skippedMembers = 0;
	const restoredThisAttempt: SuspensionSnapshotRecord[] = [];
	for (const snapshot of snapshots) {
		if (!currentMemberKeys.has(memberKey(snapshot.networkId, snapshot.memberId))) {
			skippedMembers += 1;
			continue;
		}
		try {
			const currentUser = await dependencies.prisma.user.findUnique({
				where: { id: userId },
				select: userSelect,
			});
			if (
				!currentUser ||
				currentUser.role === "ADMIN" ||
				currentUser.isActive ||
				currentUser.suspensionReason !== SUBSCRIPTION_EXPIRED_REASON
			) {
				break;
			}
			await dependencies.controllerUpdate({
				userId,
				networkId: snapshot.networkId,
				memberId: snapshot.memberId,
				authorized: true,
			});
			restoredThisAttempt.push(snapshot);
			await updateSnapshot(dependencies.prisma, snapshot, {
				restoredAt: now,
				lastError: null,
			});
			succeededMembers += 1;
		} catch (error) {
			failedMembers += 1;
			await updateSnapshot(dependencies.prisma, snapshot, {
				lastError: errorMessage(error),
			});
		}
	}

	if (failedMembers > 0) {
		const rollbackFailures = await rollbackRestoredMembers(
			dependencies,
			userId,
			restoredThisAttempt,
			"Restoration rolled back because another member failed.",
		);
		return {
			state: "PARTIAL_FAILURE",
			userId,
			snapshotIds: snapshots.map((snapshot) => snapshot.id),
			attemptedMembers: snapshots.length,
			succeededMembers: rollbackFailures,
			failedMembers: failedMembers + rollbackFailures,
			skippedMembers,
		};
	}

	const activationState = await dependencies.prisma.$transaction(async (transaction) => {
		const userLockKey = `billing-user:${userId}`;
		await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
		const currentUser = await transaction.user.findUnique({
			where: { id: userId },
			select: userSelect,
		});
		if (!currentUser) return "SKIPPED_NOT_FOUND" as const;
		if (currentUser.role === "ADMIN") return "SKIPPED_ADMIN" as const;
		if (isManualSuspension(currentUser.suspensionReason)) {
			return "SKIPPED_MANUAL" as const;
		}
		if (currentUser.isActive) return "ALREADY_ACTIVE" as const;
		if (currentUser.suspensionReason !== SUBSCRIPTION_EXPIRED_REASON) {
			return "SKIPPED_INACTIVE" as const;
		}
		const currentSubscription = await transaction.subscription.findFirst({
			where: {
				userId,
				status: "ACTIVE",
				startsAt: { lte: now },
				expiresAt: { gt: now },
			},
			orderBy: { expiresAt: "desc" },
			select: subscriptionSelect,
		});
		if (!currentSubscription) return "SKIPPED_NO_ACTIVE_SUBSCRIPTION" as const;
		await transaction.user.update({
			where: { id: userId },
			data: { isActive: true, suspensionReason: "NONE" },
		});
		return "RESTORED" as const;
	});
	if (activationState !== "RESTORED") {
		if (activationState !== "ALREADY_ACTIVE") {
			const rollbackFailures = await rollbackRestoredMembers(
				dependencies,
				userId,
				restoredThisAttempt,
				`Restoration cancelled: ${activationState}`,
			);
			if (rollbackFailures > 0) {
				return {
					state: "PARTIAL_FAILURE",
					userId,
					snapshotIds: snapshots.map((snapshot) => snapshot.id),
					attemptedMembers: snapshots.length,
					succeededMembers: 0,
					failedMembers: rollbackFailures,
					skippedMembers,
				};
			}
		}
		return {
			...emptyRestoreResult(activationState, userId),
			snapshotIds: snapshots.map((snapshot) => snapshot.id),
			attemptedMembers: snapshots.length,
			succeededMembers: activationState === "ALREADY_ACTIVE" ? succeededMembers : 0,
			skippedMembers,
		};
	}

	return {
		state: "RESTORED",
		userId,
		snapshotIds: snapshots.map((snapshot) => snapshot.id),
		attemptedMembers: snapshots.length,
		succeededMembers,
		failedMembers: 0,
		skippedMembers,
	};
}

export async function reconcileExpiredSubscriptions(
	dependencies: SuspensionDependencies,
	options: { batchSize?: number } = {},
): Promise<ReconcileExpiredSubscriptionsResult> {
	const now = dependencies.now?.() ?? new Date();
	const batchSize = options.batchSize ?? 100;
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new RangeError("batchSize must be a positive integer");
	}

	const activeSubscriptions = await dependencies.prisma.subscription.findMany({
		where: { status: "ACTIVE", expiresAt: { lte: now } },
		orderBy: { expiresAt: "asc" },
		take: batchSize,
		select: { id: true },
	});
	const retrySubscriptions =
		activeSubscriptions.length >= batchSize
			? []
			: await dependencies.prisma.subscription.findMany({
					where: {
						status: "EXPIRED",
						expiresAt: { lte: now },
						suspensionSnapshots: {
							some: { wasAuthorized: true, suspendedAt: null, restoredAt: null },
						},
					},
					orderBy: { expiresAt: "asc" },
					take: batchSize - activeSubscriptions.length,
					select: { id: true },
				});
	const subscriptions = [...activeSubscriptions, ...retrySubscriptions];
	const result: ReconcileExpiredSubscriptionsResult = {
		scanned: subscriptions.length,
		suspended: 0,
		alreadySuspended: 0,
		partialFailures: 0,
		skipped: 0,
		errors: [],
	};

	for (const subscription of subscriptions) {
		try {
			const suspension = await suspendExpiredSubscription(dependencies, subscription.id);
			if (suspension.state === "SUSPENDED") result.suspended += 1;
			else if (suspension.state === "ALREADY_SUSPENDED") {
				result.alreadySuspended += 1;
			} else if (suspension.state === "PARTIAL_FAILURE") {
				result.partialFailures += 1;
			} else result.skipped += 1;
		} catch (error) {
			result.errors.push({
				subscriptionId: subscription.id,
				message: errorMessage(error),
			});
		}
	}

	return result;
}
