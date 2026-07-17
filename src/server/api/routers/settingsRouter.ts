import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import type { GlobalOptions } from "@prisma/client";

type SettingsOptionsResponse = Omit<
	GlobalOptions,
	"smtpPassword" | "alipayPrivateKeyEncrypted" | "alipayPublicKey"
> & {
	smtpPassword: null;
	hasSmtpPassword: boolean;
	hasAlipayPublicKey: boolean;
	hasAlipayPrivateKey: boolean;
	planetDownloadAvailable: boolean;
};

export const settingsRouter = createTRPCRouter({
	// Set global options
	getAllOptions: protectedProcedure.query(
		async ({ ctx }): Promise<SettingsOptionsResponse | null> => {
			const options = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
				include: {
					planet: {
						select: {
							origin: true,
							downloadSha256: true,
						},
					},
				},
			});
			// Never send actual password to client - only indicate if one exists
			if (options) {
				const {
					smtpPassword,
					alipayPrivateKeyEncrypted,
					alipayPublicKey,
					planet,
					...publicOptions
				} = options;
				return {
					...publicOptions,
					smtpPassword: null,
					hasSmtpPassword: Boolean(smtpPassword),
					hasAlipayPublicKey: Boolean(alipayPublicKey),
					hasAlipayPrivateKey: Boolean(alipayPrivateKeyEncrypted),
					planetDownloadAvailable:
						options.customPlanetUsed === true &&
						planet?.origin === "LOCAL_GENERATED" &&
						Boolean(planet.downloadSha256),
				};
			}
			return null;
		},
	),
	getPublicOptions: publicProcedure.query(async ({ ctx }) => {
		const publicOptions = await ctx.prisma.globalOptions.findFirst({
			where: {
				id: 1,
			},
			select: {
				siteName: true,
			},
		});

		return publicOptions;
	}),
	getAdminOptions: protectedProcedure.query(async ({ ctx }) => {
		const options = await ctx.prisma.globalOptions.findFirst({
			where: {
				id: 1,
			},
			select: {
				enableRegistration: true,
			},
		});

		const oauthExclusiveLogin =
			process.env.OAUTH_EXCLUSIVE_LOGIN?.toLowerCase() === "true";
		const oauthAllowNewUsers =
			process.env.OAUTH_ALLOW_NEW_USERS?.toLowerCase() !== "false";

		return {
			...options,
			oauthExclusiveLogin,
			oauthAllowNewUsers,
		};
	}),
});
