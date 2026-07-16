import { describe, expect, jest, test } from "@jest/globals";
import {
	reconcileExpiredSubscriptions,
	restoreSubscriptionExpiredUser,
	suspendExpiredSubscription,
	type ControllerUpdateInput,
	type PersonalNetworkMemberRecord,
	type SuspensionDatabase,
	type SuspensionPrisma,
	type SuspensionSnapshotRecord,
	type SuspensionSubscriptionRecord,
	type SuspensionUserRecord,
} from "~/server/billing/suspension";

const NOW = new Date("2026-07-14T08:00:00.000Z");

interface TestMember extends PersonalNetworkMemberRecord {
	authorized: boolean;
	deleted: boolean;
	permanentlyDeleted: boolean;
	authorId: string;
	organizationId: string | null;
}

interface TestToken {
	id: string;
	userId: string;
	isActive: boolean;
	expiresAt: Date | null;
}

function defaultUser(
	overrides: Partial<SuspensionUserRecord> = {},
): SuspensionUserRecord {
	return {
		id: "user-1",
		role: "USER",
		isActive: true,
		suspensionReason: "NONE",
		...overrides,
	};
}

function expiredSubscription(
	overrides: Partial<SuspensionSubscriptionRecord> = {},
): SuspensionSubscriptionRecord {
	return {
		id: "subscription-1",
		userId: "user-1",
		status: "ACTIVE",
		startsAt: new Date("2026-06-01T00:00:00.000Z"),
		expiresAt: new Date("2026-07-14T07:00:00.000Z"),
		...overrides,
	};
}

function member(id: string, overrides: Partial<TestMember> = {}): TestMember {
	return {
		id,
		nwid: "network-1",
		authorized: true,
		deleted: false,
		permanentlyDeleted: false,
		authorId: "user-1",
		organizationId: null,
		...overrides,
	};
}

