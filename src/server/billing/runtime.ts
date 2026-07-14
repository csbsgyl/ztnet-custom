import type { PrismaClient } from "@prisma/client";
import type { ControllerUpdateInput, SuspensionPrisma } from "./suspension";
import { restoreSubscriptionExpiredUser } from "./suspension";
import * as ztController from "~/utils/ztApi";
import { markOrderFulfilled } from "./service";
import { applyPaidOrder } from "./orders";

export function getBillingBaseUrl(): string {
	const configured = process.env.NEXTAUTH_URL?.trim();
	if (!configured) throw new Error("NEXTAUTH_URL is required for Alipay callbacks.");
	const url = new URL(configured);
	url.pathname = url.pathname.replace(/\/$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export function getAlipayCallbackUrls(orderId?: string) {
	const baseUrl = getBillingBaseUrl();
	return {
		notifyUrl: `${baseUrl}/api/billing/alipay/notify`,
		returnUrl: orderId
			? `${baseUrl}/billing/return?orderId=${encodeURIComponent(orderId)}`
			: `${baseUrl}/billing/return`,
	};
}

export async function updatePersonalNetworkMember(
	prisma: PrismaClient,
	{ userId, networkId, memberId, authorized }: ControllerUpdateInput,
): Promise<void> {
	const context = {
		session: { user: { id: userId } },
		prisma,
	};
	await ztController.member_update({
		ctx: context as never,
		nwid: networkId,
		memberId,
		central: false,
		updateParams: { authorized },
	});
	await prisma.network_members.updateMany({
		where: { id: memberId, nwid: networkId },
		data: { authorized },
	});
}

export async function fulfilPaidOrder(prisma: PrismaClient, merchantOrderNo: string) {
	const order = await prisma.billingOrder.findUniqueOrThrow({
		where: { merchantOrderNo },
		select: { id: true, userId: true, status: true },
	});
	if (order.status === "FULFILLED") return order;
	if (order.status !== "PAID") {
		throw new Error("Only a paid billing order can be fulfilled.");
	}
	try {
		await prisma.$transaction(
			async (transaction) => {
				await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${merchantOrderNo}))`;
				await applyPaidOrder(transaction, merchantOrderNo);
			},
			{ isolationLevel: "Serializable" },
		);
	} catch (error) {
		const failureReason =
			error instanceof Error ? error.message : "Could not apply paid entitlement.";
		await prisma.billingOrder.update({
			where: { id: order.id },
			data: { failureReason },
		});
		throw error;
	}

	const restoration = await restoreSubscriptionExpiredUser(
		{
			prisma: prisma as unknown as SuspensionPrisma,
			controllerUpdate: (input) => updatePersonalNetworkMember(prisma, input),
		},
		order.userId,
	);
	if (
		restoration.state === "PARTIAL_FAILURE" ||
		restoration.state === "SKIPPED_NOT_FOUND" ||
		restoration.state === "SKIPPED_NO_ACTIVE_SUBSCRIPTION"
	) {
		const failureReason = `Subscription restoration incomplete: ${restoration.state}`;
		await prisma.billingOrder.update({
			where: { id: order.id },
			data: { failureReason },
		});
		throw new Error(failureReason);
	}

	return markOrderFulfilled(prisma, merchantOrderNo);
}
