import { createTRPCRouter, adminRoleProtectedRoute } from "~/server/api/trpc";
import { z } from "zod";
import * as ztController from "~/utils/ztApi";
import { mailTemplateMap, sendMailWithTemplate } from "~/utils/mail";
import { type GlobalOptions, Role } from "@prisma/client";
import { throwError } from "~/server/helpers/errorHandler";
import type { ZTControllerNodeStatus } from "~/types/ztController";
import type { NetworkAndMemberResponse } from "~/types/network";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { WorldConfig } from "~/types/worldConfig";
import axios from "axios";
import { updateLocalConf } from "~/utils/planet";
import jwt from "jsonwebtoken";
import { decrypt, encrypt, generateInstanceSecret } from "~/utils/encryption";
import { SMTP_SECRET } from "~/utils/encryption";
import { ZT_FOLDER } from "~/utils/ztApi";
import { isRunningInDocker } from "~/utils/docker";
import { getNetworkClassCIDR } from "~/utils/IPv4gen";
import type { InvitationLinkType } from "~/types/invitation";
import { MailTemplateKey } from "~/utils/enums";
import path from "node:path";
import { BackupMetadata } from "~/types/backupRestore";
import { checkAndDeactivateExpiredUsers } from "~/cronTasks";
import { getSystemUpdateStatus, triggerSystemUpdate } from "~/server/systemUpdate";
import { upsertCredentialAccount } from "~/server/api/services/credentialAccountService";
import { hasUppercaseEmail, normalizeEmail } from "~/utils/email";
import { disconnectUserSockets } from "~/server/socketRegistry";
import {
	BACKUP_DIRECTORY,
	createBackupArchive,
	extractBackupArchive,
	getBackupFileName,
	isBackupFileName,
	resolveBackupFile,
} from "~/server/backupFiles";
import { planetEndpointSchema } from "~/server/planetArchive";
import {
	activatePreparedPlanet,
	ensureOriginalPlanetBackup,
	restoreOriginalPlanet,
} from "~/server/planetFiles";

type WithError<T> = T & { error?: boolean; message?: string };
type GlobalOptionsResponse = WithError<
	Omit<GlobalOptions, "smtpPassword" | "alipayPrivateKeyEncrypted" | "alipayPublicKey">
> & {
	smtpPassword: null;
	hasSmtpPassword: boolean;
	hasAlipayPublicKey: boolean;
	hasAlipayPrivateKey: boolean;
};

function getPostgresConnection() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL not found");

	const url = new URL(databaseUrl);
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error("Only PostgreSQL databases are supported");
	}

	const decode = (value: string, field: string) => {
		try {
			return decodeURIComponent(value);
		} catch {
			throw new Error(`DATABASE_URL contains an invalid ${field}`);
		}
	};
	const username = decode(url.username, "username");
	const password = decode(url.password, "password");
	const database = decode(url.pathname.replace(/^\//, ""), "database name");
	if (!url.hostname || !username || !database) {
		throw new Error("DATABASE_URL must include a host, username, and database name");
	}

	const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: password };
	const sslMode = url.searchParams.get("sslmode");
	if (sslMode) env.PGSSLMODE = sslMode;

	return {
		args: ["-h", url.hostname, "-p", url.port || "5432", "-U", username, "-d", database],
		env,
	};
}

function runZeroTierServiceAction(action: "start" | "stop"): boolean {
	const commands = [
		["systemctl", action, "zerotier-one"],
		["service", "zerotier-one", action],
		["service", "zerotier", action],
	];
	for (const [command, ...args] of commands) {
		try {
			execFileSync(command, args, { stdio: "ignore", timeout: 30_000 });
			return true;
		} catch {
			// Try the next service manager.
		}
	}
	return false;
}

function applyZeroTierPermissions(directory: string): void {
	for (const entry of fs.readdirSync(/* turbopackIgnore: true */ directory, {
		withFileTypes: true,
	})) {
		const entryPath = path.join(/* turbopackIgnore: true */ directory, entry.name);
		if (entry.isDirectory()) {
			fs.chmodSync(/* turbopackIgnore: true */ entryPath, 0o700);
			applyZeroTierPermissions(entryPath);
		} else if (entry.isFile()) {
			fs.chmodSync(/* turbopackIgnore: true */ entryPath, 0o600);
		} else {
			throw new Error("The extracted ZeroTier backup contains a special file.");
		}
	}
	fs.chmodSync(/* turbopackIgnore: true */ directory, 0o700);
}

function installStandaloneZeroTierBackup(sourceDirectory: string): () => void {
	if (!runZeroTierServiceAction("stop")) {
		throw new Error(
			"Could not stop zerotier-one. Restore the ZeroTier folder while the service is offline.",
		);
	}

	const safetyDirectory = `${ZT_FOLDER}.backup.${Date.now()}`;
	let movedCurrentDirectory = false;
	const restorePreviousDirectory = () => {
		runZeroTierServiceAction("stop");
		fs.rmSync(/* turbopackIgnore: true */ ZT_FOLDER, { recursive: true, force: true });
		if (
			movedCurrentDirectory &&
			fs.existsSync(/* turbopackIgnore: true */ safetyDirectory)
		) {
			fs.renameSync(/* turbopackIgnore: true */ safetyDirectory, ZT_FOLDER);
		}
		if (!runZeroTierServiceAction("start")) {
			throw new Error("Could not restart zerotier-one after rolling back the restore.");
		}
	};

	try {
		if (fs.existsSync(/* turbopackIgnore: true */ ZT_FOLDER)) {
			fs.renameSync(/* turbopackIgnore: true */ ZT_FOLDER, safetyDirectory);
			movedCurrentDirectory = true;
		}
		fs.cpSync(/* turbopackIgnore: true */ sourceDirectory, ZT_FOLDER, {
			recursive: true,
			preserveTimestamps: true,
			errorOnExist: true,
		});
		applyZeroTierPermissions(ZT_FOLDER);
		execFileSync("chown", ["-R", "root:root", ZT_FOLDER], {
			stdio: "ignore",
			timeout: 30_000,
		});
		if (!runZeroTierServiceAction("start")) {
			throw new Error("Could not start zerotier-one with the restored files.");
		}
		return restorePreviousDirectory;
	} catch (error) {
		try {
			restorePreviousDirectory();
		} catch (rollbackError) {
			throw new Error(
				`${error instanceof Error ? error.message : "ZeroTier restore failed"} ` +
					`Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`,
			);
		}
		throw error;
	}
}

