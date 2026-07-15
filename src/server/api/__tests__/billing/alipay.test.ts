import {
	constants,
	generateKeyPairSync,
	sign as rsaSign,
	verify as rsaVerify,
	type KeyObject,
} from "node:crypto";
import {
	canonicalizeParameters,
	buildPagePayUrl,
	type AlipayErrorCode,
	signContent,
	verifyAlipayNotification,
	verifyContentSignature,
} from "~/server/billing/alipay";

const APP_ID = "2026071400000001";
const SELLER_ID = "2088000000000001";
const MERCHANT_ORDER_NO = "ZT202607140001";
const AMOUNT_CENTS = 12_345;

let privateKey: KeyObject;
let publicKey: KeyObject;

beforeAll(() => {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	privateKey = keys.privateKey;
	publicKey = keys.publicKey;
});

function createRsa2Signature(content: string): string {
	return rsaSign("RSA-SHA256", Buffer.from(content, "utf8"), {
		key: privateKey,
		padding: constants.RSA_PKCS1_PADDING,
	}).toString("base64");
}

function buildSignedNotification(
	overrides: Readonly<Record<string, string>> = {},
): string {
	const parameters: Record<string, string> = {
		notify_time: "2026-07-14 16:00:00",
		notify_type: "trade_status_sync",
		notify_id: "notify-1",
		app_id: APP_ID,
		auth_app_id: APP_ID,
		seller_id: SELLER_ID,
		out_trade_no: MERCHANT_ORDER_NO,
		trade_no: "2026071422000000000001",
		trade_status: "TRADE_SUCCESS",
		total_amount: "123.45",
		gmt_payment: "2026-07-14 15:59:58",
		sign_type: "RSA2",
		...overrides,
	};
	const content = canonicalizeParameters(parameters, {
		exclude: ["sign", "sign_type"],
	});
	parameters.sign = createRsa2Signature(content);
	return new URLSearchParams(parameters).toString();
}

function verifyNotification(body: string) {
	return verifyAlipayNotification({
		payload: body,
		alipayPublicKey: publicKey,
		expected: {
			appId: APP_ID,
			sellerId: SELLER_ID,
			merchantOrderNo: MERCHANT_ORDER_NO,
			amountCents: AMOUNT_CENTS,
		},
	});
}

function expectProtocolError(run: () => unknown, code: AlipayErrorCode): void {
	try {
		run();
		throw new Error("Expected Alipay verification to fail.");
	} catch (error) {
		expect(error).toMatchObject({
			name: "AlipayProtocolError",
			code,
		});
	}
}

describe("Alipay RSA2 protocol", () => {
	test("accepts the RSA key encodings commonly exported by Alipay tools", () => {
		const privateKeys = [
			privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
			privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
			privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
			privateKey.export({ format: "der", type: "pkcs1" }).toString("base64"),
		];
		const publicKeys = [
			publicKey.export({ format: "pem", type: "spki" }).toString(),
			publicKey.export({ format: "pem", type: "pkcs1" }).toString(),
			publicKey.export({ format: "der", type: "spki" }).toString("base64"),
			publicKey.export({ format: "der", type: "pkcs1" }).toString("base64"),
		];

		for (const merchantPrivateKey of privateKeys) {
			const signature = signContent("ztnet-key-check", merchantPrivateKey);
			expect(verifyContentSignature("ztnet-key-check", signature, publicKey)).toBe(true);
		}
		for (const alipayPublicKey of publicKeys) {
			const signature = createRsa2Signature("ztnet-key-check");
			expect(verifyContentSignature("ztnet-key-check", signature, alipayPublicKey)).toBe(
				true,
			);
		}
	});

	test("builds a page-pay URL whose parameters have a real RSA2 signature", () => {
		const paymentUrl = buildPagePayUrl({
			appId: APP_ID,
			privateKey,
			gateway: "https://alipay.example.test/gateway.do",
			merchantOrderNo: MERCHANT_ORDER_NO,
			amountCents: AMOUNT_CENTS,
			subject: "ZTNET Pro",
			notifyUrl: "https://merchant.example.test/api/billing/alipay/notify",
			returnUrl: "https://merchant.example.test/billing/return?orderId=order-1",
			timestamp: new Date("2026-07-14T08:09:10.000Z"),
		});

		const url = new URL(paymentUrl);
		const { sign: signature, ...parameters } = Object.fromEntries(
			url.searchParams.entries(),
		);
		if (!signature) throw new Error("Page-pay URL did not contain a signature.");

		expect(`${url.origin}${url.pathname}`).toBe("https://alipay.example.test/gateway.do");
		expect(parameters).toMatchObject({
			app_id: APP_ID,
			method: "alipay.trade.page.pay",
			sign_type: "RSA2",
			timestamp: "2026-07-14 16:09:10",
			notify_url: "https://merchant.example.test/api/billing/alipay/notify",
			return_url: "https://merchant.example.test/billing/return?orderId=order-1",
		});
		expect(JSON.parse(parameters.biz_content ?? "{}")).toEqual({
			out_trade_no: MERCHANT_ORDER_NO,
			product_code: "FAST_INSTANT_TRADE_PAY",
			total_amount: "123.45",
			subject: "ZTNET Pro",
		});

		const content = canonicalizeParameters(parameters);
		expect(
			rsaVerify(
				"RSA-SHA256",
				Buffer.from(content, "utf8"),
				{ key: publicKey, padding: constants.RSA_PKCS1_PADDING },
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
	});

	test("verifies a genuine RSA2 asynchronous notification", () => {
		const verified = verifyNotification(buildSignedNotification());

		expect(verified).toMatchObject({
			appId: APP_ID,
			sellerId: SELLER_ID,
			merchantOrderNo: MERCHANT_ORDER_NO,
			alipayTradeNo: "2026071422000000000001",
			amountCents: AMOUNT_CENTS,
			tradeStatus: "TRADE_SUCCESS",
			notifyId: "notify-1",
		});
	});

	test("rejects a browser return_url payload even when it has a valid signature", () => {
		expectProtocolError(
			() =>
				verifyNotification(
					buildSignedNotification({
						return_url: "https://merchant.example.test/billing/return",
					}),
				),
			"INVALID_INPUT",
		);
	});

	test.each([
		["total_amount", "123.46"],
		["app_id", "2026071400000999"],
		["seller_id", "2088000000000999"],
		["out_trade_no", "ZT202607140099"],
	])(
		"rejects a signed notification whose %s does not match the order",
		(field, value) => {
			expectProtocolError(
				() => verifyNotification(buildSignedNotification({ [field]: value })),
				"VALUE_MISMATCH",
			);
		},
	);

	test("rejects field tampering performed after the notification was signed", () => {
		const parameters = new URLSearchParams(buildSignedNotification());
		parameters.set("total_amount", "0.01");

		expectProtocolError(
			() => verifyNotification(parameters.toString()),
			"INVALID_SIGNATURE",
		);
	});
});
