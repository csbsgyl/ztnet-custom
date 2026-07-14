import { uniqueNamesGenerator } from "unique-names-generator";
import { throwError } from "~/server/helpers/errorHandler";
import { type Config, adjectives, animals } from "unique-names-generator";
import { IPv4gen } from "~/utils/IPv4gen";
import * as ztController from "~/utils/ztApi";
import {
	EntitlementError,
	consumeNetworkQuotaReservation,
	releaseNetworkQuotaReservation,
	reserveNetworkQuota,
} from "~/server/billing/entitlements";

/**
 * Configuration object for new network name.
 */
export const nameGeneratorConfig: Config = {
	dictionaries: [adjectives, animals],
	separator: "-",
	length: 2,
};

/**
 * Creates a network service.
 * @param {Object} ctx - The context object.
 * @param {Object} input - The input object.
 * @returns {Promise<Object>} - The created network service.
 * @throws {EntitlementError} - If the account is inactive or has no personal network quota.
 * @throws {Error} - If an error occurs while creating the network service.
 */
export const networkProvisioningFactory = async ({ ctx, input }) => {
	const userId = ctx.session.user.id;
	let quotaReservationId: string | null = null;
	try {
		if (!input.central) {
			const reservation = await reserveNetworkQuota({ prisma: ctx.prisma }, userId);
			quotaReservationId = reservation.id;
		}

		// get used IPs from the database
		const usedCidr = await ctx.prisma.network.findMany({
			where: {
				authorId: userId,
				organizationId: null,
			},
			select: {
				routes: true,
			},
		});
		// Extract the target from the routes
		const usedIPs = usedCidr.map((nw) => nw.routes?.map((r) => r.target));

		// Flatten the array
		// Generate ipv4 address, cidr, start & end
		const ipAssignmentPools = IPv4gen(null, usedIPs, input.central);

		if (!input?.name) {
			// Generate adjective and noun word
			input.name = uniqueNamesGenerator(nameGeneratorConfig);
		}

		// Create ZT network
		const newNw = await ztController.network_create(
			ctx,
			input.name,
			ipAssignmentPools,
			input.central,
		);

		if (input.central) return newNw;

		const storeNetwork = (database) =>
			database.user.update({
				where: {
					id: userId,
				},
				data: {
					network: {
						create: {
							name: newNw.name,
							nwid: newNw.nwid,
							routes: {
								create: ipAssignmentPools.routes.map((route) => ({
									target: route.target,
									via: route.via,
								})),
							},
						},
					},
				},
				select: {
					network: true,
				},
			});

		if (quotaReservationId) {
			await consumeNetworkQuotaReservation(
				{ prisma: ctx.prisma },
				userId,
				quotaReservationId,
				storeNetwork,
			);
			quotaReservationId = null;
		} else {
			await storeNetwork(ctx.prisma);
		}
		return newNw;
	} catch (err: unknown) {
		if (err instanceof EntitlementError) {
			throwError(
				err.message,
				err.code === "NETWORK_LIMIT_REACHED" ? "PRECONDITION_FAILED" : "FORBIDDEN",
				err,
			);
		} else if (err instanceof Error) {
			console.error(err);
			throwError("Could not create network! Please try again");
		} else {
			throwError("An unknown error occurred");
		}
	} finally {
		if (quotaReservationId) {
			try {
				await releaseNetworkQuotaReservation(ctx.prisma, quotaReservationId);
			} catch (error) {
				// The reservation expires automatically and the minute job removes it.
				console.error("Failed to release network quota reservation:", error);
			}
		}
	}
};