function getPublicGlobalOptions(
	options: WithError<GlobalOptions>,
): GlobalOptionsResponse {
	const { smtpPassword, alipayPrivateKeyEncrypted, alipayPublicKey, ...publicOptions } =
		options;
	return {
		...publicOptions,
		smtpPassword: null,
		hasSmtpPassword: Boolean(smtpPassword),
		hasAlipayPublicKey: Boolean(alipayPublicKey),
		hasAlipayPrivateKey: Boolean(alipayPrivateKeyEncrypted),
	};
}

const mailTemplateKeyInput = z.enum([
	MailTemplateKey.InviteUser,
	MailTemplateKey.InviteOrganization,
	MailTemplateKey.ForgotPassword,
	MailTemplateKey.VerifyEmail,
	MailTemplateKey.Notification,
	MailTemplateKey.NewDeviceNotification,
	MailTemplateKey.DeviceIpChangeNotification,
]);

export const adminRouter = createTRPCRouter({
	getRuntimeCapabilities: adminRoleProtectedRoute.query(() => ({
		runningInDocker: isRunningInDocker(),
		canRestoreZerotierOnline: !isRunningInDocker(),
	})),
	getSystemUpdateStatus: adminRoleProtectedRoute.query(() => getSystemUpdateStatus()),
	checkSystemUpdateStatus: adminRoleProtectedRoute.mutation(() =>
		getSystemUpdateStatus({ forceRefresh: true }),
	),
	triggerSystemUpdate: adminRoleProtectedRoute.mutation(async () => {
		try {
			return await triggerSystemUpdate();
		} catch (error) {
			throwError(
				error instanceof Error ? error.message : "The update request failed.",
				"PRECONDITION_FAILED",
			);
		}
	}),
	updateUser: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.string(),
				params: z.object({
					isActive: z.boolean(),
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (ctx.session.user.id === input.id) {
				throwError("You can't change your own status");
			}

			const updated = await ctx.prisma.$transaction(async (transaction) => {
				const userLockKey = `billing-user:${input.id}`;
				await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey}))`;
				const user = await transaction.user.findUnique({
					where: { id: input.id },
					select: {
						id: true,
						role: true,
						suspensionReason: true,
						expiresAt: true,
						userGroup: { select: { expiresAt: true } },
						subscription: {
							select: { status: true, startsAt: true, expiresAt: true },
						},
					},
				});
				if (!user) throwError("User not found", "NOT_FOUND");
				if (user.role === "ADMIN") {
					throwError("You can't change the status of admin users");
				}

				if (input.params.isActive) {
					const now = new Date();
					if (user.suspensionReason === "SUBSCRIPTION_EXPIRED") {
						throwError(
							"Assign a plan with a future expiration to restore this account.",
							"PRECONDITION_FAILED",
						);
					}
					if (user.expiresAt && user.expiresAt <= now) {
						throwError(
							"The account expiration must be renewed before activation.",
							"PRECONDITION_FAILED",
						);
					}
					if (user.subscription) {
						const subscriptionIsCurrent =
							user.subscription.status === "ACTIVE" &&
							user.subscription.startsAt <= now &&
							user.subscription.expiresAt > now;
						if (!subscriptionIsCurrent) {
							throwError(
								"Assign a plan with a future expiration before activation.",
								"PRECONDITION_FAILED",
							);
						}
					} else if (user.userGroup?.expiresAt && user.userGroup.expiresAt <= now) {
						throwError("The assigned user group has expired.", "PRECONDITION_FAILED");
					}
				}

				const result = await transaction.user.update({
					where: { id: input.id },
					data: {
						isActive: input.params.isActive,
						suspensionReason: input.params.isActive ? "NONE" : "ADMIN",
					},
				});
				if (input.params.isActive === false) {
					await transaction.session.deleteMany({ where: { userId: input.id } });
					await transaction.aPIToken.updateMany({
						where: { userId: input.id, isActive: true },
						data: { isActive: false },
					});
				}
				return result;
			});
			if (input.params.isActive === false) disconnectUserSockets(input.id);
			return updated;
		}),
	deleteUser: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (ctx.session.user.id === input.id) {
				throwError("You can't delete your own account");
			}

			// check if user is admin user
			const user = await ctx.prisma.user.findUnique({
				where: {
					id: input.id,
				},
			});
			if (!user) {
				throwError("User not found", "NOT_FOUND");
			}

			if (user.role === "ADMIN") {
				throwError("You can't delete admin users");
			}

			// get user networks
			const userNetworks = await ctx.prisma.network.findMany({
				where: {
					authorId: input.id,
				},
			});

			// Controller credentials belong to the target user, not the administrator.
			const targetUserContext = {
				prisma: ctx.prisma,
				session: { ...ctx.session, user },
			};
			for (const network of userNetworks) {
				const members = await ztController.network_members(
					targetUserContext,
					network.nwid,
					false,
				);
				for (const memberId in members) {
					await ztController.member_update({
						ctx: targetUserContext,
						nwid: network.nwid,
						memberId,
						central: false,
						updateParams: { authorized: false },
					});
				}
				await ztController.network_delete(targetUserContext, network.nwid, false);
			}

			const deletedUser = await ctx.prisma.$transaction(async (transaction) => {
				await transaction.verification.deleteMany({
					where: { identifier: { in: [user.id, user.email] } },
				});
				return transaction.user.delete({ where: { id: input.id } });
			});
			disconnectUserSockets(input.id);
			return deletedUser;
		}),
	createUser: adminRoleProtectedRoute
		.input(
			z.object({
				name: z.string().min(1, "Name is required"),
				email: z
					.string()
					.trim()
					.email("Valid email is required")
					.refine((email) => !hasUppercaseEmail(email), {
						message: "Email address cannot contain uppercase letters",
					})
					.transform(normalizeEmail),
				password: z.string().min(6, "Password must be at least 6 characters"),
				role: z.nativeEnum(Role).default(Role.READ_ONLY),
				userGroupId: z.number().optional(),
				expiresAfterDays: z.number().optional(),
				requestChangePassword: z.boolean().default(false),
				organizationId: z.string().optional(),
				organizationRole: z.nativeEnum(Role).default(Role.USER),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const {
				name,
				email,
				password,
				role,
				userGroupId,
				expiresAfterDays,
				requestChangePassword,
				organizationId,
				organizationRole,
			} = input;

			// Check if user with this email already exists
			const existingUser = await ctx.prisma.user.findFirst({
				where: {
					email: {
						equals: email,
						mode: "insensitive",
					},
				},
			});

			if (existingUser) {
				throwError("User with this email already exists");
			}

			// Hash the password
			const bcrypt = await import("bcryptjs");
			const hash = bcrypt.hashSync(password, 10);

			// Calculate expiration date if specified
			let expiresAt: Date | null = null;
			if (expiresAfterDays && expiresAfterDays > 0) {
				expiresAt = new Date();
				expiresAt.setDate(expiresAt.getDate() + expiresAfterDays);
			}

			// Get user group if specified, or default group
			let finalUserGroupId = userGroupId;
			if (!finalUserGroupId) {
				const defaultUserGroup = await ctx.prisma.userGroup.findFirst({
					where: { isDefault: true },
				});
				finalUserGroupId = defaultUserGroup?.id;
			}

			// Create the user
			const newUser = await ctx.prisma.user.create({
				data: {
					name,
					email,
					hash,
					role,
					userGroupId: finalUserGroupId,
					expiresAt,
					requestChangePassword,
					lastLogin: new Date().toISOString(),
					options: {
						create: {
							localControllerUrl: isRunningInDocker()
								? "http://zerotier:9993"
								: "http://127.0.0.1:9993",
						},
					},
				},
				select: {
					id: true,
					name: true,
					email: true,
					role: true,
					userGroupId: true,
					expiresAt: true,
					requestChangePassword: true,
					createdAt: true,
				},
			});

			await upsertCredentialAccount(newUser.id, hash, ctx.prisma);

			// If organization is specified, add user to organization with specified role
			if (organizationId && organizationRole) {
				// Verify that the organization exists and the current admin has access to it
				const organization = await ctx.prisma.organization.findFirst({
					where: {
						id: organizationId,
						ownerId: ctx.session.user.id, // Only allow adding to organizations owned by the admin
					},
				});

				if (!organization) {
					throwError("Organization not found or access denied");
				}

				// Add the user to the organization
				await ctx.prisma.organization.update({
					where: { id: organizationId },
					data: {
						users: {
							connect: { id: newUser.id },
						},
					},
				});

				// Set the user's role in the organization
				await ctx.prisma.userOrganizationRole.create({
					data: {
						userId: newUser.id,
						organizationId: organizationId,
						role: organizationRole,
					},
				});
			}

			return newUser;
		}),
	getUser: adminRoleProtectedRoute
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			return await ctx.prisma.user.findFirst({
				select: {
					id: true,
					name: true,
					email: true,
					emailVerified: true,
					lastLogin: true,
					lastseen: true,
					online: true,
					role: true,
					_count: {
						select: {
							network: true,
						},
					},
					userGroup: true,
					userGroupId: true,
					isActive: true,
					suspensionReason: true,
					expiresAt: true,
					subscription: {
						select: {
							id: true,
							planId: true,
							status: true,
							expiresAt: true,
							maxNetworksSnapshot: true,
						},
					},
				},

				where: {
					id: input.userId,
				},
			});
		}),
	getUsers: adminRoleProtectedRoute
		.input(
			z.object({
				isAdmin: z.boolean().default(false),
			}),
		)
		.query(async ({ ctx, input }) => {
			const users = await ctx.prisma.user.findMany({
				select: {
					id: true,
					name: true,
					email: true,
					emailVerified: true,
					lastLogin: true,
					createdAt: true,
					expiresAt: true,
					lastseen: true,
					online: true,
					role: true,
					_count: {
						select: {
							network: true,
						},
					},
					userGroup: true,
					userGroupId: true,
					isActive: true,
				},

				where: input.isAdmin ? { role: "ADMIN" } : undefined,
			});
			return users;
		}),
	generateInviteLink: adminRoleProtectedRoute
		.input(
			z.object({
				secret: z.string(),
				expireTime: z.string(),
				timesCanUse: z.string().optional(),
				groupId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { secret, expireTime, timesCanUse, groupId } = input;

			const token = jwt.sign({ secret }, process.env.NEXTAUTH_SECRET, {
				expiresIn: `${expireTime}m`,
			});
			const url = `${process.env.NEXTAUTH_URL}/locale-redirect?invite=${token}`;

			// Store the token, email, createdBy, and expiration in the UserInvitation table
			await ctx.prisma.invitation.create({
				data: {
					token,
					url,
					secret,
					groupId,
					timesCanUse: Number.parseInt(timesCanUse) || 1,
					expiresAt: new Date(Date.now() + Number.parseInt(expireTime) * 60 * 1000),
					invitedById: ctx.session.user.id,
				},
			});

			return token;
		}),
	getInvitationLink: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const invite = await ctx.prisma.invitation.findMany({
			where: {
				invitedById: ctx.session.user.id,
				// Exclude organization invitations by filtering out invitations that have organizations
				organizations: {
					none: {},
				},
			},
		});

		// map over and check if groupId exists, and if so get the group name
		const invitationLinks: InvitationLinkType[] = await Promise.all(
			invite.map(async (inv) => {
				let groupName = null;
				if (inv.groupId) {
					const group = await ctx.prisma.userGroup.findUnique({
						where: {
							id: Number.parseInt(inv.groupId, 10),
						},
					});
					groupName = group?.name || null;
				}
				return {
					...inv,
					groupName,
				};
			}),
		);

		return invitationLinks;
	}),
	deleteInvitationLink: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.number(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return await ctx.prisma.invitation.delete({
				where: {
					id: input.id,
				},
			});
		}),
	getControllerStats: adminRoleProtectedRoute.query(async ({ ctx }) => {
		try {
			const isCentral = false;
			const networks = await ztController.get_controller_networks(ctx, isCentral);
			const networkCount = networks.length;
			let totalMembers = 0;
			const assignedIPs = new Set<string>();
			for (const network of networks) {
				const networkDetails = await ztController.local_network_and_members(
					ctx,
					network as string,
				);
				totalMembers += networkDetails?.members.length;

				// @ts-expect-error
				const usedIp = getNetworkClassCIDR(networkDetails?.network?.ipAssignmentPools);
				if (usedIp[0]?.target) assignedIPs.add(usedIp[0]?.target);
			}

			const controllerStatus = (await ztController.get_controller_status(
				ctx,
				isCentral,
			)) as ZTControllerNodeStatus;
			return {
				networkCount,
				totalMembers,
				controllerStatus,
				assignedIPs: Array.from(assignedIPs),
			};
		} catch (error) {
			return throwError(error);
		}
	}),

	// Set global options
	getAllOptions: adminRoleProtectedRoute.query(
		async ({ ctx }): Promise<GlobalOptionsResponse | null> => {
			let options = (await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			})) as WithError<GlobalOptions>;

			if (options?.smtpPassword && !options.smtpPassword.includes(":")) {
				options = {
					...options,
					error: true,
					message:
						"Please re-enter your SMTP password to enhance security through database hashing.",
				};
			}
			// Never send actual password to client - only indicate if one exists
			if (options) return getPublicGlobalOptions(options);
			return null;
		},
	),

	// Set global options
	changeRole: adminRoleProtectedRoute
		.input(
			z.object({
				role: z.string().refine((value) => Object.values(Role).includes(value as Role), {
					message: "Role is not valid",
					path: ["role"],
				}),
				id: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { id, role } = input;

			if (ctx.session.user.id === id) {
				throwError("You can't change your own role");
			}

			// If the role is set to Admin, also set the userGroupId to null (i.e., delete the userGroup for the user)
			const updateData =
				role === "ADMIN"
					? {
							role: role as Role,
							userGroupId: null,
							expiresAt: null,
							isActive: true,
							suspensionReason: "NONE" as const,
						}
					: {
							role: role as Role,
						};

			return await ctx.prisma.user.update({
				where: {
					id,
				},
				data: updateData,
			});
		}),
	updateGlobalOptions: adminRoleProtectedRoute
		.input(
			z.object({
				enableRegistration: z.boolean().optional(),
				firstUserRegistration: z.boolean().optional(),
				userRegistrationNotification: z.boolean().optional(),
				welcomeMessageTitle: z.string().max(50).optional(),
				welcomeMessageBody: z.string().max(350).optional(),
				siteName: z.string().max(30).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const options = await ctx.prisma.globalOptions.update({
				where: {
					id: 1,
				},
				data: {
					...input,
				},
			});
			return getPublicGlobalOptions(options);
		}),
	getMailTemplates: adminRoleProtectedRoute
		.input(
			z.object({
				template: mailTemplateKeyInput,
			}),
		)
		.query(async ({ ctx, input }) => {
			const templates = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});
			const storedTemplate = templates?.[input.template];
			if (typeof storedTemplate === "string") {
				try {
					return JSON.parse(storedTemplate);
				} catch {
					return mailTemplateMap[input.template]();
				}
			}
			if (storedTemplate && typeof storedTemplate === "object") return storedTemplate;
			return mailTemplateMap[input.template]();
		}),

	setMail: adminRoleProtectedRoute
		.input(
			z.object({
				smtpHost: z.string().optional(),
				smtpPort: z.string().optional(),
				smtpSecure: z.boolean().optional(),
				smtpEmail: z.string().optional(),
				smtpFromName: z.string().optional(),
				smtpPassword: z.string().nullable().optional(), // null = clear, string = set, undefined = no change
				smtpUsername: z.string().optional(),
				smtpUseSSL: z.boolean().optional(),
				smtpIgnoreTLS: z.boolean().optional(),
				smtpRequireTLS: z.boolean().optional(),
				smtpEncryption: z.enum(["NONE", "SSL", "STARTTLS"]).optional(),
				smtpUseAuthentication: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Handle password: encrypt if set, clear if null, ignore if undefined
			let passwordUpdate: { smtpPassword?: string | null } = {};
			if (input.smtpPassword === null) {
				// Explicitly clear the password
				passwordUpdate = { smtpPassword: null };
			} else if (input.smtpPassword) {
				// Encrypt and set new password
				passwordUpdate = {
					smtpPassword: encrypt(input.smtpPassword, generateInstanceSecret(SMTP_SECRET)),
				};
			}
			// If undefined, don't include in update (keeps existing value)

			const { smtpPassword, ...restInput } = input;

			const options = await ctx.prisma.globalOptions.update({
				where: {
					id: 1,
				},
				data: {
					...restInput,
					...passwordUpdate,
				},
			});
			return getPublicGlobalOptions(options);
		}),
	setMailTemplates: adminRoleProtectedRoute
		.input(
			z.object({
				template: z.string(),
				type: mailTemplateKeyInput,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { type, template } = input;
			const options = await ctx.prisma.globalOptions.update({
				where: { id: 1 },
				data: { [type]: template },
			});
			return getPublicGlobalOptions(options);
		}),
	getDefaultMailTemplate: adminRoleProtectedRoute
		.input(
			z.object({
				template: mailTemplateKeyInput,
			}),
		)
		.mutation(({ input }) => {
			return mailTemplateMap[input.template]();
		}),
	sendTestMail: adminRoleProtectedRoute
		.input(
			z.object({
				type: z.nativeEnum(MailTemplateKey),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { type } = input;
			const { user } = ctx.session;

			const templateData = {
				// Common tags
				toEmail: user.email,
				toName: user.name,
				fromName: user.name,
				fromAdmin: user.name,
				fromOrganization: "Test Organization",

				// Specific tags for each template
				invitationLink: "https://ztnet.network/invite",
				forgotLink: "https://ztnet.network/reset-password",
				notificationMessage: "This is a test notification message",
				nwid: "8056c2e21c000001",
				accessTime: new Date().toISOString(),
				ipAddress: "192.168.1.1",
				browserInfo: "Test Browser (Test OS)",
				accountPageUrl: "https://ztnet.network/account",

				// Additional tags that might be used in future templates
				userId: user.id,
				userRole: "Admin",
				applicationName: "ZTNET",
				supportEmail: "support@ztnet.network",
				loginUrl: "https://ztnet.network/login",
				expirationTime: "24 hours",
				actionRequired: "Please verify your email address",
				customMessage: "This is a custom message for testing purposes",

				// verifyEmailTemplate specific tags
				verifyLink: "https://ztnet.network/verify-email",
			};

			await sendMailWithTemplate(type, {
				to: user.email,
				userId: user.id,
				templateData,
				sendInBackground: false, // Wait for actual SMTP response for test emails
			});

			return { success: true, message: `Test email for ${type} sent successfully` };
		}),

	/**
	 * `unlinkedNetwork` is an admin protected query that fetches and returns detailed information about networks
	 * that are present in the controller but not stored in the database.
	 *
	 * First, it fetches the network IDs from the controller and from the database.
	 *
	 * It then compares these lists to find networks that exist in the controller but not in the database.
	 *
	 * For each of these unlinked networks, it fetches detailed network information from the controller.
	 *
	 * @access restricted to admins
	 * @param {Object} ctx - context object that carries important information like database instance
	 * @param {Object} input - input object that contains possible query parameters or payload
	 * @returns {Promise<NetworkAndMemberResponse[]>} - an array of unlinked network details
	 */
	unlinkedNetwork: adminRoleProtectedRoute
		.input(
			z.object({
				getDetails: z.boolean().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			try {
				const ztNetworks = (await ztController.get_controller_networks(ctx)) as string[];
				const dbNetworks = await ctx.prisma.network.findMany({
					select: { nwid: true },
				});

				// create a set of nwid for faster lookup
				const dbNetworkIds = new Set(dbNetworks.map((network) => network.nwid));

				// find networks that are not in database
				const unlinkedNetworks = ztNetworks.filter(
					(networkId) => !dbNetworkIds.has(networkId),
				);

				if (unlinkedNetworks.length === 0) return [];

				if (input.getDetails) {
					const unlinkArr: NetworkAndMemberResponse[] = await Promise.all(
						unlinkedNetworks.map((unlinked) =>
							ztController.local_network_and_members(ctx, unlinked),
						),
					);
					return unlinkArr;
				}

				return unlinkedNetworks;
			} catch (_error) {
				return throwError("Failed to fetch unlinked networks", _error);
			}
		}),
	assignNetworkToUser: adminRoleProtectedRoute
		.input(
			z.object({
				userId: z.string(),
				nwid: z.string(),
				nwname: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// console.log(ipAssignmentPools);
				// Store the created network in the database
				const updatedUser = await ctx.prisma.user.update({
					where: {
						id: ctx.session.user.id,
					},
					data: {
						network: {
							create: {
								nwid: input.nwid,
								name: input.nwname || "",
							},
						},
					},
					select: {
						network: true,
					},
				});
				return updatedUser;

				// return ipAssignmentPools;
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message

					console.error(err);
					throwError("Could not create network! Please try again");
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	addUserGroup: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.number().optional(),
				groupName: z
					.string()
					.nonempty()
					.refine((val) => val.trim().length > 0, {
						message: "Group name cannot be empty",
					}),
				maxNetworks: z
					.string()
					.nonempty()
					.refine((val) => val.trim().length > 0, {
						message: "Max networks cannot be empty",
					}),
				isDefault: z
					.boolean()
					.refine((val) => typeof val !== "string", {
						message: "Default must be a boolean, not a string",
					})
					.optional()
					.refine((val) => val !== undefined, {
						message: "Default is required",
					}),
				expiresAt: z
					.string()
					.optional()
					.transform((val) => {
						if (!val || val === "") return null;
						return val;
					})
					.refine(
						(val) => {
							if (val === null) return true;
							return !Number.isNaN(Date.parse(val));
						},
						{
							message: "Invalid date format",
						},
					)
					.refine(
						(val) => {
							if (val === null) return true;
							const selectedDate = new Date(val);
							const today = new Date();
							today.setHours(0, 0, 0, 0); // Set to start of day for comparison
							return selectedDate >= today;
						},
						{
							message: "Expiration date cannot be in the past",
						},
					),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// If isDefault is true, update all other groups to have isDefault as false
				if (input.isDefault) {
					await ctx.prisma.userGroup.updateMany({
						where: {
							isDefault: true,
						},
						data: {
							isDefault: false,
						},
					});
				}

				// Parse the expiration date if provided and set to end of day
				let expiresAt: Date | null = null;
				if (input.expiresAt && input.expiresAt !== "") {
					const date = new Date(input.expiresAt);
					// Set to end of day (23:59:59.999) to ensure expiration happens after the full day
					date.setHours(23, 59, 59, 999);
					expiresAt = date;
				}

				// Use upsert to either update or create a new userGroup
				return await ctx.prisma.userGroup.upsert({
					where: {
						id: input.id || -1,
					},
					create: {
						name: input.groupName,
						maxNetworks: Number.parseInt(input.maxNetworks),
						isDefault: input.isDefault,
						expiresAt,
					},
					update: {
						name: input.groupName,
						maxNetworks: Number.parseInt(input.maxNetworks),
						isDefault: input.isDefault,
						expiresAt,
					},
				});
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError("Could not process user group operation! Please try again");
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	getUserGroups: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const userGroups = await ctx.prisma.userGroup.findMany({
			select: {
				id: true,
				name: true,
				maxNetworks: true,
				isDefault: true,
				expiresAt: true,
				_count: {
					select: {
						users: true,
					},
				},
			},
		});

		return userGroups;
	}),
	deleteUserGroup: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.number().refine((val) => val > 0, {
					message: "A valid group ID is required",
				}),
				removeUsers: z.boolean().default(false).optional(), // Option to automatically remove users
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// Check if the user group exists
				const existingGroup = await ctx.prisma.userGroup.findUnique({
					where: {
						id: input.id,
					},
				});

				if (!existingGroup) {
					throwError("User group not found!");
				}

				// Check if there are users still assigned to this group
				const usersInGroup = await ctx.prisma.user.findMany({
					where: {
						userGroupId: input.id,
					},
					select: {
						id: true,
						name: true,
						email: true,
					},
				});

				if (usersInGroup.length > 0) {
					if (input.removeUsers) {
						// Remove all users from the group first
						await ctx.prisma.user.updateMany({
							where: {
								userGroupId: input.id,
							},
							data: {
								userGroupId: null,
								expiresAt: null, // Remove expiration when removing from group
							},
						});
					} else {
						const userList = usersInGroup.map((u) => u.name || u.email).join(", ");
						throwError(
							`Cannot delete user group "${existingGroup.name}". ${usersInGroup.length} user(s) are still assigned to this group: ${userList}. Please manually remove these users from the group first by editing each user individually, then try deleting the group again.`,
						);
					}
				}

				// Delete the user group
				await ctx.prisma.userGroup.delete({
					where: {
						id: input.id,
					},
				});

				const removedUsersMessage =
					usersInGroup.length > 0 && input.removeUsers
						? ` ${usersInGroup.length} user(s) were automatically removed from the group.`
						: "";

				return { message: `User group successfully deleted.${removedUsersMessage}` };
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError(`Could not delete user group: ${err.message}`);
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred.");
				}
			}
		}),
	getIdentity: adminRoleProtectedRoute.query(async () => {
		let ip = "External IP";
		try {
			const response = await axios.get("https://api.ip.sb/ip");
			ip = response.data.trim();
		} catch (error) {
			console.error("Failed to fetch public IP:", error);
		}

		// Get identity from the file system
		const identityPath = `${ZT_FOLDER}/identity.public`;
		const identity = fs.existsSync(/* turbopackIgnore: true */ identityPath)
			? fs.readFileSync(/* turbopackIgnore: true */ identityPath, "utf-8").trim()
			: "";

		return { ip, identity };
	}),
	getPlanet: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const options = await ctx.prisma.globalOptions.findFirst({
			where: {
				id: 1,
			},
			select: {
				customPlanetUsed: true,
				planet: {
					select: {
						id: true,
						plID: true,
						plBirth: true,
						plRecommend: true,
						rootNodes: true,
					},
				},
			},
		});
		if (!options?.customPlanetUsed) return null;
		if (!options.planet) {
			return {
				error: new Error(
					"Inconsistent configuration: custom Planet is enabled but no Planet data exists.",
				),
				id: 0,
				plID: BigInt(0),
				plBirth: BigInt(0),
				plRecommend: true,
				rootNodes: [],
			};
		}
		const rootNodes = options.planet.rootNodes.map((node) => {
			const endpoints = z
				.array(planetEndpointSchema)
				.min(1)
				.max(32)
				.safeParse(node.endpoints);
			if (!endpoints.success) {
				throwError(
					`Stored Planet root node ${node.id} has invalid endpoints.`,
					"INTERNAL_SERVER_ERROR",
				);
			}
			return {
				id: node.id,
				PlanetId: node.PlanetId,
				identity: node.identity,
				comments: node.comments ?? "",
				endpoints: endpoints.data,
			};
		});
		return { ...options.planet, rootNodes };
	}),
	makeWorld: adminRoleProtectedRoute
		.input(
			z
				.object({
					plID: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
					plRecommend: z.boolean().default(true),
					plBirth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
					rootNodes: z
						.array(
							z.object({
								identity: z.string().trim().min(1).max(2048),
								endpoints: z.array(planetEndpointSchema).min(1).max(32),
								comments: z.string().trim().max(512).optional(),
							}),
						)
						.min(1)
						.max(64),
				})
				.refine(
					// Validator function
					(data) => {
						return data.plRecommend || Boolean(data.plID && data.plBirth);
					},
					// Error message
					{
						message:
							"If plRecommend is false, both plID and plBirth need to be provided.",
						path: ["plID", "plBirth"], // Path of the fields the error refers to
					},
				),
		)

		.mutation(async ({ ctx, input }) => {
			// data.plID 149604618 // official world in production ZeroTier Cloud
			// data.plID  227883110  // reserved world for future
			// data.plBirth 1567191349589
			let stagingDirectory: string | undefined;
			try {
				const mkworldDir = `${ZT_FOLDER}/zt-mkworld`;
				const planetPath = `${ZT_FOLDER}/planet`;
				const backupDir = `${ZT_FOLDER}/planet_backup`;

				// Check for write permission on the directory
				try {
					fs.accessSync(/* turbopackIgnore: true */ ZT_FOLDER, fs.constants.W_OK);
				} catch (_err) {
					if (isRunningInDocker()) {
						throwError(
							`Please remove the :ro flag from the docker volume mount for ${ZT_FOLDER}`,
						);
					} else {
						throwError(
							`Permission error: cannot write to ${ZT_FOLDER}. Make sure the folder is writable.`,
						);
					}
				}

				// Check if identity.public exists
				if (!fs.existsSync(/* turbopackIgnore: true */ `${ZT_FOLDER}/identity.public`)) {
					throwError("identity.public file does NOT exist, cannot generate planet file.");
				}

				// Check if ztmkworld executable exists
				const ztmkworldBinPath = "/usr/local/bin/ztmkworld";
				if (!fs.existsSync(/* turbopackIgnore: true */ ztmkworldBinPath)) {
					throwError("ztmkworld executable does not exist at the specified location.");
				}
				// Ensure /var/lib/zerotier-one/zt-mkworld directory exists
				fs.mkdirSync(/* turbopackIgnore: true */ mkworldDir, {
					recursive: true,
					mode: 0o700,
				});

				ensureOriginalPlanetBackup(backupDir, planetPath);
				// const identity = fs.readFileSync(`${ZT_FOLDER}/identity.public`, "utf-8").trim();

				/*
				 *
				 * Mock the mkworld.config.json file and write it to the file system
				 *
				 */

				const config: WorldConfig = {
					rootNodes: input.rootNodes.map((node) => ({
						comments: node.comments || "ztnet.network",
						identity: node.identity,
						endpoints: node.endpoints,
					})),
					signing: ["previous.c25519", "current.c25519"],
					output: "planet.custom",
					plID: input.plID || 0,
					plBirth: input.plBirth || 0,
					plRecommend: input.plRecommend,
				};

				stagingDirectory = fs.mkdtempSync(
					path.join(/* turbopackIgnore: true */ ZT_FOLDER, ".zt-mkworld-generate-"),
				);
				const stagingConfigPath = path.join(
					/* turbopackIgnore: true */ stagingDirectory,
					"mkworld.config.json",
				);
				fs.writeFileSync(
					/* turbopackIgnore: true */ stagingConfigPath,
					JSON.stringify(config),
					{ mode: 0o600 },
				);
				for (const keyName of ["current.c25519", "previous.c25519"]) {
					const keyPath = path.join(/* turbopackIgnore: true */ mkworldDir, keyName);
					if (
						fs
							.lstatSync(/* turbopackIgnore: true */ keyPath, {
								throwIfNoEntry: false,
							})
							?.isFile()
					) {
						fs.copyFileSync(
							/* turbopackIgnore: true */ keyPath,
							path.join(/* turbopackIgnore: true */ stagingDirectory, keyName),
						);
					}
				}

				/*
				 *
				 * Update local.conf file with the new port number
				 *
				 */
				// Extract the port numbers from the first endpoint string
				const portNumbers = input.rootNodes[0].endpoints[0]
					.split(",")
					.map((endpoint) => Number.parseInt(endpoint.split("/").pop() || "", 10));

				try {
					execFileSync(ztmkworldBinPath, ["-c", stagingConfigPath], {
						cwd: stagingDirectory,
						stdio: ["ignore", "ignore", "pipe"],
						timeout: 60_000,
					});
				} catch (_error) {
					throwError(
						"Could not create planet file. Please make sure your config is valid.",
					);
				}
				const generatedPlanet = path.join(
					/* turbopackIgnore: true */ stagingDirectory,
					"planet.custom",
				);
				if (
					!fs
						.lstatSync(/* turbopackIgnore: true */ generatedPlanet, {
							throwIfNoEntry: false,
						})
						?.isFile()
				) {
					throw new Error("ztmkworld did not create a Planet file.");
				}
				const downloadSha256 = createHash("sha256")
					.update(fs.readFileSync(/* turbopackIgnore: true */ generatedPlanet))
					.digest("hex");
				await activatePreparedPlanet({
					ztFolder: ZT_FOLDER,
					stagedWorldDirectory: stagingDirectory,
					ports: portNumbers,
					updatePorts: updateLocalConf,
					commitDatabase: () =>
						ctx.prisma.$transaction(async (tx) => {
							await tx.planet.upsert({
								where: { id: 1 },
								update: {
									globalOptions: { connect: { id: 1 } },
									plBirth: input.plBirth || 0,
									plID: input.plID || 0,
									plRecommend: input.plRecommend,
									origin: "LOCAL_GENERATED",
									downloadSha256,
									rootNodes: { deleteMany: {}, create: config.rootNodes },
								},
								create: {
									id: 1,
									globalOptions: { connect: { id: 1 } },
									plBirth: input.plBirth || 0,
									plID: input.plID || 0,
									plRecommend: input.plRecommend,
									origin: "LOCAL_GENERATED",
									downloadSha256,
									rootNodes: { create: config.rootNodes },
								},
							});
							await tx.globalOptions.update({
								where: { id: 1 },
								data: { customPlanetUsed: true },
							});
						}),
				});
				stagingDirectory = undefined;

				return config;
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError(`${err.message}`);
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			} finally {
				if (stagingDirectory) {
					fs.rmSync(/* turbopackIgnore: true */ stagingDirectory, {
						recursive: true,
						force: true,
					});
				}
			}
		}),
	resetWorld: adminRoleProtectedRoute.mutation(async ({ ctx }) => {
		try {
			await restoreOriginalPlanet({
				ztFolder: ZT_FOLDER,
				updatePorts: updateLocalConf,
				commitDatabase: () =>
					ctx.prisma.$transaction(async (tx) => {
						await tx.globalOptions.update({
							where: { id: 1 },
							data: { customPlanetUsed: false, planet: { disconnect: true } },
						});
						await tx.planet.deleteMany({});
					}),
			});
			return { success: true };
		} catch (err) {
			if (err instanceof Error) {
				throwError(`Error during reset: ${err.message}`);
			} else {
				throwError("An unknown error occurred during reset.");
			}
		}
	}),

	createBackup: adminRoleProtectedRoute
		.input(
			z.object({
				includeDatabase: z.boolean().default(true),
				includeZerotier: z.boolean().default(true),
				backupName: z.string().max(120).optional(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				const fileName = getBackupFileName(input.backupName, `ztnet-backup-${timestamp}`);
				const backupDir = BACKUP_DIRECTORY;
				const backupPath = resolveBackupFile(fileName);
				if (fs.existsSync(/* turbopackIgnore: true */ backupPath)) {
					throw new Error("A backup with this name already exists");
				}

				// Ensure backup and temp directories exist
				fs.mkdirSync(/* turbopackIgnore: true */ backupDir, {
					recursive: true,
					mode: 0o700,
				});
				const tempRoot = path.join(/* turbopackIgnore: true */ backupDir, "temp");
				fs.mkdirSync(/* turbopackIgnore: true */ tempRoot, {
					recursive: true,
					mode: 0o700,
				});
				const tempDir = fs.mkdtempSync(
					path.join(/* turbopackIgnore: true */ tempRoot, "backup-"),
				);

				try {
					// Backup database
					if (input.includeDatabase) {
						try {
							const dumpPath = path.join(
								/* turbopackIgnore: true */ tempDir,
								"database_dump.sql",
							);
							const connection = getPostgresConnection();
							const dumpFd = fs.openSync(
								/* turbopackIgnore: true */ dumpPath,
								"wx",
								0o600,
							);
							let dumpResult: ReturnType<typeof spawnSync>;
							try {
								dumpResult = spawnSync(
									"pg_dump",
									[...connection.args, "--clean", "--if-exists"],
									{
										env: connection.env,
										stdio: ["ignore", dumpFd, "pipe"],
										encoding: "utf8",
										maxBuffer: 4 * 1024 * 1024,
									},
								);
							} finally {
								fs.closeSync(dumpFd);
							}
							if (dumpResult.error) throw dumpResult.error;
							if (dumpResult.status !== 0) {
								const stderr = dumpResult.stderr
									? dumpResult.stderr.toString().trim()
									: "";
								throw new Error(
									stderr ||
										`pg_dump exited with status ${dumpResult.status ?? "unknown"}`,
								);
							}

							// Check if dump file was created and has content
							if (fs.existsSync(/* turbopackIgnore: true */ dumpPath)) {
								const stats = fs.statSync(/* turbopackIgnore: true */ dumpPath);
								if (stats.size === 0) {
									throw new Error("Database dump file is empty");
								}
							} else {
								throw new Error("Database dump file was not created");
							}
						} catch (error) {
							throw new Error(`Database backup failed: ${error.message}`);
						}
					}

					// Backup ZeroTier folder
					if (
						input.includeZerotier &&
						ZT_FOLDER &&
						fs.existsSync(/* turbopackIgnore: true */ ZT_FOLDER)
					) {
						const ztBackupPath = path.join(
							/* turbopackIgnore: true */ tempDir,
							"zerotier",
						);

						// Copy ZeroTier folder to temp directory
						try {
							fs.cpSync(/* turbopackIgnore: true */ ZT_FOLDER, ztBackupPath, {
								recursive: true,
								preserveTimestamps: true,
							});
						} catch (error) {
							throw new Error(`ZeroTier backup failed: ${error.message}`);
						}
					} else if (input.includeZerotier) {
						throw new Error("The ZeroTier folder is not available");
					}

					// Add metadata
					const metadata = {
						created: new Date().toISOString(),
						version: process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
						includeDatabase: input.includeDatabase,
						includeZerotier: input.includeZerotier,
						docker: isRunningInDocker(),
					};

					const metadataPath = path.join(
						/* turbopackIgnore: true */ tempDir,
						"backup_metadata.json",
					);
					fs.writeFileSync(
						/* turbopackIgnore: true */ metadataPath,
						JSON.stringify(metadata, null, 2),
					);

					// Create the archive without interpolating user input into a shell command.
					try {
						await createBackupArchive(tempDir, backupPath);
					} catch (error) {
						throw new Error(`Archive creation failed: ${error.message}`);
					}

					// Verify archive was created successfully
					if (!fs.existsSync(/* turbopackIgnore: true */ backupPath)) {
						throw new Error("Backup archive was not created");
					}

					// Clean up temp directory
					fs.rmSync(/* turbopackIgnore: true */ tempDir, {
						recursive: true,
						force: true,
					});

					// Return backup info
					const stats = fs.statSync(/* turbopackIgnore: true */ backupPath);
					return {
						success: true,
						fileName,
						size: stats.size,
						created: new Date().toISOString(),
					};
				} catch (error) {
					// Clean up temp directory on error
					if (fs.existsSync(/* turbopackIgnore: true */ tempDir)) {
						fs.rmSync(/* turbopackIgnore: true */ tempDir, {
							recursive: true,
							force: true,
						});
					}
					throw error;
				}
			} catch (error) {
				throwError(`Backup creation failed: ${error.message}`);
			}
		}),

	// List available backups
	listBackups: adminRoleProtectedRoute.query(async () => {
		try {
			const backupDir = BACKUP_DIRECTORY;

			if (!fs.existsSync(/* turbopackIgnore: true */ backupDir)) {
				return [];
			}

			const files = fs.readdirSync(/* turbopackIgnore: true */ backupDir);
			const backups = files
				.filter(isBackupFileName)
				.map((file) => {
					const filePath = path.join(/* turbopackIgnore: true */ backupDir, file);
					const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath);
					if (!stats.isFile()) return null;
					return {
						fileName: file,
						size: stats.size,
						created: stats.birthtime.toISOString(),
						modified: stats.mtime.toISOString(),
					};
				})
				.filter((backup): backup is NonNullable<typeof backup> => backup !== null)
				.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

			return backups;
		} catch (_error) {
			return [];
		}
	}),

	// Delete backup
	deleteBackup: adminRoleProtectedRoute
		.input(
			z.object({
				fileName: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const filePath = resolveBackupFile(input.fileName);

				if (fs.existsSync(/* turbopackIgnore: true */ filePath)) {
					fs.unlinkSync(/* turbopackIgnore: true */ filePath);
					return { success: true };
				}
				throwError("Backup file not found");
			} catch (error) {
				throwError(`Delete failed: ${error.message}`);
			}
		}),
	restoreBackup: adminRoleProtectedRoute
		.input(
			z
				.object({
					fileName: z.string(),
					restoreDatabase: z.boolean().default(true),
					restoreZerotier: z.boolean().default(true),
				})
				.refine((value) => value.restoreDatabase || value.restoreZerotier, {
					message: "Select at least one backup component to restore.",
				}),
		)
		.mutation(async ({ input }) => {
			let extractDir: string | undefined;
			try {
				const backupDir = BACKUP_DIRECTORY;
				const backupPath = resolveBackupFile(input.fileName);
				extractDir = path.join(
					/* turbopackIgnore: true */ backupDir,
					"extract",
					`${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`,
				);

				if (
					!fs
						.lstatSync(/* turbopackIgnore: true */ backupPath, {
							throwIfNoEntry: false,
						})
						?.isFile()
				) {
					throwError("Backup file not found");
				}

				try {
					await extractBackupArchive(backupPath, extractDir);
				} catch (extractError) {
					throw new Error(`Failed to extract backup: ${extractError.message}`);
				}

				const metadataPath = path.join(
					/* turbopackIgnore: true */ extractDir,
					"backup_metadata.json",
				);
				let metadata: BackupMetadata;
				try {
					metadata = JSON.parse(
						fs.readFileSync(/* turbopackIgnore: true */ metadataPath, "utf8"),
					);
				} catch {
					throw new Error("Backup metadata is missing or invalid");
				}
				if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
					throw new Error("Backup metadata is invalid");
				}

				const sqlDumpPath = path.join(
					/* turbopackIgnore: true */ extractDir,
					"database_dump.sql",
				);
				const ztBackupPath = path.join(
					/* turbopackIgnore: true */ extractDir,
					"zerotier",
				);
				if (input.restoreDatabase) {
					const dumpStats = fs.statSync(/* turbopackIgnore: true */ sqlDumpPath, {
						throwIfNoEntry: false,
					});
					if (!dumpStats?.isFile() || dumpStats.size === 0) {
						throw new Error("This backup does not contain a database dump");
					}
				}
				if (input.restoreZerotier) {
					if (
						!fs
							.statSync(/* turbopackIgnore: true */ ztBackupPath, {
								throwIfNoEntry: false,
							})
							?.isDirectory()
					) {
						throw new Error("This backup does not contain a ZeroTier folder");
					}
					if (isRunningInDocker()) {
						throw new Error(
							"ZeroTier restore is not available while running in Docker. Stop the ztnet and zerotier services and follow the documented offline restore procedure.",
						);
					}
				}

				let rollbackZeroTier: (() => void) | undefined;
				if (input.restoreZerotier) {
					rollbackZeroTier = installStandaloneZeroTierBackup(ztBackupPath);
				}

				try {
					if (input.restoreDatabase) {
						const connection = getPostgresConnection();
						execFileSync(
							"psql",
							[
								...connection.args,
								"--set",
								"ON_ERROR_STOP=on",
								"--single-transaction",
								"--file",
								sqlDumpPath,
							],
							{
								env: connection.env,
								stdio: ["ignore", "ignore", "inherit"],
								timeout: 30 * 60 * 1000,
							},
						);
					}
				} catch (error) {
					if (rollbackZeroTier) rollbackZeroTier();
					throw error;
				}

				return {
					success: true,
					metadata,
					restoredDatabase: input.restoreDatabase,
					restoredZerotier: input.restoreZerotier,
				};
			} catch (mainError) {
				throwError(`Restore failed: ${mainError.message}`);
			} finally {
				if (extractDir) {
					fs.rmSync(/* turbopackIgnore: true */ extractDir, {
						recursive: true,
						force: true,
					});
				}
			}
		}),
});
