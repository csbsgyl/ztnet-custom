import type { NextApiRequest, NextApiResponse } from "next";
import { verifyAlipayNotification } from "~/server/billing/alipay";
import { getAlipayRuntimeConfig } from "~/server/billing/config";
import { processVerifiedAlipayPayment } from "~/server/billing/payment";
import { prisma } from "~/server/db";

export const config = {
	api: {
		bodyParser: false,
	},
};

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > 1024 * 1024) throw new Error("Alipay notification is too large.");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export default async function alipayNotify(req: NextApiRequest, res: NextApiResponse) {
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).send("failure");
	}
	const contentType = req.headers["content-type"];
	if (
		typeof contentType !== "string" ||
		contentType.split(";", 1)[0]?.trim().toLowerCase() !==
			"application/x-www-form-urlencoded"
	) {
		return res.status(415).send("failure");
	}

	try {
		const rawBody = await readRawBody(req);
		const rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
		const parameters = new URLSearchParams(rawText);
		const merchantOrderNo = parameters.get("out_trade_no");
		if (!merchantOrderNo) throw new Error("Alipay notification has no order number.");

		const [options, order] = await Promise.all([
			prisma.globalOptions.findUnique({ where: { id: 1 } }),
			prisma.billingOrder.findUnique({ where: { merchantOrderNo } }),
		]);
		if (!order) throw new Error("Alipay notification references an unknown order.");
		if (order.source !== "SELF_SERVICE") {
			throw new Error("Manual orders cannot be fulfilled by Alipay.");
		}
		const runtime = getAlipayRuntimeConfig(options, { requireEnabled: false });
		const verified = verifyAlipayNotification({
			payload: rawText,
			alipayPublicKey: runtime.alipayPublicKey,
			expected: {
				appId: runtime.appId,
				sellerId: runtime.sellerId,
				merchantOrderNo: order.merchantOrderNo,
				amountCents: order.amountCents,
			},
		});
		await processVerifiedAlipayPayment(prisma, { ...verified.payload });
		return res.status(200).send("success");
	} catch (error) {
		console.error(
			"Alipay notification rejected:",
			error instanceof Error ? error.message : "Unknown error",
		);
		return res.status(400).send("failure");
	}
}
