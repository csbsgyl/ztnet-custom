export const ALIPAY_NOTIFY_PATH = "/api/billing/alipay/notify";
export const ALIPAY_RETURN_PATH = "/billing/return";

export type AlipayCallbackPath = typeof ALIPAY_NOTIFY_PATH | typeof ALIPAY_RETURN_PATH;

function parseAlipayCallbackOrigin(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("The Alipay callback domain must be a complete HTTP or HTTPS URL.");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"The Alipay callback domain must not contain credentials, a path, query parameters, or a fragment.",
		);
	}
	return url;
}

export function normalizeAlipayCallbackOrigin(value: string): string {
	return parseAlipayCallbackOrigin(value.trim()).origin;
}

export function isValidAlipayCallbackOrigin(value: string): boolean {
	try {
		normalizeAlipayCallbackOrigin(value);
		return true;
	} catch {
		return false;
	}
}

export function buildAlipayCallbackUrl(origin: string, path: AlipayCallbackPath): string {
	const url = parseAlipayCallbackOrigin(origin.trim());
	url.pathname = path;
	return url.toString();
}

export function getAlipayCallbackOrigin(
	value: string | null | undefined,
	expectedPath: AlipayCallbackPath,
): string {
	if (!value) return "";
	try {
		const url = new URL(value.trim());
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.pathname !== expectedPath ||
			url.search ||
			url.hash
		) {
			return "";
		}
		return url.origin;
	} catch {
		return "";
	}
}