function snapshot(
	id: string,
	overrides: Partial<SuspensionSnapshotRecord> = {},
): SuspensionSnapshotRecord {
	return {
		id,
		userId: "user-1",
		subscriptionId: "subscription-1",
		networkId: "network-1",
		memberId: `member-${id}`,
		wasAuthorized: true,
		suspendedAt: NOW,
		restoredAt: null,
		lastError: null,
		createdAt: new Date("2026-07-14T07:30:00.000Z"),
		...overrides,
	};
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
	return value && typeof value === "object"
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

function setup(
	input: {
		users?: SuspensionUserRecord[];
		subscriptions?: SuspensionSubscriptionRecord[];
		members?: TestMember[];
		snapshots?: SuspensionSnapshotRecord[];
		tokens?: TestToken[];
		sessions?: string[];
		failControllerKeys?: Set<string>;
	} = {},
) {
	const users = input.users ?? [defaultUser()];
	const subscriptions = input.subscriptions ?? [expiredSubscription()];
	const members = input.members ?? [member("member-1")];
	const snapshots = input.snapshots ?? [];
	const tokens = input.tokens ?? [
		{ id: "token-1", userId: "user-1", isActive: true, expiresAt: null },
	];
	const sessions = input.sessions ?? ["user-1"];
	const failControllerKeys = input.failControllerKeys ?? new Set<string>();
	let snapshotSequence = snapshots.length;

	const userFindUnique = jest.fn(
		async (args: { where: { id: string } }) =>
			users.find((candidate) => candidate.id === args.where.id) ?? null,
	);
	const userUpdate = jest.fn(
		async (args: {
			where: { id: string };
			data: { isActive: boolean; suspensionReason: string };
		}) => {
			const found = users.find((candidate) => candidate.id === args.where.id);
			if (!found) throw new Error("user not found");
			Object.assign(found, args.data);
			return found;
		},
	);

	const subscriptionFindUnique = jest.fn(
		async (args: { where: { id: string } }) =>
			subscriptions.find((candidate) => candidate.id === args.where.id) ?? null,
	);
	const subscriptionFindFirst = jest.fn(
		async (args: { where: Readonly<Record<string, unknown>> }) => {
			const startsAt = objectValue(args.where.startsAt);
			const expiresAt = objectValue(args.where.expiresAt);
			return (
				subscriptions.find(
					(candidate) =>
						candidate.userId === args.where.userId &&
						candidate.status === args.where.status &&
						(!startsAt?.lte ||
							candidate.startsAt.getTime() <= (startsAt.lte as Date).getTime()) &&
						(!expiresAt?.gt ||
							candidate.expiresAt.getTime() > (expiresAt.gt as Date).getTime()),
				) ?? null
			);
		},
	);
	const subscriptionFindMany = jest.fn(
		async (args: {
			where: Readonly<Record<string, unknown>>;
			take: number;
		}) => {
			const expiresAt = objectValue(args.where.expiresAt);
			return subscriptions
				.filter(
					(candidate) =>
						candidate.status === args.where.status &&
						(!expiresAt?.lte ||
							candidate.expiresAt.getTime() <= (expiresAt.lte as Date).getTime()),
				)
				.slice(0, args.take)
				.map((candidate) => ({ id: candidate.id }));
		},
	);
	const subscriptionUpdate = jest.fn(
		async (args: { where: { id: string }; data: { status: "EXPIRED" } }) => {
			const found = subscriptions.find((candidate) => candidate.id === args.where.id);
			if (!found) throw new Error("subscription not found");
			found.status = args.data.status;
			return found;
		},
	);

	const networkMembersFindMany = jest.fn(
		async (args: { where: Readonly<Record<string, unknown>> }) => {
			const networkFilter = objectValue(args.where.nwid_ref);
			const requestedMembers = Array.isArray(args.where.OR)
				? (args.where.OR as Array<Readonly<Record<string, unknown>>>)
				: null;
			return members
				.filter((candidate) => {
					if (
						typeof args.where.authorized === "boolean" &&
						candidate.authorized !== args.where.authorized
					) {
						return false;
					}
					if (
						typeof args.where.deleted === "boolean" &&
						candidate.deleted !== args.where.deleted
					) {
						return false;
					}
					if (
						typeof args.where.permanentlyDeleted === "boolean" &&
						candidate.permanentlyDeleted !== args.where.permanentlyDeleted
					) {
						return false;
					}
					if (networkFilter?.authorId && candidate.authorId !== networkFilter.authorId) {
						return false;
					}
					if (
						networkFilter &&
						"organizationId" in networkFilter &&
						candidate.organizationId !== networkFilter.organizationId
					) {
						return false;
					}
					if (
						requestedMembers &&
						!requestedMembers.some(
							(requested) =>
								requested.id === candidate.id && requested.nwid === candidate.nwid,
						)
					) {
						return false;
					}
					return true;
				})
				.map((candidate) => ({ id: candidate.id, nwid: candidate.nwid }));
		},
	);

	const snapshotsFindMany = jest.fn(
		async (args: { where: Readonly<Record<string, unknown>> }) => {
			const requestedMembers = Array.isArray(args.where.OR)
				? (args.where.OR as Array<Readonly<Record<string, unknown>>>)
				: null;
			const suspendedAt = objectValue(args.where.suspendedAt);
			return snapshots.filter((candidate) => {
				if (args.where.userId && candidate.userId !== args.where.userId) return false;
				if (
					args.where.subscriptionId &&
					candidate.subscriptionId !== args.where.subscriptionId
				) {
					return false;
				}
				if (
					typeof args.where.wasAuthorized === "boolean" &&
					candidate.wasAuthorized !== args.where.wasAuthorized
				) {
					return false;
				}
				if (args.where.suspendedAt === null && candidate.suspendedAt !== null) {
					return false;
				}
				if (suspendedAt && "not" in suspendedAt && candidate.suspendedAt === null) {
					return false;
				}
				if (args.where.restoredAt === null && candidate.restoredAt !== null) {
					return false;
				}
				if (
					requestedMembers &&
					!requestedMembers.some(
						(requested) =>
							requested.networkId === candidate.networkId &&
							requested.memberId === candidate.memberId,
					)
				) {
					return false;
				}
				return true;
			});
		},
	);
	const snapshotUpsert = jest.fn(
		async (args: {
			where: {
				userId_networkId_memberId: {
					userId: string;
					networkId: string;
					memberId: string;
				};
			};
			create: Omit<
				SuspensionSnapshotRecord,
				"id" | "suspendedAt" | "restoredAt" | "lastError" | "createdAt"
			>;
			update: Readonly<Record<string, unknown>>;
		}) => {
			const key = args.where.userId_networkId_memberId;
			const existing = snapshots.find(
				(candidate) =>
					candidate.userId === key.userId &&
					candidate.networkId === key.networkId &&
					candidate.memberId === key.memberId,
			);
			if (existing) {
				Object.assign(existing, args.update);
				return existing;
			}
			snapshotSequence += 1;
			const created: SuspensionSnapshotRecord = {
				...args.create,
				id: `snapshot-${snapshotSequence}`,
				suspendedAt: null,
				restoredAt: null,
				lastError: null,
				createdAt: NOW,
			};
			snapshots.push(created);
			return created;
		},
	);
	const snapshotUpdate = jest.fn(
		async (args: {
			where: { id: string };
			data: Readonly<Record<string, unknown>>;
		}) => {
			const found = snapshots.find((candidate) => candidate.id === args.where.id);
			if (!found) throw new Error("snapshot not found");
			Object.assign(found, args.data);
			return found;
		},
	);

	const apiTokenUpdateMany = jest.fn(
		async (args: {
			where: Readonly<Record<string, unknown>>;
			data: { isActive: boolean };
		}) => {
			let count = 0;
			for (const token of tokens) {
				if (token.userId !== args.where.userId) continue;
				if (
					typeof args.where.isActive === "boolean" &&
					token.isActive !== args.where.isActive
				) {
					continue;
				}
				token.isActive = args.data.isActive;
				count += 1;
			}
			return { count };
		},
	);
	const sessionDeleteMany = jest.fn(async (args: { where: { userId: string } }) => {
		let count = 0;
		for (let index = sessions.length - 1; index >= 0; index -= 1) {
			if (sessions[index] === args.where.userId) {
				sessions.splice(index, 1);
				count += 1;
			}
		}
		return { count };
	});

	const executeRaw = jest.fn(async () => 1);
	const database = {
		$executeRaw: executeRaw,
		user: { findUnique: userFindUnique, update: userUpdate },
		subscription: {
			findUnique: subscriptionFindUnique,
			findFirst: subscriptionFindFirst,
			findMany: subscriptionFindMany,
			update: subscriptionUpdate,
		},
		aPIToken: { updateMany: apiTokenUpdateMany },
		session: { deleteMany: sessionDeleteMany },
		network_members: { findMany: networkMembersFindMany },
		subscriptionSuspensionSnapshot: {
			findMany: snapshotsFindMany,
			upsert: snapshotUpsert,
			update: snapshotUpdate,
		},
	} as unknown as SuspensionDatabase;
	const transaction = async <T>(
		operation: (transactionDatabase: SuspensionDatabase) => Promise<T>,
	) => operation(database);
	const prisma = { ...database, $transaction: transaction } as SuspensionPrisma;
	const controllerUpdate = jest.fn(async (update: ControllerUpdateInput) => {
		const key = memberKey(update.networkId, update.memberId);
		if (failControllerKeys.has(key)) throw new Error(`controller failed: ${key}`);
		const found = members.find(
			(candidate) =>
				candidate.nwid === update.networkId && candidate.id === update.memberId,
		);
		if (found) found.authorized = update.authorized;
	});

	return {
		dependencies: { prisma, controllerUpdate, now: () => NOW },
		state: { users, subscriptions, members, snapshots, tokens, sessions },
		mocks: {
			executeRaw,
			controllerUpdate,
			userUpdate,
			subscriptionUpdate,
			apiTokenUpdateMany,
			sessionDeleteMany,
			networkMembersFindMany,
			subscriptionFindMany,
		},
		failControllerKeys,
	};
}

function memberKey(networkId: string, memberId: string): string {
	return `${networkId}:${memberId}`;
}

describe("subscription suspension", () => {
	test("ADMIN is never suspended", async () => {
		const harness = setup({ users: [defaultUser({ role: "ADMIN" })] });

		const result = await suspendExpiredSubscription(
			harness.dependencies,
			"subscription-1",
		);

		expect(result.state).toBe("SKIPPED_ADMIN");
		expect(harness.mocks.controllerUpdate).not.toHaveBeenCalled();
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
	});

	test("snapshots only authorized, non-deleted members in personal networks", async () => {
		const harness = setup({
			members: [
				member("eligible"),
				member("unauthorized", { authorized: false }),
				member("deleted", { deleted: true }),
				member("organization", { organizationId: "org-1" }),
			],
		});

		const result = await suspendExpiredSubscription(
			harness.dependencies,
			"subscription-1",
		);

		expect(result.state).toBe("SUSPENDED");
		expect(harness.state.snapshots).toHaveLength(1);
		expect(harness.state.snapshots[0]).toMatchObject({
			memberId: "eligible",
			wasAuthorized: true,
			suspendedAt: NOW,
		});
		expect(harness.state.members).toHaveLength(4);
	});

	test("a partial controller failure disables access immediately and stays retryable", async () => {
		const failedKey = memberKey("network-1", "member-2");
		const harness = setup({
			members: [member("member-1"), member("member-2")],
			failControllerKeys: new Set([failedKey]),
		});

		const first = await suspendExpiredSubscription(
			harness.dependencies,
			"subscription-1",
		);

		expect(first).toMatchObject({
			state: "PARTIAL_FAILURE",
			succeededMembers: 1,
			failedMembers: 1,
		});
		expect(harness.state.users[0]).toMatchObject({
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		});
		expect(harness.state.tokens[0]?.isActive).toBe(false);
		expect(harness.state.sessions).toHaveLength(0);

		harness.failControllerKeys.clear();
		const second = await suspendExpiredSubscription(
			harness.dependencies,
			"subscription-1",
		);

		expect(second).toMatchObject({
			state: "ALREADY_SUSPENDED",
			attemptedMembers: 1,
			succeededMembers: 1,
		});
		const calls = harness.mocks.controllerUpdate.mock.calls.map(
			(call) => call[0] as ControllerUpdateInput,
		);
		expect(calls.filter((call) => call.memberId === "member-1")).toHaveLength(1);
		expect(calls.filter((call) => call.memberId === "member-2")).toHaveLength(2);
		expect(harness.state.users[0]).toMatchObject({
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		});
		expect(harness.state.tokens[0]?.isActive).toBe(false);
		expect(harness.state.sessions).toHaveLength(0);
	});

	test("repeated suspension is idempotent and preserves service data", async () => {
		const harness = setup({ members: [member("member-1"), member("member-2")] });
		await suspendExpiredSubscription(harness.dependencies, "subscription-1");
		const callCount = harness.mocks.controllerUpdate.mock.calls.length;

		const repeated = await suspendExpiredSubscription(
			harness.dependencies,
			"subscription-1",
		);

		expect(repeated.state).toBe("ALREADY_SUSPENDED");
		expect(harness.mocks.controllerUpdate).toHaveBeenCalledTimes(callCount);
		expect(harness.state.members).toHaveLength(2);
		expect(harness.state.snapshots).toHaveLength(2);
	});
});

describe("subscription-expiry restoration", () => {
	test.each([
		["ADMIN", "NONE", "SKIPPED_ADMIN"],
		["USER", "MANUAL", "SKIPPED_MANUAL"],
		["USER", "ADMIN", "SKIPPED_MANUAL"],
	])("never restores role %s with reason %s", async (role, reason, expectedState) => {
		const harness = setup({
			users: [defaultUser({ role, isActive: false, suspensionReason: reason })],
			subscriptions: [
				expiredSubscription({
					status: "ACTIVE",
					expiresAt: new Date("2026-08-14T08:00:00.000Z"),
				}),
			],
		});

		const result = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");

		expect(result.state).toBe(expectedState);
		expect(harness.mocks.controllerUpdate).not.toHaveBeenCalled();
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
	});

	test("does not reactivate while any suspension snapshot is still pending", async () => {
		const harness = setup({
			users: [defaultUser({ isActive: false, suspensionReason: "SUBSCRIPTION_EXPIRED" })],
			subscriptions: [
				expiredSubscription({
					status: "ACTIVE",
					expiresAt: new Date("2026-08-14T08:00:00.000Z"),
				}),
			],
			members: [
				member("successful", { authorized: false }),
				member("failed", { authorized: false }),
			],
			snapshots: [
				snapshot("successful", { memberId: "successful", suspendedAt: NOW }),
				snapshot("failed", { memberId: "failed", suspendedAt: null }),
			],
			tokens: [{ id: "token-1", userId: "user-1", isActive: false, expiresAt: null }],
		});

		const result = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");

		expect(result).toMatchObject({
			state: "PARTIAL_FAILURE",
			succeededMembers: 0,
			failedMembers: 1,
		});
		expect(harness.mocks.controllerUpdate).not.toHaveBeenCalled();
		expect(harness.state.snapshots.find((item) => item.id === "failed")?.restoredAt).toBe(
			null,
		);
		expect(harness.state.users[0]).toMatchObject({
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		});
		expect(harness.state.tokens[0]?.isActive).toBe(false);
	});

	test("partial restore rolls back earlier members and retries the full set", async () => {
		const failedKey = memberKey("network-1", "member-2");
		const harness = setup({
			users: [defaultUser({ isActive: false, suspensionReason: "SUBSCRIPTION_EXPIRED" })],
			subscriptions: [
				expiredSubscription({
					status: "ACTIVE",
					expiresAt: new Date("2026-08-14T08:00:00.000Z"),
				}),
			],
			members: [
				member("member-1", { authorized: false }),
				member("member-2", { authorized: false }),
			],
			snapshots: [
				snapshot("one", { memberId: "member-1" }),
				snapshot("two", { memberId: "member-2" }),
			],
			failControllerKeys: new Set([failedKey]),
		});

		const first = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");
		expect(first).toMatchObject({
			state: "PARTIAL_FAILURE",
			succeededMembers: 0,
			failedMembers: 1,
		});
		expect(harness.state.users[0]?.isActive).toBe(false);
		expect(harness.state.members).toEqual([
			expect.objectContaining({ id: "member-1", authorized: false }),
			expect.objectContaining({ id: "member-2", authorized: false }),
		]);
		expect(harness.state.snapshots[0]).toMatchObject({
			restoredAt: null,
			lastError: "Restoration rolled back because another member failed.",
		});

		harness.failControllerKeys.clear();
		const second = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");

		expect(second).toMatchObject({
			state: "RESTORED",
			attemptedMembers: 2,
			succeededMembers: 2,
		});
		const calls = harness.mocks.controllerUpdate.mock.calls.map(
			(call) => call[0] as ControllerUpdateInput,
		);
		expect(calls.filter((call) => call.memberId === "member-1")).toHaveLength(3);
		expect(calls.filter((call) => call.memberId === "member-2")).toHaveLength(2);
		expect(harness.state.users[0]?.isActive).toBe(true);
	});

	test("does not restore before an active renewed Subscription exists", async () => {
		const harness = setup({
			users: [defaultUser({ isActive: false, suspensionReason: "SUBSCRIPTION_EXPIRED" })],
		});

		const result = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");

		expect(result.state).toBe("SKIPPED_NO_ACTIVE_SUBSCRIPTION");
		expect(harness.mocks.userUpdate).not.toHaveBeenCalled();
	});

	test("rolls back member restoration if an administrator suspends the user concurrently", async () => {
		const harness = setup({
			users: [defaultUser({ isActive: false, suspensionReason: "SUBSCRIPTION_EXPIRED" })],
			subscriptions: [
				expiredSubscription({
					status: "ACTIVE",
					expiresAt: new Date("2026-08-14T08:00:00.000Z"),
				}),
			],
			members: [
				member("member-1", { authorized: false }),
				member("member-2", { authorized: false }),
			],
			snapshots: [
				snapshot("one", { memberId: "member-1" }),
				snapshot("two", { memberId: "member-2" }),
			],
		});
		let administratorSuspended = false;
		harness.mocks.controllerUpdate.mockImplementation(
			async (update: ControllerUpdateInput) => {
				const currentMember = harness.state.members.find(
					(candidate) =>
						candidate.nwid === update.networkId && candidate.id === update.memberId,
				);
				if (currentMember) currentMember.authorized = update.authorized;
				if (update.authorized && !administratorSuspended) {
					administratorSuspended = true;
					Object.assign(harness.state.users[0], {
						isActive: false,
						suspensionReason: "ADMIN",
					});
				}
			},
		);

		const result = await restoreSubscriptionExpiredUser(harness.dependencies, "user-1");

		expect(result).toMatchObject({
			state: "SKIPPED_MANUAL",
			succeededMembers: 0,
			failedMembers: 0,
		});
		expect(harness.state.users[0]).toMatchObject({
			isActive: false,
			suspensionReason: "ADMIN",
		});
		expect(harness.state.members).toEqual([
			expect.objectContaining({ id: "member-1", authorized: false }),
			expect.objectContaining({ id: "member-2", authorized: false }),
		]);
		expect(harness.state.snapshots[0]).toMatchObject({
			restoredAt: null,
			lastError: "Restoration cancelled: SKIPPED_MANUAL",
		});
		const authorizationCalls = harness.mocks.controllerUpdate.mock.calls.map(
			(call) => (call[0] as ControllerUpdateInput).authorized,
		);
		expect(authorizationCalls).toEqual([true, false]);
	});
});

test("reconcileExpiredSubscriptions processes an expired batch independently", async () => {
	const harness = setup({
		users: [defaultUser(), defaultUser({ id: "user-2" })],
		subscriptions: [
			expiredSubscription(),
			expiredSubscription({ id: "subscription-2", userId: "user-2" }),
		],
		members: [member("member-1")],
	});

	const result = await reconcileExpiredSubscriptions(harness.dependencies, {
		batchSize: 20,
	});

	expect(result).toMatchObject({
		scanned: 2,
		suspended: 2,
		partialFailures: 0,
		skipped: 0,
	});
	expect(harness.mocks.subscriptionFindMany).toHaveBeenCalledWith(
		expect.objectContaining({ take: 20 }),
	);
});
