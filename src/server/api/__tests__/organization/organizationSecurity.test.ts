import type { NextApiResponse } from "next";
import type { PrismaClient } from "@prisma/client";
import type { Session } from "~/lib/authTypes";
import { HookType } from "~/types/webhooks";
import { organizationRouter } from "~/server/api/routers/organizationRouter";

jest.mock("~/utils/organizationNotifications", () => ({
	sendOrganizationAdminNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("~/utils/encryption", () => {
	const actual =
		jest.requireActual<typeof import("~/utils/encryption")>("~/utils/encryption");
	return {
		...actual,
		decrypt: jest.fn(() =>
			JSON.stringify({
				email: "victim@example.com",
				organizationId: "org-1",
				role: "READ_ONLY",
				invitedById: "actor",
			}),
		),
	};
});

const actorSession = {
	expires: new Date(Date.now() + 60_000).toISOString(),
	user: {
		id: "actor",
		name: "Actor",
		email: "actor@example.com",
		role: "USER",
	},
} as Session;

const activeActor = {
	id: "actor",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

const sensitiveUser = {
	id: "victim",
	name: "Victim",
	email: "victim@example.com",
	hash: "$2a$10$secret",
	tempPassword: "temporary-secret",
	twoFactorSecret: "encrypted-totp-secret",
	twoFactorRecoveryCodes: ["hashed-recovery-code"],
	failedLoginAttempts: 4,
};

function project<T extends Record<string, unknown>>(
	record: T,
	select: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(select)
			.filter(([, selected]) => selected === true)
			.map(([key]) => [key, record[key]]),
	);
}

function createResponse(): NextApiResponse {
	return {
		setHeader: jest.fn(),
	} as unknown as NextApiResponse;
}

function createCaller(prisma: PrismaClient, session: Session | null = actorSession) {
	return organizationRouter.createCaller({
		session,
		wss: null,
		prisma,
		res: createResponse(),
	});
}

describe("organization response data boundaries", () => {
	it("returns only public user fields to a READ_ONLY member from getOrgById", async () => {
		const organizationFindUnique = jest.fn(async (args) => ({
			id: "org-1",
			createdAt: new Date(),
			ownerId: "owner",
			orgName: "Example",
			description: null,
			isActive: true,
			require2FA: false,
			userRoles: [],
			users: [project(sensitiveUser, args.include.users.select)],
			webhooks: [],
			invitations: [],
			networks: [],
		}));
		const prisma = {
			user: { findUnique: jest.fn().mockResolvedValue(activeActor) },
			userOrganizationRole: {
				findFirst: jest.fn().mockResolvedValue({ role: "READ_ONLY" }),
			},
			organization: { findUnique: organizationFindUnique },
			network_members: { delete: jest.fn() },
		} as unknown as PrismaClient;

		const result = await createCaller(prisma).getOrgById({ organizationId: "org-1" });

		expect(result.users).toEqual([
			{ id: "victim", name: "Victim", email: "victim@example.com" },
		]);
		expect(result.users[0]).not.toHaveProperty("hash");
		expect(result.users[0]).not.toHaveProperty("twoFactorSecret");
		expect(organizationFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				include: expect.objectContaining({
					users: {
						select: { id: true, name: true, email: true },
					},
				}),
			}),
		);
	});

	it("does not return sensitive member fields after addUser", async () => {
		const organizationUpdate = jest.fn(async (args) => ({
			id: "org-1",
			users: [project(sensitiveUser, args.include.users.select)],
		}));
		const userFindUnique = jest.fn(async (args) =>
			args.where.id === "actor" ? activeActor : { email: sensitiveUser.email },
		);
		const prisma = {
			user: { findUnique: userFindUnique },
			userOrganizationRole: {
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({ role: "ADMIN" })
					.mockResolvedValueOnce(null),
			},
			organization: { update: organizationUpdate },
			activityLog: { create: jest.fn().mockResolvedValue({}) },
		} as unknown as PrismaClient;

		const result = await createCaller(prisma).addUser({
			organizationId: "org-1",
			userId: "victim",
			userName: "Victim",
			organizationRole: "READ_ONLY",
		});

		expect(result.users).toEqual([
			{ id: "victim", name: "Victim", email: "victim@example.com" },
		]);
		expect(result.users[0]).not.toHaveProperty("hash");
		expect(organizationUpdate.mock.calls[0][0].include.users.select).toEqual({
			id: true,
			name: true,
			email: true,
		});
	});

	it("returns no user row from the public existing-user invitation flow", async () => {
		const userFindFirst = jest.fn(async (args) => project(sensitiveUser, args.select));
		const organizationUpdate = jest.fn().mockResolvedValue({});
		const prisma = {
			invitation: {
				findFirst: jest.fn().mockResolvedValue({
					token: "valid-token",
					expiresAt: new Date(Date.now() + 60_000),
				}),
				deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
			},
			user: { findFirst: userFindFirst },
			userOrganizationRole: { findFirst: jest.fn().mockResolvedValue(null) },
			organization: { update: organizationUpdate },
			activityLog: { create: jest.fn().mockResolvedValue({}) },
		} as unknown as PrismaClient;

		const result = await createCaller(prisma, null).preValidateUserInvite({
			token: "valid-token",
		});

		expect(result).toEqual({ organizationId: "org-1" });
		expect(result).not.toHaveProperty("user");
		expect(userFindFirst.mock.calls[0][0].select).toEqual({ id: true, name: true });
		expect(organizationUpdate.mock.calls[0][0]).not.toHaveProperty("include");
	});

	it("uses the same safe user projection in getAllOrg", async () => {
		const organizationFindMany = jest.fn(async (args) => [
			{
				id: "org-1",
				orgName: "Example",
				users: [project(sensitiveUser, args.include.users.select)],
				userRoles: [],
				webhooks: [],
				invitations: [],
			},
		]);
		const prisma = {
			user: {
				findUnique: jest.fn().mockResolvedValue({ ...activeActor, role: "ADMIN" }),
			},
			organization: { findMany: organizationFindMany },
		} as unknown as PrismaClient;
		const session = {
			...actorSession,
			user: { ...actorSession.user, role: "ADMIN" },
		} as Session;

		const result = await createCaller(prisma, session).getAllOrg();

		expect(result[0].users[0]).toEqual({
			id: "victim",
			name: "Victim",
			email: "victim@example.com",
		});
		expect(result[0].users[0]).not.toHaveProperty("hash");
	});
});

describe("organization webhook ownership", () => {
	function createWebhookPrisma(updateCount: number) {
		return {
			user: { findUnique: jest.fn().mockResolvedValue(activeActor) },
			userOrganizationRole: {
				findFirst: jest.fn().mockResolvedValue({ role: "ADMIN" }),
			},
			webhook: {
				create: jest.fn().mockResolvedValue({ id: "created" }),
				updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
				findFirst: jest.fn().mockResolvedValue({ id: "owned-hook" }),
			},
		} as unknown as PrismaClient;
	}

	it("does not update a webhook outside the authorized organization", async () => {
		const prisma = createWebhookPrisma(0);

		await expect(
			createCaller(prisma).addOrgWebhooks({
				organizationId: "attacker-org",
				webhookId: "victim-hook",
				webhookUrl: "https://8.8.8.8/hook",
				webhookName: "Hijacked",
				hookType: [HookType.NETWORK_CREATED],
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(prisma.webhook.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "victim-hook", organizationId: "attacker-org" },
			}),
		);
		expect(prisma.webhook.findFirst).not.toHaveBeenCalled();
	});

	it("rejects webhook writes from a non-admin organization member", async () => {
		const prisma = createWebhookPrisma(1);
		prisma.userOrganizationRole.findFirst = jest
			.fn()
			.mockResolvedValue({ role: "READ_ONLY" });

		await expect(
			createCaller(prisma).addOrgWebhooks({
				organizationId: "org-1",
				webhookId: "owned-hook",
				webhookUrl: "https://8.8.8.8/hook",
				webhookName: "Denied",
				hookType: [HookType.NETWORK_CREATED],
			}),
		).rejects.toThrow("required permission");

		expect(prisma.webhook.updateMany).not.toHaveBeenCalled();
		expect(prisma.webhook.create).not.toHaveBeenCalled();
	});

	it("creates new webhooks enabled so existing creation behavior is preserved", async () => {
		const prisma = createWebhookPrisma(0);

		await createCaller(prisma).addOrgWebhooks({
			organizationId: "org-1",
			webhookUrl: "https://8.8.8.8/hook",
			webhookName: "Builds",
			hookType: [HookType.NETWORK_CREATED],
		});

		expect(prisma.webhook.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					enabled: true,
					organizationId: "org-1",
				}),
			}),
		);
	});
});
