/**
 * Pins down the contract that any password write goes to BOTH `User.hash` AND
 * `Account.password`. Pre-fix, the tRPC mutations updated only `User.hash`, and
 * the next sign-in would fail because better-auth verifies against `Account.password`.
 *
 * These tests exercise the tRPC `auth` router via `appRouter.createCaller` —
 * the same surface the frontend uses — so any future mutation that forgets to
 * call `upsertCredentialAccount` will fail here.
 */
import { test, expect, describe, beforeEach } from "@jest/globals";

// Spy on the credential-account service so we can assert it was called.
jest.mock("~/server/api/services/credentialAccountService", () => ({
	upsertCredentialAccount: jest.fn(),
}));

// rate-limit dep imports a real fs module; just stub it.
jest.mock("~/utils/rateLimit", () => () => ({
	check: jest.fn().mockResolvedValue(true),
}));

jest.mock("~/utils/mail", () => ({
	sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("~/utils/encryption", () => ({
	encrypt: jest.fn(() => "encrypted"),
	generateInstanceSecret: jest.fn(() => "secret"),
	hashApiToken: jest.fn((value: string) => `digest:${value}`),
	API_TOKEN_SECRET: "API_TOKEN_SECRET",
	PASSWORD_RESET_SECRET: "PASSWORD_RESET_SECRET",
	VERIFY_EMAIL_SECRET: "VERIFY_EMAIL_SECRET",
	TOTP_MFA_TOKEN_SECRET: "TOTP_MFA_TOKEN_SECRET",
}));

// Don't read /var/lib/zerotier-one/authtoken.secret at module load.
jest.mock("~/utils/ztApi", () => ({
	ping_api: jest.fn(),
}));

import { appRouter } from "../../root";
import type { Session } from "~/lib/authTypes";
import { PrismaClient, Role } from "@prisma/client";
import { type PartialDeep } from "type-fest";
import { upsertCredentialAccount } from "~/server/api/services/credentialAccountService";
import { sendMailWithTemplate } from "~/utils/mail";
import bcrypt from "bcryptjs";

const mockedUpsert = upsertCredentialAccount as jest.MockedFunction<
	typeof upsertCredentialAccount
>;
const mockedSendMail = sendMailWithTemplate as jest.MockedFunction<
	typeof sendMailWithTemplate
>;

const session: PartialDeep<Session> = {
	expires: new Date().toISOString(),
	user: {
		id: "user_1",
		name: "Test User",
		email: "test@example.com",
	},
};

function makePrismaMock(user: Record<string, unknown>): PrismaClient {
	const prismaMock = new PrismaClient();
	const currentUser = {
		id: "user_1",
		role: Role.USER,
		isActive: true,
		suspensionReason: "NONE",
		expiresAt: null,
		...user,
	};
	prismaMock.user.findFirst = jest.fn().mockResolvedValue(currentUser) as never;
	prismaMock.user.findUnique = jest.fn().mockResolvedValue(currentUser) as never;
	prismaMock.user.update = jest.fn().mockResolvedValue(currentUser) as never;
	prismaMock.user.count = jest.fn().mockResolvedValue(1) as never;
	prismaMock.user.create = jest
		.fn()
		.mockResolvedValue({ id: "user_2", name: "x", email: "y" }) as never;
	prismaMock.userGroup.findFirst = jest.fn().mockResolvedValue(null) as never;
	prismaMock.globalOptions.findFirst = jest.fn().mockResolvedValue({
		enableRegistration: true,
		userRegistrationNotification: false,
	}) as never;
	prismaMock.invitation.findUnique = jest.fn() as never;
	prismaMock.invitation.update = jest.fn() as never;
	prismaMock.invitation.delete = jest.fn() as never;
	prismaMock.activityLog.create = jest.fn() as never;
	prismaMock.session.deleteMany = jest.fn().mockResolvedValue({ count: 1 }) as never;
	prismaMock.aPIToken.create = jest.fn() as never;
	prismaMock.aPIToken.update = jest.fn() as never;
	prismaMock.aPIToken.updateMany = jest.fn().mockResolvedValue({ count: 1 }) as never;
	prismaMock.aPIToken.delete = jest.fn() as never;
	prismaMock.$executeRaw = jest.fn().mockResolvedValue(0) as never;
	prismaMock.$transaction = jest.fn(async (callback) => callback(prismaMock)) as never;
	return prismaMock;
}

describe("auth router password mutations sync Account.password", () => {
	beforeEach(() => {
		mockedUpsert.mockReset();
		mockedUpsert.mockResolvedValue(undefined);
		mockedSendMail.mockResolvedValue(undefined);
	});

	test("password reset requests do not reveal whether the email exists", async () => {
		const missingPrisma = makePrismaMock({}) as PrismaClient;
		missingPrisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
		const existingPrisma = makePrismaMock({
			email: "test@example.com",
			hash: bcrypt.hashSync("OldPass123!", 10),
		}) as PrismaClient;

		const context = (prisma: PrismaClient) => ({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});
		const missing = await appRouter
			.createCaller(context(missingPrisma))
			.auth.passwordResetLink({ email: "test@example.com" });
		const existing = await appRouter
			.createCaller(context(existingPrisma))
			.auth.passwordResetLink({ email: "test@example.com" });

		expect(existing).toEqual(missing);
		expect(existing).toEqual({
			message: "If the email exists, a reset link has been sent.",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockedSendMail).toHaveBeenCalledTimes(1);
	});

	test("MFA reset requests do not reveal whether the email exists", async () => {
		const missingPrisma = makePrismaMock({}) as PrismaClient;
		missingPrisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
		const existingPrisma = makePrismaMock({ email: "test@example.com" }) as PrismaClient;
		const context = (prisma: PrismaClient) => ({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		const missing = await appRouter
			.createCaller(context(missingPrisma))
			.mfaAuth.mfaResetLink({ email: "test@example.com" });
		const existing = await appRouter
			.createCaller(context(existingPrisma))
			.mfaAuth.mfaResetLink({ email: "test@example.com" });

		expect(existing).toEqual(missing);
		expect(existing).toEqual({
			message: "If the email exists, a reset link has been sent.",
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockedSendMail).toHaveBeenCalledTimes(1);
	});

	test("password and MFA reset responses do not wait for SMTP", async () => {
		const prisma = makePrismaMock({
			email: "test@example.com",
			hash: bcrypt.hashSync("OldPass123!", 10),
		});
		let releaseMail = () => {};
		mockedSendMail.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releaseMail = resolve;
				}),
		);
		const caller = appRouter.createCaller({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});
		const timeout = () =>
			new Promise<"blocked">((resolve) => setImmediate(() => resolve("blocked")));

		const passwordResult = await Promise.race([
			caller.auth.passwordResetLink({ email: "test@example.com" }),
			timeout(),
		]);
		expect(passwordResult).not.toBe("blocked");
		releaseMail();

		const mfaResult = await Promise.race([
			caller.mfaAuth.mfaResetLink({ email: "test@example.com" }),
			timeout(),
		]);
		expect(mfaResult).not.toBe("blocked");
		releaseMail();
	});

	test("API token deletion returns no stored bearer material", async () => {
		const prisma = makePrismaMock({ email: "test@example.com" });
		(prisma.aPIToken.delete as jest.Mock).mockResolvedValue({
			id: "token-1",
			token: "legacy-usable-bearer-token",
		});
		const caller = appRouter.createCaller({
			session: session as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await expect(caller.auth.deleteApiToken({ id: "token-1" })).resolves.toEqual({
			status: "success",
		});
		expect(prisma.aPIToken.delete).toHaveBeenCalledWith({
			where: { id: "token-1", userId: "user_1" },
			select: { id: true },
		});
	});

	test("auth.update writes the new hash to Account.password", async () => {
		const oldHash = bcrypt.hashSync("OldPass123!", 10);
		const prisma = makePrismaMock({
			id: "user_1",
			email: "test@example.com",
			name: "Test",
			hash: oldHash,
			accounts: [],
			requestChangePassword: false,
		});

		const caller = appRouter.createCaller({
			session: session as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await caller.auth.update({
			password: "OldPass123!",
			newPassword: "NewPass123!",
			repeatNewPassword: "NewPass123!",
		});

		expect(upsertCredentialAccount).toHaveBeenCalledTimes(1);
		const [userId, hashArg] = mockedUpsert.mock.calls[0];
		expect(userId).toBe("user_1");
		expect(typeof hashArg).toBe("string");
		// Confirm the synced hash actually validates the new password.
		expect(bcrypt.compareSync("NewPass123!", hashArg as string)).toBe(true);
	});

	test("auth.changePasswordFromJwt writes the new hash to Account.password", async () => {
		// Build a valid token signed by the same secret the router will verify with.
		const jwt = await import("jsonwebtoken");
		const oldHash = bcrypt.hashSync("OldPass123!", 10);
		const { createHash } = await import("node:crypto");
		const token = jwt.sign(
			{
				id: "user_1",
				email: "test@example.com",
				passwordFingerprint: createHash("sha256").update(oldHash).digest("hex"),
			},
			"secret",
		);
		const prisma = makePrismaMock({
			id: "user_1",
			email: "test@example.com",
			name: "Test",
			hash: oldHash,
		});

		const caller = appRouter.createCaller({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await caller.auth.changePasswordFromJwt({
			token,
			password: "NewPass123!",
			newPassword: "NewPass123!",
		});

		expect(upsertCredentialAccount).toHaveBeenCalledTimes(1);
		const [userId, hashArg] = mockedUpsert.mock.calls[0];
		expect(userId).toBe("user_1");
		expect(bcrypt.compareSync("NewPass123!", hashArg as string)).toBe(true);
		expect(prisma.session.deleteMany).toHaveBeenCalledWith({
			where: { userId: "user_1" },
		});
		expect(prisma.aPIToken.updateMany).toHaveBeenCalledWith({
			where: { userId: "user_1", isActive: true },
			data: { isActive: false },
		});
	});

	test("auth.register writes the credential Account row for the new user", async () => {
		const prisma = makePrismaMock({}) as PrismaClient;
		// register() looks up the user first and must return null.
		prisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
		prisma.user.create = jest.fn().mockResolvedValue({
			id: "user_new",
			name: "New",
			email: "new@example.com",
			expiresAt: null,
			role: "USER",
			memberOfOrgs: [],
		}) as never;

		const caller = appRouter.createCaller({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await caller.auth.register({
			email: "New@Example.COM",
			password: "BrandNew123!",
			name: "New",
		});

		expect(prisma.user.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ email: "new@example.com" }),
			}),
		);
		expect(upsertCredentialAccount).toHaveBeenCalledTimes(1);
		expect(mockedUpsert.mock.calls[0][0]).toBe("user_new");
		expect(mockedUpsert.mock.calls[0][2]).toBe(prisma);
	});

	test("auth.register validates and consumes an invitation in its transaction", async () => {
		const jwt = await import("jsonwebtoken");
		const inviteToken = jwt.sign(
			{ purpose: "registration" },
			process.env.NEXTAUTH_SECRET,
		);
		const prisma = makePrismaMock({}) as PrismaClient;
		prisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
		prisma.user.create = jest.fn().mockResolvedValue({
			id: "user_invited",
			name: "Invited",
			email: "invited@example.com",
			expiresAt: null,
			role: "USER",
			memberOfOrgs: [],
		}) as never;
		prisma.invitation.findUnique = jest.fn().mockResolvedValue({
			id: 7,
			token: inviteToken,
			secret: "invite-secret",
			used: false,
			timesUsed: 0,
			timesCanUse: 1,
			expiresAt: new Date(Date.now() + 60_000),
			groupId: null,
		}) as never;
		prisma.invitation.update = jest.fn().mockResolvedValue({}) as never;

		const caller = appRouter.createCaller({
			session: null,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await caller.auth.register({
			email: "invited@example.com",
			password: "BrandNew123!",
			name: "Invited",
			token: inviteToken,
			ztnetInvitationCode: "invite-secret",
		});

		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
		expect(prisma.invitation.findUnique).toHaveBeenCalledWith({
			where: { token: inviteToken, secret: "invite-secret" },
		});
		expect(prisma.invitation.update).toHaveBeenCalledWith({
			where: { id: 7 },
			data: { timesUsed: { increment: 1 }, used: true },
		});
	});

	test("auth.register enforces the configured first-administrator email", async () => {
		const previous = process.env.INITIAL_ADMIN_EMAIL;
		process.env.INITIAL_ADMIN_EMAIL = "owner@example.com";
		try {
			const prisma = makePrismaMock({}) as PrismaClient;
			prisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
			prisma.user.count = jest.fn().mockResolvedValue(0) as never;
			const caller = appRouter.createCaller({
				session: null,
				wss: null,
				prisma,
				res: { setHeader: jest.fn() } as never,
				req: { headers: {} } as never,
			});

			await expect(
				caller.auth.register({
					email: "attacker@example.com",
					password: "BrandNew123!",
					name: "Attacker",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(prisma.user.create).not.toHaveBeenCalled();
		} finally {
			// biome-ignore lint/performance/noDelete: assigning undefined stringifies in Node
			if (previous === undefined) delete process.env.INITIAL_ADMIN_EMAIL;
			else process.env.INITIAL_ADMIN_EMAIL = previous;
		}
	});

	test("auth.addApiToken returns the bearer once and stores only its digest", async () => {
		const prisma = makePrismaMock({}) as PrismaClient;
		prisma.aPIToken.create = jest.fn().mockResolvedValue({
			id: "token_1",
			name: "CLI token",
		}) as never;
		prisma.aPIToken.update = jest.fn().mockResolvedValue({
			id: "token_1",
			name: "CLI token",
			token: "digest:encrypted",
		}) as never;

		const caller = appRouter.createCaller({
			session: session as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		const result = await caller.auth.addApiToken({
			name: "CLI token",
			daysToExpire: "7",
			apiAuthorizationType: ["PERSONAL"],
		});

		expect(prisma.aPIToken.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ token: "digest:encrypted" }),
		});
		expect(prisma.aPIToken.update).toHaveBeenCalledWith({
			where: { id: "token_1" },
			data: { token: "digest:encrypted" },
		});
		expect(result.token).toBe("encrypted");
		expect(result.token).not.toBe("digest:encrypted");
	});

	test("admin.createUser accepts lowercase email and stores the generated password for login", async () => {
		const prisma = makePrismaMock({ role: Role.ADMIN }) as PrismaClient;
		prisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;
		prisma.user.create = jest.fn().mockResolvedValue({
			id: "user_admin_created",
			name: "Heodel",
			email: "heodel@163.com",
			role: Role.USER,
			userGroupId: null,
			expiresAt: null,
			requestChangePassword: false,
			createdAt: new Date(),
		}) as never;

		const caller = appRouter.createCaller({
			session: {
				...session,
				user: { ...session.user, role: Role.ADMIN },
			} as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});
		const password = "!xxB1Yl6L55$";

		await caller.admin.createUser({
			name: "Heodel",
			email: "heodel@163.com",
			password,
			role: Role.USER,
		});

		const createArgs = (prisma.user.create as jest.Mock).mock.calls[0][0];
		expect(createArgs.data.email).toBe("heodel@163.com");
		expect(bcrypt.compareSync(password, createArgs.data.hash)).toBe(true);
		expect(upsertCredentialAccount).toHaveBeenCalledTimes(1);
		const credentialCall = mockedUpsert.mock.calls[0];
		expect(credentialCall?.[0]).toBe("user_admin_created");
		expect(credentialCall?.[1]).toBe(createArgs.data.hash);
		expect(credentialCall?.[2]).toBe(prisma);
	});

	test("admin.createUser rejects email containing uppercase letters before database access", async () => {
		const prisma = makePrismaMock({ role: Role.ADMIN }) as PrismaClient;
		prisma.user.findFirst = jest.fn().mockResolvedValue(null) as never;

		const caller = appRouter.createCaller({
			session: {
				...session,
				user: { ...session.user, role: Role.ADMIN },
			} as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		await expect(
			caller.admin.createUser({
				name: "Heodel",
				email: "Heodel@163.com",
				password: "!xxB1Yl6L55$",
				role: Role.USER,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(prisma.user.findFirst).not.toHaveBeenCalled();
		expect(prisma.user.create).not.toHaveBeenCalled();
		expect(upsertCredentialAccount).not.toHaveBeenCalled();
	});
});

describe("auth router response boundaries", () => {
	function callerFor(prisma: PrismaClient) {
		return appRouter.createCaller({
			session: session as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});
	}

	test("auth.me redacts user and controller secrets", async () => {
		const prisma = makePrismaMock({
			hash: "password-hash",
			tempPassword: "temporary-password",
			twoFactorSecret: "mfa-secret",
			twoFactorRecoveryCodes: ["recovery-code-hash"],
			failedLoginAttempts: 2,
			lastFailedLoginAttempt: new Date(),
			options: {
				id: 1,
				userId: "user_1",
				ztCentralApiKey: "central-secret",
				ztCentralApiUrl: "https://api.zerotier.com/api/v1",
				localControllerUrl: "http://zerotier:9993",
				localControllerSecret: "controller-secret",
			},
			memberOfOrgs: [],
			UserDevice: [],
		}) as PrismaClient;

		const result = await callerFor(prisma).auth.me();

		expect(result).not.toHaveProperty("hash");
		expect(result).not.toHaveProperty("tempPassword");
		expect(result).not.toHaveProperty("twoFactorSecret");
		expect(result).not.toHaveProperty("twoFactorRecoveryCodes");
		expect(result).not.toHaveProperty("failedLoginAttempts");
		expect(result).not.toHaveProperty("lastFailedLoginAttempt");
		expect(result.options).not.toHaveProperty("ztCentralApiKey");
		expect(result.options).not.toHaveProperty("localControllerSecret");
		expect(result.options.hasZtCentralApiKey).toBe(true);
		expect(result.options.hasLocalControllerSecret).toBe(true);
	});

	test("auth.me repairs a missing options row for OAuth-created users", async () => {
		const prisma = makePrismaMock({
			options: null,
			memberOfOrgs: [],
			UserDevice: [],
		}) as PrismaClient;
		const defaultOptions = {
			id: 2,
			userId: "user_1",
			ztCentralApiKey: "",
			ztCentralApiUrl: "https://api.zerotier.com/api/v1",
			localControllerUrl: "http://zerotier:9993",
			localControllerSecret: "",
		};
		prisma.userOptions.upsert = jest.fn().mockResolvedValue(defaultOptions) as never;

		const result = await callerFor(prisma).auth.me();

		expect(prisma.userOptions.upsert).toHaveBeenCalledWith({
			where: { userId: "user_1" },
			create: { userId: "user_1" },
			update: {},
		});
		expect(result.options.hasZtCentralApiKey).toBe(false);
		expect(result.options.hasLocalControllerSecret).toBe(false);
	});

	test("settings mutations return acknowledgements instead of Prisma user rows", async () => {
		const prisma = makePrismaMock({
			hash: "password-hash",
			twoFactorSecret: "mfa-secret",
			options: { ztCentralApiKey: "central-secret" },
		}) as PrismaClient;
		const caller = callerFor(prisma);

		await expect(
			caller.auth.updateUserOptions({ deAuthorizeWarning: true }),
		).resolves.toEqual({ status: "success" });
		await expect(
			caller.auth.setZtApi({ ztCentralApiUrl: "https://central.example/api" }),
		).resolves.toEqual({ status: "success" });
		await expect(
			caller.auth.setLocalZt({ localControllerUrl: "http://zerotier:9993" }),
		).resolves.toEqual({ status: "success" });

		for (const call of (prisma.user.update as jest.Mock).mock.calls) {
			expect(call[0]).not.toHaveProperty("include");
		}
	});

	test("site invitation links do not disclose the independent invitation code", async () => {
		const prisma = makePrismaMock({ role: Role.ADMIN }) as PrismaClient;
		prisma.invitation.create = jest.fn().mockResolvedValue({}) as never;
		const caller = appRouter.createCaller({
			session: {
				...session,
				user: { ...session.user, role: Role.ADMIN },
			} as Session,
			wss: null,
			prisma,
			res: { setHeader: jest.fn() } as never,
			req: { headers: {} } as never,
		});

		const token = await caller.admin.generateInviteLink({
			secret: "independent-invitation-code",
			expireTime: "15",
		});
		const decoded = (await import("jsonwebtoken")).decode(token) as Record<
			string,
			unknown
		>;

		expect(decoded).not.toHaveProperty("secret");
		expect(decoded.nonce).toEqual(expect.any(String));
		expect(prisma.invitation.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ secret: "independent-invitation-code" }),
			}),
		);
	});
});
