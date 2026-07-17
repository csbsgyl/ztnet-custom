import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
	//   protectedProcedure,
} from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { throwError } from "~/server/helpers/errorHandler";
import jwt from "jsonwebtoken";
import { sendMailWithTemplate } from "~/utils/mail";
import * as ztController from "~/utils/ztApi";
import {
	API_TOKEN_SECRET,
	PASSWORD_RESET_SECRET,
	VERIFY_EMAIL_SECRET,
	encrypt,
	generateInstanceSecret,
	hashApiToken,
} from "~/utils/encryption";
import { isRunningInDocker } from "~/utils/docker";
import { Invitation, Prisma } from "@prisma/client";
import { validateOrganizationToken } from "../services/organizationAuthService";
import rateLimit from "~/utils/rateLimit";
import { ErrorCode } from "~/utils/errorCode";
import { MailTemplateKey } from "~/utils/enums";
import { mediumPassword, passwordSchema } from "./_schema";
import { upsertCredentialAccount } from "~/server/api/services/credentialAccountService";
import { DEVICE_SALT_COOKIE_NAME } from "~/utils/devices";
import { normalizeEmail } from "~/utils/email";

// Rate limit configuration from environment variables
// RATE_LIMIT_WINDOW: Time window in minutes (default: 10 minutes)
// RATE_LIMIT_MAX_REQUESTS: Max requests for general operations (default: 60)
// RATE_LIMIT_MAX_REQUESTS_SHORT: Max requests for sensitive operations (default: 5)
const RATE_LIMIT_WINDOW_MS =
	(Number.parseInt(process.env.RATE_LIMIT_WINDOW || "10", 10) || 10) * 60 * 1000;
const GENERAL_REQUEST_LIMIT =
	Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10) || 60;
const SHORT_REQUEST_LIMIT =
	Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_SHORT || "10", 10) || 10;

const limiter = rateLimit({
	interval: RATE_LIMIT_WINDOW_MS,
	uniqueTokenPerInterval: 1000,
});

// Rate limit tokens - each endpoint should have its own token to prevent
// different operations from consuming each other's rate limits
const RATE_LIMIT_TOKENS = {
	REGISTER_USER: "REGISTER_USER",
	VALIDATE_RESET_TOKEN: "VALIDATE_RESET_TOKEN",
	PASSWORD_RESET_LINK: "PASSWORD_RESET_LINK",
	CHANGE_PASSWORD: "CHANGE_PASSWORD",
	SEND_EMAIL_VERIFICATION: "SEND_EMAIL_VERIFICATION",
	EMAIL_VERIFICATION_LINK: "EMAIL_VERIFICATION_LINK",
} as const;

type PasswordResetPayload = {
	id: string;
	email: string;
	passwordFingerprint: string;
};

function passwordFingerprint(hash: string | null | undefined): string {
	return createHash("sha256")
		.update(hash || "", "utf8")
		.digest("hex");
}

