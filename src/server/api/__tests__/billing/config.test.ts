import {
	ALIPAY_NOTIFY_PATH,
	ALIPAY_RETURN_PATH,
	isValidAlipayCallbackOrigin,
} from "~/lib/billing/alipayCallbacks";
import { getAlipayCallbackOrigins, getAlipayCallbackUrls } from "~/server/billing/config";

describe("Alipay callback configuration", () => {
	test("uses the configured origins and fixed callback paths", () => {
		const callbacks = getAlipayCallbackUrls(
			{
				alipayNotifyUrl: `https://pay.example.test${ALIPAY_NOTIFY_PATH}`,
				alipayReturnUrl: `https://pay.example.test${ALIPAY_RETURN_PATH}`,
			},
			"order 123",
		);

		expect(callbacks.notifyUrl).toBe(`https://pay.example.test${ALIPAY_NOTIFY_PATH}`);
		expect(callbacks.returnUrl).toBe(
			`https://pay.example.test${ALIPAY_RETURN_PATH}?orderId=order+123`,
		);
	});

	test("does not fall back to an environment-derived callback URL", () => {
		expect(() =>
			getAlipayCallbackUrls({ alipayNotifyUrl: null, alipayReturnUrl: null }, "order-1"),
		).toThrow("Alipay callback domains are not configured");
	});

	test("accepts only HTTP and HTTPS origins without a path", () => {
		expect(isValidAlipayCallbackOrigin("http://192.0.2.10:3000")).toBe(true);
		expect(isValidAlipayCallbackOrigin("https://pay.example.test/")).toBe(true);
		expect(isValidAlipayCallbackOrigin("https://user:password@pay.example.test")).toBe(
			false,
		);
		expect(isValidAlipayCallbackOrigin("https://pay.example.test/callback")).toBe(false);
		expect(isValidAlipayCallbackOrigin("https://pay.example.test?source=alipay")).toBe(
			false,
		);
		expect(isValidAlipayCallbackOrigin("https://pay.example.test#fragment")).toBe(false);
		expect(isValidAlipayCallbackOrigin("/billing/return")).toBe(false);
		expect(isValidAlipayCallbackOrigin("ftp://pay.example.test")).toBe(false);
	});

	test("extracts an origin only from the expected stored callback paths", () => {
		expect(
			getAlipayCallbackOrigins({
				alipayNotifyUrl: "https://pay.example.test/api/billing/alipay/notify",
				alipayReturnUrl: "https://pay.example.test/billing/return",
			}),
		).toEqual({
			notifyOrigin: "https://pay.example.test",
			returnOrigin: "https://pay.example.test",
		});

		expect(
			getAlipayCallbackOrigins({
				alipayNotifyUrl: "https://pay.example.test/custom/notify",
				alipayReturnUrl: "https://pay.example.test/billing/return?orderId=old",
			}),
		).toEqual({ notifyOrigin: "", returnOrigin: "" });
	});
});
