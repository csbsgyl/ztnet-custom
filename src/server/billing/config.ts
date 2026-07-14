import type { GlobalOptions } from "@prisma/client";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateInstanceSecret } from "~/utils/encryption";

export const ALIPAY_PRIVATE_KEY_SECRET = "_ztnet_alipay_private_key";
export const DEFAULT_ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";
export const ALIPAY_SANDBOX_GATEWAY =
	"https://openapi-sandbox.dl.alipaydev.com/gateway.do";
export const ALIPAY_GATEWAYS = [DEFAULT_ALIPAY_GATEWAY, ALIPAY_SANDBOX_GATEWAY] as const;

type AlipayOptionFields = Pick<
	GlobalOptions,
	| "alipayEnabled"
	| "alipayAppId"
	| "alipaySellerId"
	| "alipayGateway"
	| "alipayPrivateKeyEncrypted"
	| "alipayPublicKey"
>;

export type AlipayRuntimeConfig = {
	appId: string;
	sellerId: string;
	gateway: string;
	privateKey: string;
	alipayPublicKey: string;
};

export function getAlipayRuntimeConfig(
	options: AlipayOptionFields | null,
	settings: { requireEnabled?: boolean } = {},
): AlipayRuntimeConfig {
	const requireEnabled = settings.requireEnabled ?? true;
	if (
		!options ||
		(requireEnabled && !options.alipayEnabled) ||
		!options.alipayAppId ||
		!options.alipaySellerId ||
		!options.alipayPrivateKeyEncrypted ||
		!options.alipayPublicKey
	) {
		throw new Error("Alipay is not fully configured or enabled.");
	}
	const gateway = options.alipayGateway || DEFAULT_ALIPAY_GATEWAY;
	if (!ALIPAY_GATEWAYS.includes(gateway as (typeof ALIPAY_GATEWAYS)[number])) {
		throw new Error("Alipay gateway is not an approved official endpoint.");
	}

	return {
		appId: options.alipayAppId,
		sellerId: options.alipaySellerId,
		gateway,
		privateKey: decryptAlipayPrivateKey(options.alipayPrivateKeyEncrypted),
		alipayPublicKey: options.alipayPublicKey,
	};
}

export function encryptAlipayPrivateKey(privateKey: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		generateInstanceSecret(ALIPAY_PRIVATE_KEY_SECRET),
		iv,
	);
	const ciphertext = Buffer.concat([
		cipher.update(privateKey.trim(), "utf8"),
		cipher.final(),
	]);
	return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptAlipayPrivateKey(value: string): string {
	const [version, ivValue, tagValue, ciphertextValue] = value.split(":");
	if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
		throw new Error("The stored Alipay private key has an invalid format.");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		generateInstanceSecret(ALIPAY_PRIVATE_KEY_SECRET),
		Buffer.from(ivValue, "base64"),
	);
	decipher.setAuthTag(Buffer.from(tagValue, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertextValue, "base64")),
		decipher.final(),
	]).toString("utf8");
}

export function getPublicAlipayConfig(options: AlipayOptionFields | null) {
	return {
		enabled: options?.alipayEnabled ?? false,
		appId: options?.alipayAppId ?? "",
		sellerId: options?.alipaySellerId ?? "",
		gateway: options?.alipayGateway || DEFAULT_ALIPAY_GATEWAY,
		alipayPublicKey: options?.alipayPublicKey ?? "",
		hasPrivateKey: Boolean(options?.alipayPrivateKeyEncrypted),
	};
}