function fingerprintMatches(actual: string | undefined, expected: string): boolean {
	if (!actual || !/^[a-f0-9]{64}$/.test(actual)) return false;
	return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export const authRouter = createTRPCRouter({
	register: publicProcedure
		.input(
			z.object({
				email: z.string().email().transform(normalizeEmail),
				password: passwordSchema("password does not meet the requirements!"),
				name: z.string().min(3, "Name must contain at least 3 character(s)").max(40),
				expiresAt: z.string().optional(),
				ztnetInvitationCode: z.string().optional(),
				ztnetOrganizationToken: z.string().optional(),
				token: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// add rate limit
			try {
				await limiter.check(
					ctx.res,
					GENERAL_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.REGISTER_USER,
					input.email,
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded",
				});
			}

			const {
				email,
				password,
				name,
				ztnetInvitationCode,
				ztnetOrganizationToken,
				token,
				expiresAt,
			} = input;
			const settings = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});

			// Validate the organization token if it exists
			const decryptedOrgToken = await validateOrganizationToken(
				ztnetOrganizationToken,
				email,
			);
			const siteInviteToken = token?.trim();
			const siteInviteSecret = ztnetInvitationCode?.trim();
			if (
				(siteInviteToken && !siteInviteSecret) ||
				(!siteInviteToken && siteInviteSecret)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Both the invitation link and code are required.",
				});
			}
			if (siteInviteToken) {
				try {
					jwt.verify(siteInviteToken, process.env.NEXTAUTH_SECRET);
				} catch {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Invitation has expired or is invalid",
					});
				}
			}

			if (!mediumPassword.test(password)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Password does not meet the requirements!",
				});
			}
			const hash = bcrypt.hashSync(password, 10);

			const registerWithTransaction = async (transaction: Prisma.TransactionClient) => {
				// Registration volume is low. Serializing it makes first-admin assignment,
				// invitation consumption, and user creation one atomic decision.
				await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ztnet-user-registration"}))`;

				let invitation: Invitation | null = null;
				if (siteInviteToken && siteInviteSecret) {
					invitation = await transaction.invitation.findUnique({
						where: { token: siteInviteToken, secret: siteInviteSecret },
					});
					if (
						!invitation ||
						invitation.used ||
						invitation.timesUsed >= invitation.timesCanUse ||
						invitation.expiresAt.getTime() <= Date.now()
					) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Invitation has expired or is invalid",
						});
					}
				}

				if (settings?.enableRegistration !== true && !invitation && !decryptedOrgToken) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Registration is disabled! Please contact the administrator.",
					});
				}

				const registerUser = await transaction.user.findFirst({
					where: { email: { equals: email, mode: "insensitive" } },
					select: { id: true },
				});
				if (registerUser) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `email "${email}" already taken`,
					});
				}

				const [userCount, defaultUserGroup] = await Promise.all([
					transaction.user.count(),
					transaction.userGroup.findFirst({ where: { isDefault: true } }),
				]);
				const configuredAdminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim();
				if (
					userCount === 0 &&
					configuredAdminEmail &&
					email !== normalizeEmail(configuredAdminEmail)
				) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "initial_admin_setup_required",
					});
				}
				const created = await transaction.user.create({
					data: {
						name,
						email,
						expiresAt,
						lastLogin: new Date(),
						role: userCount === 0 ? "ADMIN" : "USER",
						hash,
						...(invitation?.groupId
							? {
									userGroup: {
										connect: { id: Number.parseInt(invitation.groupId, 10) },
									},
								}
							: defaultUserGroup
								? { userGroup: { connect: { id: defaultUserGroup.id } } }
								: {}),
						organizationRoles: decryptedOrgToken
							? {
									create: {
										organizationId: decryptedOrgToken.organizationId,
										role: decryptedOrgToken.invitation.role,
									},
								}
							: undefined,
						memberOfOrgs: decryptedOrgToken
							? { connect: { id: decryptedOrgToken.organizationId } }
							: undefined,
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
						expiresAt: true,
						role: true,
						memberOfOrgs: { select: { id: true, orgName: true } },
					},
				});

				await upsertCredentialAccount(created.id, hash, transaction);
				if (invitation) {
					await transaction.invitation.update({
						where: { id: invitation.id },
						data: {
							timesUsed: { increment: 1 },
							used: invitation.timesUsed + 1 >= invitation.timesCanUse,
						},
					});
				}
				if (decryptedOrgToken && ztnetOrganizationToken) {
					await transaction.activityLog.create({
						data: {
							action: `User ${created.name} has registered with email ${created.email} and has been added to the organization ${decryptedOrgToken.organizationId} with the role ${decryptedOrgToken.invitation.role}!`,
							performedById: decryptedOrgToken.invitation.invitedById,
							organizationId: decryptedOrgToken.organizationId,
						},
					});
					await transaction.invitation.delete({
						where: { token: ztnetOrganizationToken },
					});
				}
				return created;
			};
			const newUser =
				typeof ctx.prisma.$transaction === "function"
					? await ctx.prisma.$transaction(registerWithTransaction, {
							isolationLevel: "Serializable",
						})
					: await registerWithTransaction(
							ctx.prisma as unknown as Prisma.TransactionClient,
						);

			// Send admin notification
			if (settings?.userRegistrationNotification) {
				// A failed admin-notification email (e.g. misconfigured SMTP or a
				// secret mismatch) must never break the user's registration. Isolate
				// each recipient so one failure doesn't skip the other admins.
				try {
					const adminUsers = await ctx.prisma.user.findMany({
						where: {
							role: "ADMIN",
						},
					});

					for (const adminUser of adminUsers) {
						try {
							await sendMailWithTemplate(MailTemplateKey.Notification, {
								to: adminUser.email,
								userId: adminUser.id,
								templateData: {
									toName: adminUser.name,
									notificationMessage: `A new user with the name ${name} and email ${email} has just registered!`,
								},
							});
						} catch (e) {
							console.error(
								`Failed to send registration notification to admin ${adminUser.email}:`,
								e,
							);
						}
					}
				} catch (e) {
					console.error("Failed to load admins for registration notification:", e);
				}
			}
			return {
				user: newUser,
			};
		}),
	me: protectedProcedure.query(async ({ ctx }) => {
		const user = await ctx.prisma.user.findFirst({
			where: {
				id: ctx.session.user.id,
			},
			include: {
				options: true,
				memberOfOrgs: true,
				UserDevice: true,
			},
		});
		if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });

		const options =
			user.options ??
			(await ctx.prisma.userOptions.upsert({
				where: { userId: user.id },
				create: { userId: user.id },
				update: {},
			}));

		// Read current device ID from cookie for device identification.
		// Cookie name is preserved across the next-auth → better-auth migration on
		// purpose (see DEVICE_SALT_COOKIE_NAME); this lookup uses the constant so
		// the path through the codebase stays consistent.
		const cookieHeader = ctx.req?.headers?.cookie || "";
		const deviceCookie = cookieHeader
			.split(";")
			.find((c) => c.trim().startsWith(`${DEVICE_SALT_COOKIE_NAME}=`));
		const currentDeviceId = deviceCookie?.split("=")?.[1]?.trim() || undefined;

		const {
			hash: _hash,
			tempPassword: _tempPassword,
			twoFactorSecret: _twoFactorSecret,
			twoFactorRecoveryCodes: _twoFactorRecoveryCodes,
			failedLoginAttempts: _failedLoginAttempts,
			lastFailedLoginAttempt: _lastFailedLoginAttempt,
			options: _options,
			...safeUser
		} = user;
		const { ztCentralApiKey, localControllerSecret, ...safeOptions } = options;
		return {
			...safeUser,
			currentDeviceId,
			options: {
				...safeOptions,
				hasZtCentralApiKey: Boolean(ztCentralApiKey),
				hasLocalControllerSecret: Boolean(localControllerSecret),
				localControllerUrlPlaceholder: isRunningInDocker()
					? "http://zerotier:9993"
					: "http://127.0.0.1:9993",
				urlFromEnv: Boolean(process.env.ZT_ADDR),
				secretFromEnv: Boolean(process.env.ZT_SECRET),
			},
		};
	}),
	update: protectedProcedure
		.input(
			z.object({
				email: z.string().email().transform(normalizeEmail).optional(),
				password: z.string().optional(),
				newPassword: passwordSchema("New Password does not meet the requirements!")
					// passwordSchema is already optional; guard the trim so an omitted
					// field (e.g. updating only the name) doesn't call .trim() on undefined.
					.transform((val) => val?.trim())
					.optional(),
				repeatNewPassword: passwordSchema(
					"Repeat NewPassword does not meet the requirements!",
				)
					.transform((val) => val?.trim())
					.optional(),
				name: z.string().nonempty().max(40).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const user = await ctx.prisma.user.findFirst({
				where: {
					id: ctx.session.user.id,
				},
				include: {
					accounts: true,
				},
			});

			// validate
			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found!",
				});
			}

			if (input.newPassword || input.repeatNewPassword || input.password) {
				// User authenticates exclusively via OAuth when they have no local
				// password hash. We check `user.hash` directly — the previous form
				// (`user.accounts && !user.hash`) was always-truthy on the LHS because
				// `accounts` is an array, so the OAuth path was never gated on whether
				// the user actually had any OAuth account rows.
				const isOAuthUser = !user.hash;

				// For setting new password, all fields are required
				if (
					!input.newPassword ||
					!input.repeatNewPassword ||
					(!input.password && !isOAuthUser)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Please fill all required fields!",
					});
				}

				if (!mediumPassword.test(input.newPassword))
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Password does not meet the requirements!",
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});

				// check if old password is correct
				if (!isOAuthUser && !bcrypt.compareSync(input.password, user.hash)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Old password is incorrect!",
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});
				}
				// make sure both new passwords are the same
				if (input.newPassword !== input.repeatNewPassword) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Passwords do not match!",
						// optional: pass the original error to retain stack trace
						// cause: theError,
					});
				}
			}

			const newHash = input.newPassword ? bcrypt.hashSync(input.newPassword, 10) : null;

			// update user with new values
			await ctx.prisma.user.update({
				where: {
					id: user.id,
				},
				data: {
					email: input.email || user.email,
					name: input.name || user.name,
					hash: newHash ?? user.hash,
					// Clear the requestChangePassword flag when user changes password
					requestChangePassword: input.newPassword ? false : user.requestChangePassword,
				},
			});

			// Keep the better-auth credential Account row in sync. better-auth
			// authenticates against `Account.password` (not `User.hash`); without this
			// the user's next sign-in would silently fail with "invalid credentials".
			if (newHash) {
				await upsertCredentialAccount(user.id, newHash, ctx.prisma);
			}
		}),
	validateResetPasswordToken: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { token } = input;
			if (!token) return { error: ErrorCode.InvalidToken };
			try {
				const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
				const decoded = jwt.verify(token, secret) as PasswordResetPayload;

				// add rate limit
				try {
					await limiter.check(
						ctx.res,
						GENERAL_REQUEST_LIMIT,
						RATE_LIMIT_TOKENS.VALIDATE_RESET_TOKEN,
						token,
					);
				} catch {
					throw new TRPCError({
						code: "TOO_MANY_REQUESTS",
						message: "Rate limit exceeded",
					});
				}

				const user = await ctx.prisma.user.findFirst({
					where: {
						id: decoded.id,
						email: decoded.email,
					},
					select: { email: true, hash: true },
				});

				if (
					!user ||
					!fingerprintMatches(decoded.passwordFingerprint, passwordFingerprint(user.hash))
				) {
					return { error: ErrorCode.InvalidToken };
				}

				return { email: user.email };
			} catch (_error) {
				return { error: ErrorCode.InvalidToken };
			}
		}),
	passwordResetLink: publicProcedure
		.input(
			z.object({
				email: z
					.string({ error: "Email is required!" })
					.email()
					.transform(normalizeEmail),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { email } = input;
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.PASSWORD_RESET_LINK,
					email,
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded, please try again later",
				});
			}
			if (!email) throwError("Email is required!");

			const user = await ctx.prisma.user.findFirst({
				where: {
					email: {
						equals: email,
						mode: "insensitive",
					},
				},
			});

			const response = { message: "If the email exists, a reset link has been sent." };
			// Keep all existing-account-only work out of the public request path. The
			// caller gets the same response without waiting for SMTP or token creation.
			setImmediate(() => {
				if (!user) return;
				void Promise.resolve()
					.then(async () => {
						const deliveryUser =
							user.email === email
								? user
								: await ctx.prisma.user.update({
										where: { id: user.id },
										data: { email },
									});
						const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
						const validationToken = jwt.sign(
							{
								id: deliveryUser.id,
								email: deliveryUser.email,
								passwordFingerprint: passwordFingerprint(deliveryUser.hash),
							},
							secret,
							{ expiresIn: "15m" },
						);
						const resetLink = `${process.env.NEXTAUTH_URL}/auth/forgotPassword/reset?token=${validationToken}`;
						await sendMailWithTemplate(MailTemplateKey.ForgotPassword, {
							to: email,
							userId: deliveryUser.id,
							templateData: { toEmail: email, forgotLink: resetLink },
						});
					})
					.catch((error) => {
						console.error("Failed to send password reset email:", error);
					});
			});

			return response;
		}),

	changePasswordFromJwt: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
				password: passwordSchema("password does not meet the requirements!"),
				newPassword: passwordSchema("password does not meet the requirements!"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { token, password, newPassword } = input;
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.CHANGE_PASSWORD,
					token,
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded, please try again later",
				});
			}

			if (!token) throwError("token is required!");

			if (password !== newPassword) throwError("Passwords does not match!");

			try {
				const secret = generateInstanceSecret(PASSWORD_RESET_SECRET);
				const decoded = jwt.verify(token, secret) as PasswordResetPayload;
				const newHash = bcrypt.hashSync(password, 10);
				await ctx.prisma.$transaction(async (transaction) => {
					await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`password-reset:${decoded.id}`}))`;
					const user = await transaction.user.findFirst({
						where: {
							id: decoded.id,
							email: decoded.email,
						},
						select: { id: true, hash: true },
					});

					if (
						!user ||
						!fingerprintMatches(
							decoded.passwordFingerprint,
							passwordFingerprint(user.hash),
						)
					) {
						throwError("This link is not valid!");
					}

					await transaction.user.update({
						where: { id: user.id },
						data: { hash: newHash, requestChangePassword: false },
					});
					await upsertCredentialAccount(user.id, newHash, transaction);
					await transaction.session.deleteMany({ where: { userId: user.id } });
					await transaction.aPIToken.updateMany({
						where: { userId: user.id, isActive: true },
						data: { isActive: false },
					});
				});

				return { success: true };
			} catch (error) {
				console.error(error);
				throwError("token is not valid, please try again!");
			}
		}),
	sendVerificationEmail: protectedProcedure.mutation(async ({ ctx }) => {
		// add cooldown to prevent spam
		try {
			await limiter.check(
				ctx.res,
				SHORT_REQUEST_LIMIT,
				RATE_LIMIT_TOKENS.SEND_EMAIL_VERIFICATION,
				ctx.session.user.id,
			);
		} catch {
			throw new TRPCError({
				code: "TOO_MANY_REQUESTS",
				message: "Rate limit exceeded",
			});
		}
		const user = await ctx.prisma.user.findFirst({
			where: {
				id: ctx.session.user.id,
			},
		});

		if (!user) return { message: "Internal Error" };
		if (user.emailVerified) return { message: "Email is already verified!" };

		const secret = generateInstanceSecret(VERIFY_EMAIL_SECRET);
		const validationToken = jwt.sign(
			{
				id: user.id,
				email: user.email,
			},
			secret,
			{
				expiresIn: "15m",
			},
		);

		const verifyLink = `${process.env.NEXTAUTH_URL}/auth/verifyEmail?token=${validationToken}`;
		// Send email
		try {
			await sendMailWithTemplate(MailTemplateKey.VerifyEmail, {
				to: user.email,
				userId: user.id,
				templateData: {
					toName: user.name,
					verifyLink: verifyLink,
				},
			});
		} catch (error) {
			console.error("Failed to send verification email:", error);
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: error.message,
			});
		}

		return { message: "Verification link has been sent." };
	}),
	validateEmailVerificationToken: publicProcedure
		.input(
			z.object({
				token: z.string({ error: "Token is required!" }),
			}),
		)
		.query(async ({ ctx, input }) => {
			// add rate limit
			try {
				await limiter.check(
					ctx.res,
					SHORT_REQUEST_LIMIT,
					RATE_LIMIT_TOKENS.EMAIL_VERIFICATION_LINK,
					input.token,
				);
			} catch {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Rate limit exceeded",
				});
			}

			const { token } = input;
			if (!token) return { error: ErrorCode.InvalidToken };
			try {
				const secret = generateInstanceSecret(VERIFY_EMAIL_SECRET);
				const decoded = jwt.verify(token, secret) as { id: string; email: string };

				const user = await ctx.prisma.user.findFirst({
					where: {
						id: decoded.id,
						email: decoded.email,
					},
				});

				if (!user || user.emailVerified) return { error: ErrorCode.InvalidToken };

				// set emailVerified to true
				await ctx.prisma.user.update({
					where: {
						id: user.id,
					},
					data: {
						emailVerified: true,
					},
				});
				return { message: "Email verified successfully!" };
			} catch (_error) {
				return { error: ErrorCode.InvalidToken };
			}
		}),
	/**
	 * Update the specified NetworkMemberNotation instance.
	 *
	 * This protectedProcedure takes an input of object type with properties: notationId, nodeid,
	 * useAsTableBackground, and showMarkerInTable. It updates the fields showMarkerInTable and
	 * useAsTableBackground in the NetworkMemberNotation model for the specified notationId and nodeid.
	 *
	 * @input An object with properties:
	 * - notationId: a number representing the unique ID of the notation
	 * - nodeid: a number representing the ID of the node to which the notation is linked
	 * - useAsTableBackground: an optional boolean that determines whether the notation is used as a background in the table
	 * - showMarkerInTable: an optional boolean that determines whether to show a marker in the table for the notation
	 * @returns A Promise that resolves with the updated NetworkMemberNotation instance.
	 */
	updateUserOptions: protectedProcedure
		.input(
			z.object({
				useNotationColorAsBg: z.boolean().optional(),
				showNotationMarkerInTableRow: z.boolean().optional(),
				deAuthorizeWarning: z.boolean().optional(),
				addMemberIdAsName: z.boolean().optional(),
				renameNodeGlobally: z.boolean().optional(),
				newDeviceNotification: z.boolean().optional(),
				deviceIpChangeNotification: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await ctx.prisma.user.update({
				where: { id: ctx.session.user.id },
				data: {
					options: {
						upsert: {
							create: input,
							update: input,
						},
					},
				},
				select: { id: true },
			});
			return { status: "success" as const };
		}),
	setZtApi: protectedProcedure
		.input(
			z.object({
				ztCentralApiKey: z.string().optional(),
				ztCentralApiUrl: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// we use upsert in case the user has no options yet
			const updated = await ctx.prisma.user.update({
				where: {
					id: ctx.session.user.id,
				},
				data: {
					options: {
						upsert: {
							create: {
								ztCentralApiKey: input.ztCentralApiKey,
								ztCentralApiUrl: input.ztCentralApiUrl,
							},
							update: {
								ztCentralApiKey: input.ztCentralApiKey,
								ztCentralApiUrl: input.ztCentralApiUrl,
							},
						},
					},
				},
				select: {
					options: { select: { ztCentralApiKey: true } },
				},
			});

			if (updated.options?.ztCentralApiKey) {
				try {
					await ztController.ping_api({ ctx });
					return { status: "success" };
				} catch (error) {
					throw new TRPCError({
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
						message: error.message,
						code: "FORBIDDEN",
					});
				}
			}

			return { status: "success" as const };
		}),
	setLocalZt: protectedProcedure
		.input(
			z.object({
				localControllerUrl: z.string().optional(),
				localControllerSecret: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (input?.localControllerUrl && process.env.ZT_ADDR) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Remove the ZT_ADDR environment variable to use this feature!",
				});
			}

			const defaultLocalZtUrl = isRunningInDocker()
				? "http://zerotier:9993"
				: "http://127.0.0.1:9993";

			// we use upsert in case the user has no options yet
			const normalizedLocalControllerUrl = input.localControllerUrl?.trim();
			await ctx.prisma.user.update({
				where: {
					id: ctx.session.user.id,
				},
				data: {
					options: {
						upsert: {
							create: {
								localControllerUrl: normalizedLocalControllerUrl || defaultLocalZtUrl,
								...(input.localControllerSecret !== undefined
									? { localControllerSecret: input.localControllerSecret }
									: {}),
							},
							update: {
								...(input.localControllerUrl !== undefined
									? {
											localControllerUrl:
												normalizedLocalControllerUrl || defaultLocalZtUrl,
										}
									: {}),
								...(input.localControllerSecret !== undefined
									? { localControllerSecret: input.localControllerSecret }
									: {}),
							},
						},
					},
				},
				select: { id: true },
			});

			return { status: "success" as const };
		}),
	getApiToken: protectedProcedure.query(async ({ ctx }) => {
		const tokens = await ctx.prisma.aPIToken.findMany({
			where: {
				userId: ctx.session.user.id,
			},
			orderBy: {
				createdAt: "asc",
			},
			select: {
				id: true,
				name: true,
				apiAuthorizationType: true,
				createdAt: true,
				expiresAt: true,
				isActive: true,
			},
		});

		const now = new Date();
		for (const token of tokens) {
			if (token.expiresAt && token.expiresAt <= now && token.isActive) {
				await ctx.prisma.aPIToken.update({
					where: {
						id: token.id,
					},
					data: {
						isActive: false,
					},
				});
				token.isActive = false;
			}
		}
		return tokens;
	}),
	addApiToken: protectedProcedure
		.input(
			z.object({
				name: z.string().min(3).max(50),
				daysToExpire: z.string(),
				apiAuthorizationType: z.array(z.enum(["PERSONAL", "ORGANIZATION"])),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// generate daysToExpire date. If "never" is selected or an empty string, the token will never expire.
				const daysToExpire = parseInt(input.daysToExpire);
				let expiresAt: Date | null = new Date();
				if (!Number.isNaN(daysToExpire) && daysToExpire > 0) {
					expiresAt.setDate(expiresAt.getDate() + daysToExpire);
				} else {
					expiresAt = null; // Token never expires
				}

				const createToken = async (transaction: Prisma.TransactionClient) => {
					const tokenContent = JSON.stringify({
						userId: ctx.session.user.id,
						apiAuthorizationType: input.apiAuthorizationType,
					});
					const placeholder = encrypt(
						tokenContent,
						generateInstanceSecret(API_TOKEN_SECRET),
					);
					const token = await transaction.aPIToken.create({
						data: {
							token: hashApiToken(placeholder),
							name: input.name,
							apiAuthorizationType: input.apiAuthorizationType,
							userId: ctx.session.user.id,
							expiresAt,
						},
					});

					const bearerToken = encrypt(
						JSON.stringify({
							...JSON.parse(tokenContent),
							tokenId: token.id.toString(),
						}),
						generateInstanceSecret(API_TOKEN_SECRET),
					);
					const updatedToken = await transaction.aPIToken.update({
						where: { id: token.id },
						data: { token: hashApiToken(bearerToken) },
					});

					return { ...updatedToken, token: bearerToken };
				};

				return typeof ctx.prisma.$transaction === "function"
					? await ctx.prisma.$transaction(createToken)
					: await createToken(ctx.prisma as unknown as Prisma.TransactionClient);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error.message,
				});
			}
		}),

	deleteApiToken: protectedProcedure
		.input(
			z.object({
				id: z.union([z.string(), z.number()]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await ctx.prisma.aPIToken.delete({
				where: {
					id: input.id.toString(),
					userId: ctx.session.user.id,
				},
				select: { id: true },
			});
			return { status: "success" as const };
		}),
	deleteUserDevice: protectedProcedure
		.input(
			z.object({
				deviceId: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Verify the device belongs to the current user before deleting
			const device = await ctx.prisma.userDevice.findUnique({
				where: {
					deviceId: input.deviceId,
				},
				select: { userId: true },
			});

			if (!device || device.userId !== ctx.session.user.id) {
				throw new Error("Device not found or you do not have permission to delete it.");
			}

			await ctx.prisma.userDevice.delete({
				where: {
					deviceId: input.deviceId,
				},
			});

			return input.deviceId;
		}),
});
