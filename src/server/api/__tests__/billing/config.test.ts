import { getAlipayCallbackUrls, isValidAlipayCallbackUrl } from "~/server/billing/config";

describe("Alipay callback configuration", () => {
	test("uses the configured URLs and adds the order ID to the browser return URL", () => {
		const callbacks = getAlipayCallbackUrls(
			{
				alipayNotifyUrl: "https://pay.example.test/api/billing/alipay/notify",
				alipayReturnUrl:
					"https://pay.example.test/billing/return?source=alipay&orderId=old",
			},
			"order 123",
		);

		expect(callbacks.notifyUrl).toBe(
			"https://pay.example.test/api/billing/alipay/notify",
		);
		expect(callbacks.returnUrl).toBe(
			"https://pay.example.test/billing/return?source=alipay&orderId=order+123",
		);
	});

	test("does not fall back to an environment-derived callback URL", () => {
		expect(() =>
			getAlipayCallbackUrls({ alipayNotifyUrl: null, alipayReturnUrl: null }, "order-1"),
		).toThrow("Alipay callback URLs are not configured");
	});

	test("accepts only complete HTTP and HTTPS callback URLs", () => {
		expect(isValidAlipayCallbackUrl("http://192.0.2.10:3000/billing/return")).toBe(true);
		expect(isValidAlipayCallbackUrl("https://pay.example.test/billing/return")).toBe(
			true,
		);
		expect(
			isValidAlipayCallbackUrl("https://user:password@pay.example.test/notify"),
		).toBe(false);
		expect(isValidAlipayCallbackUrl("https://pay.example.test/notify#fragment")).toBe(
			false,
		);
		expect(isValidAlipayCallbackUrl("/billing/return")).toBe(false);
		expect(isValidAlipayCallbackUrl("ftp://pay.example.test/billing/return")).toBe(false);
	});
});
