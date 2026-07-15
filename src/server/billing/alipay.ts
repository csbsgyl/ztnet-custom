import {
	constants,
	createPrivateKey,
	createPublicKey,
	createSign,
	createVerify,
	type KeyObject,
} from "crypto";

export const ALIPAY_PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do";

const MAX_FORM_BYTES = 1024 * 1024;
const MAX_FORM_PARAMETERS = 128;
const MAX_JSON_BYTES = 1024 * 1024;
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const OUT_TRADE_NO_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type AlipayKey = string | Buffer | KeyObject;
export type AlipayTradeStatus = "TRADE_SUCCESS" | "TRADE_FINISHED";
export type AlipayErrorCode =
	| "INVALID_INPUT"
	| "INVALID_KEY"
	| "INVALID_SIGNATURE"
	| "INVALID_RESPONSE"
	| "VALUE_MISMATCH"
	| "UNSUPPORTED_STATUS";

export class AlipayProtocolError extends Error {
	readonly code: AlipayErrorCode;

	constructor(code: AlipayErrorCode, message: string) {
		super(message);
		this.name = "AlipayProtocolError";
		this.code = code;
	}
}

export type AlipayParameters = Readonly<Record<string, string | null | undefined>>;

export interface CanonicalizeOptions {
	exclude?: readonly string[];
}

interface AlipayRequestConfig {
	appId: string;
	privateKey: AlipayKey;
	gateway?: string;
}

export interface BuildPagePayUrlOptions extends AlipayRequestConfig {
	merchantOrderNo: string;
	amountCents: number;
	subject: string;
	notifyUrl: string;
	returnUrl?: string;
	body?: string;
	timeoutExpress?: string;
	timeExpire?: Date;
	timestamp?: Date;
}

export interface BuildTradeCloseUrlOptions extends AlipayRequestConfig {
	merchantOrderNo: string;
	timestamp?: Date;
}

type QueryByOutTradeNo = {
	merchantOrderNo: string;
	alipayTradeNo?: never;
};

type QueryByTradeNo = {
	alipayTradeNo: string;
	merchantOrderNo?: never;
};

export type BuildTradeQueryUrlOptions = AlipayRequestConfig &
	(QueryByOutTradeNo | QueryByTradeNo) & {
		timestamp?: Date;
	};

export interface AlipayResponseExpected {
	merchantOrderNo?: string;
	amountCents?: number;
}

export interface AlipayTradeQueryResponse {
	code: string;
	msg?: string;
	sub_code?: string;
	sub_msg?: string;
	trade_no?: string;
	out_trade_no?: string;
	trade_status?: string;
	total_amount?: string;
	buyer_pay_amount?: string;
	send_pay_date?: string;
	[key: string]: unknown;
}

export interface AlipayTradeCloseResponse {
	code: string;
	msg?: string;
	sub_code?: string;
	sub_msg?: string;
	trade_no?: string;
	out_trade_no?: string;
	[key: string]: unknown;
}

export interface AlipayNotificationExpected {
	appId: string;
	sellerId?: string | null;
	merchantOrderNo: string;
	amountCents: number;
}

export interface VerifyAlipayNotificationOptions {
	payload: string | URLSearchParams | Readonly<Record<string, string>>;
	alipayPublicKey: AlipayKey;
	expected: AlipayNotificationExpected;
}

export interface VerifiedAlipayNotification {
	payload: Readonly<Record<string, string>>;
	appId: string;
	sellerId: string;
	merchantOrderNo: string;
	alipayTradeNo: string;
	amountCents: number;
	tradeStatus: AlipayTradeStatus;
	notifyId?: string;
	paidAt?: string;
}

export interface VerifyAlipayResponseOptions {
	body: string | Uint8Array;
	alipayPublicKey: AlipayKey;
	responseKey?: string;
	expected?: AlipayResponseExpected;
}

function protocolError(code: AlipayErrorCode, message: string): never {
	throw new AlipayProtocolError(code, message);
}

function isForbiddenKey(key: string): boolean {
	return FORBIDDEN_KEYS.has(key.toLowerCase());
}

function assertParameterName(name: string): void {
	if (!PARAMETER_NAME_PATTERN.test(name) || isForbiddenKey(name)) {
		protocolError("INVALID_INPUT", `Invalid parameter name: ${name}`);
	}
}

function assertParameterRecord(parameters: AlipayParameters): void {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
		protocolError("INVALID_INPUT", "Parameters must be a plain object");
	}

	const prototype = Object.getPrototypeOf(parameters);
	if (prototype !== Object.prototype && prototype !== null) {
		protocolError("INVALID_INPUT", "Parameters must be a plain object");
	}
}

function hasAsciiControlCharacter(
	value: string,
	allowedCodes: ReadonlySet<number> = new Set(),
): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if ((code < 0x20 || code === 0x7f) && !allowedCodes.has(code)) return true;
	}
	return false;
}

function decodeBase64(input: string, label: string, allowWhitespace = false): Buffer {
	const value = allowWhitespace ? input.replace(/\s/g, "") : input;
	if (
		value.length === 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
		value.slice(0, -2).includes("=")
	) {
		protocolError("INVALID_INPUT", `${label} is not valid base64`);
	}

	const unpadded = value.replace(/=+$/, "");
	if (unpadded.length % 4 === 1) {
		protocolError("INVALID_INPUT", `${label} is not valid base64`);
	}

	const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
	const decoded = Buffer.from(padded, "base64");
	if (decoded.length === 0) {
		protocolError("INVALID_INPUT", `${label} is not valid base64`);
	}

	return decoded;
}

function normalizePem(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("\\n") && !trimmed.includes("\n")
		? trimmed.replace(/\\n/g, "\n")
		: trimmed;
}

function assertRsaKey(key: KeyObject, expectedType: "private" | "public"): KeyObject {
	if (key.type !== expectedType || key.asymmetricKeyType !== "rsa") {
		protocolError(
			"INVALID_KEY",
			`Alipay ${expectedType} key must be an RSA ${expectedType} key`,
		);
	}
	return key;
}

function createPrivateKeyFromDer(der: Buffer): KeyObject {
	for (const type of ["pkcs8", "pkcs1"] as const) {
		try {
			return createPrivateKey({ key: der, format: "der", type });
		} catch {
			// Try the other common RSA private-key container.
		}
	}
	return protocolError("INVALID_KEY", "Invalid Alipay private key");
}

function normalizePrivateKey(input: AlipayKey): KeyObject {
	if (typeof input === "object" && "type" in input) {
		return assertRsaKey(input, "private");
	}

	if (Buffer.isBuffer(input)) {
		const text = input.toString("utf8");
		if (text.includes("-----BEGIN")) {
			try {
				return assertRsaKey(createPrivateKey(normalizePem(text)), "private");
			} catch (error) {
				if (error instanceof AlipayProtocolError) throw error;
				return protocolError("INVALID_KEY", "Invalid Alipay private key");
			}
		}
		return assertRsaKey(createPrivateKeyFromDer(input), "private");
	}

	const value = normalizePem(input);
	if (value.includes("-----BEGIN")) {
		try {
			return assertRsaKey(createPrivateKey(value), "private");
		} catch (error) {
			if (error instanceof AlipayProtocolError) throw error;
			return protocolError("INVALID_KEY", "Invalid Alipay private key");
		}
	}

	return assertRsaKey(
		createPrivateKeyFromDer(decodeBase64(value, "Private key", true)),
		"private",
	);
}

function createPublicKeyFromDer(der: Buffer): KeyObject {
	for (const type of ["spki", "pkcs1"] as const) {
		try {
			return createPublicKey({ key: der, format: "der", type });
		} catch {
			// Try the other common RSA public-key container.
		}
	}
	return protocolError("INVALID_KEY", "Invalid Alipay public key");
}

function normalizePublicKey(input: AlipayKey): KeyObject {
	if (typeof input === "object" && "type" in input) {
		if (input.type === "private") {
			return assertRsaKey(createPublicKey(input), "public");
		}
		return assertRsaKey(input, "public");
	}

	if (Buffer.isBuffer(input)) {
		const text = input.toString("utf8");
		if (text.includes("-----BEGIN")) {
			try {
				return assertRsaKey(createPublicKey(normalizePem(text)), "public");
			} catch (error) {
				if (error instanceof AlipayProtocolError) throw error;
				return protocolError("INVALID_KEY", "Invalid Alipay public key");
			}
		}
		return assertRsaKey(createPublicKeyFromDer(input), "public");
	}

	const value = normalizePem(input);
	if (value.includes("-----BEGIN")) {
		try {
			return assertRsaKey(createPublicKey(value), "public");
		} catch (error) {
			if (error instanceof AlipayProtocolError) throw error;
			return protocolError("INVALID_KEY", "Invalid Alipay public key");
		}
	}

	return assertRsaKey(
		createPublicKeyFromDer(decodeBase64(value, "Public key", true)),
		"public",
	);
}

export function canonicalizeParameters(
	parameters: AlipayParameters,
	options: CanonicalizeOptions = {},
): string {
	assertParameterRecord(parameters);
	const excluded = new Set(options.exclude ?? ["sign"]);

	return Object.keys(parameters)
		.sort()
		.flatMap((name) => {
			assertParameterName(name);
			if (excluded.has(name)) return [];

			const value = parameters[name];
			if (value === null || value === undefined || value === "") return [];
			if (typeof value !== "string") {
				protocolError("INVALID_INPUT", `Parameter ${name} must be a string`);
			}
			return [`${name}=${value}`];
		})
		.join("&");
}

export function signContent(content: string, privateKey: AlipayKey): string {
	const signer = createSign("RSA-SHA256");
	signer.update(content, "utf8");
	signer.end();
	return signer.sign(
		{
			key: normalizePrivateKey(privateKey),
			padding: constants.RSA_PKCS1_PADDING,
		},
		"base64",
	);
}

export function verifyContentSignature(
	content: string,
	signature: string,
	publicKey: AlipayKey,
): boolean {
	let signatureBytes: Buffer;
	try {
		signatureBytes = decodeBase64(signature, "Signature");
	} catch (error) {
		if (error instanceof AlipayProtocolError) return false;
		throw error;
	}

	const verifier = createVerify("RSA-SHA256");
	verifier.update(content, "utf8");
	verifier.end();
	return verifier.verify(
		{
			key: normalizePublicKey(publicKey),
			padding: constants.RSA_PKCS1_PADDING,
		},
		signatureBytes,
	);
}

export function signParameters(
	parameters: AlipayParameters,
	privateKey: AlipayKey,
): string {
	return signContent(canonicalizeParameters(parameters), privateKey);
}

export function verifyParameters(
	parameters: AlipayParameters,
	signature: string,
	publicKey: AlipayKey,
	options: CanonicalizeOptions = {},
): boolean {
	return verifyContentSignature(
		canonicalizeParameters(parameters, options),
		signature,
		publicKey,
	);
}

function readTextInput(
	input: string | Uint8Array,
	maxBytes: number,
	label: string,
): string {
	if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > maxBytes) {
			protocolError("INVALID_INPUT", `${label} is too large`);
		}
		return input;
	}

	if (input.byteLength > maxBytes) {
		protocolError("INVALID_INPUT", `${label} is too large`);
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		return protocolError("INVALID_INPUT", `${label} is not valid UTF-8`);
	}
}

function decodeFormComponent(value: string, label: string): string {
	if (/%(?![0-9A-Fa-f]{2})/.test(value)) {
		protocolError("INVALID_INPUT", `${label} has invalid percent encoding`);
	}
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return protocolError("INVALID_INPUT", `${label} is not valid UTF-8`);
	}
}

export function parseFormUrlEncoded(
	input: string | Uint8Array,
): Readonly<Record<string, string>> {
	const text = readTextInput(input, MAX_FORM_BYTES, "Form body");
	const result = Object.create(null) as Record<string, string>;
	if (text === "") return Object.freeze(result);

	const pairs = text.split("&");
	if (pairs.length > MAX_FORM_PARAMETERS) {
		protocolError("INVALID_INPUT", "Form body has too many parameters");
	}

	for (const pair of pairs) {
		if (pair === "") {
			protocolError("INVALID_INPUT", "Form body contains an empty parameter");
		}

		const separator = pair.indexOf("=");
		const encodedName = separator === -1 ? pair : pair.slice(0, separator);
		const encodedValue = separator === -1 ? "" : pair.slice(separator + 1);
		const name = decodeFormComponent(encodedName, "Parameter name");
		assertParameterName(name);
		if (Object.hasOwn(result, name)) {
			protocolError("INVALID_INPUT", `Duplicate parameter: ${name}`);
		}

		result[name] = decodeFormComponent(encodedValue, `Parameter ${name}`);
	}

	return Object.freeze(result);
}

function copyUniqueSearchParameters(input: URLSearchParams): Record<string, string> {
	const result = Object.create(null) as Record<string, string>;
	let count = 0;
	let size = 0;
	for (const [name, value] of input.entries()) {
		count += 1;
		size += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
		if (count > MAX_FORM_PARAMETERS) {
			protocolError("INVALID_INPUT", "Form body has too many parameters");
		}
		if (size > MAX_FORM_BYTES) {
			protocolError("INVALID_INPUT", "Form body is too large");
		}
		assertParameterName(name);
		if (Object.hasOwn(result, name)) {
			protocolError("INVALID_INPUT", `Duplicate parameter: ${name}`);
		}
		result[name] = value;
	}
	return Object.freeze(result);
}

export function parseAlipayNotification(
	body: string | URLSearchParams,
): Record<string, string> {
	return typeof body === "string"
		? (parseFormUrlEncoded(body) as Record<string, string>)
		: copyUniqueSearchParameters(body);
}

function copyParameterRecord(
	payload: Readonly<Record<string, string>>,
): Record<string, string> {
	assertParameterRecord(payload);
	const names = Object.keys(payload);
	if (names.length > MAX_FORM_PARAMETERS) {
		protocolError("INVALID_INPUT", "Notification has too many parameters");
	}

	const result = Object.create(null) as Record<string, string>;
	let size = 0;
	for (const name of names) {
		assertParameterName(name);
		const value = payload[name];
		if (typeof value !== "string") {
			protocolError("INVALID_INPUT", `Parameter ${name} must be a string`);
		}
		size += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
		if (size > MAX_FORM_BYTES) {
			protocolError("INVALID_INPUT", "Notification is too large");
		}
		result[name] = value;
	}
	return Object.freeze(result);
}

function assertIdentifier(value: string, label: string, maxLength = 64): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		hasAsciiControlCharacter(value) ||
		/\s/.test(value)
	) {
		protocolError("INVALID_INPUT", `${label} is invalid`);
	}
}

function assertOutTradeNo(value: string): void {
	if (!OUT_TRADE_NO_PATTERN.test(value)) {
		protocolError("INVALID_INPUT", "outTradeNo is invalid");
	}
}

function assertText(value: string, label: string, maxLength: number): void {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength ||
		hasAsciiControlCharacter(value, new Set([0x09, 0x0a, 0x0d]))
	) {
		protocolError("INVALID_INPUT", `${label} is invalid`);
	}
}

function assertHttpUrl(value: string, label: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		protocolError("INVALID_INPUT", `${label} must be an absolute URL`);
	}

	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== ""
	) {
		protocolError("INVALID_INPUT", `${label} is invalid`);
	}
}

function getGateway(value?: string): URL {
	const gateway = new URL(value ?? ALIPAY_PRODUCTION_GATEWAY);
	if (
		gateway.protocol !== "https:" ||
		gateway.username !== "" ||
		gateway.password !== "" ||
		gateway.search !== "" ||
		gateway.hash !== ""
	) {
		protocolError("INVALID_INPUT", "Alipay gateway must be a clean HTTPS URL");
	}
	return gateway;
}

function assertDate(date: Date): void {
	if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
		protocolError("INVALID_INPUT", "timestamp must be a valid Date");
	}
}

export function formatAlipayTimestamp(date = new Date()): string {
	assertDate(date);
	const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return [
		`${chinaTime.getUTCFullYear()}-${pad(chinaTime.getUTCMonth() + 1)}-${pad(
			chinaTime.getUTCDate(),
		)}`,
		`${pad(chinaTime.getUTCHours())}:${pad(chinaTime.getUTCMinutes())}:${pad(
			chinaTime.getUTCSeconds(),
		)}`,
	].join(" ");
}

function assertAmountCents(cents: number): void {
	if (!Number.isSafeInteger(cents) || cents <= 0) {
		protocolError("INVALID_INPUT", "Amount must be a positive safe integer in cents");
	}
}

export function formatAlipayAmount(cents: number): string {
	assertAmountCents(cents);
	const amount = BigInt(cents);
	return `${amount / BigInt(100)}.${(amount % BigInt(100)).toString().padStart(2, "0")}`;
}

export function parseAlipayAmount(value: string): number {
	if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{2}$/.test(value)) {
		protocolError("INVALID_INPUT", "Alipay amount is invalid");
	}

	const [whole = "0", fraction = "00"] = value.split(".");
	const cents = BigInt(whole) * BigInt(100) + BigInt(fraction);
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
		protocolError("INVALID_INPUT", "Alipay amount exceeds the safe integer range");
	}
	return Number(cents);
}

function commonRequestParameters(
	config: AlipayRequestConfig,
	method: string,
	timestamp?: Date,
): Record<string, string> {
	assertIdentifier(config.appId, "appId");
	return {
		app_id: config.appId,
		method,
		format: "JSON",
		charset: "utf-8",
		sign_type: "RSA2",
		timestamp: formatAlipayTimestamp(timestamp),
		version: "1.0",
	};
}

function buildSignedGatewayUrl(
	config: AlipayRequestConfig,
	parameters: Record<string, string>,
): string {
	parameters.sign = signParameters(parameters, config.privateKey);
	const gateway = getGateway(config.gateway);
	gateway.search = Object.keys(parameters)
		.sort()
		.map(
			(name) =>
				`${encodeURIComponent(name)}=${encodeURIComponent(parameters[name] ?? "")}`,
		)
		.join("&");
	return gateway.toString();
}

export function buildPagePayUrl(options: BuildPagePayUrlOptions): string {
	assertOutTradeNo(options.merchantOrderNo);
	assertAmountCents(options.amountCents);
	assertText(options.subject, "subject", 256);
	assertHttpUrl(options.notifyUrl, "notifyUrl");
	if (options.returnUrl !== undefined) {
		assertHttpUrl(options.returnUrl, "returnUrl");
	}
	if (options.body !== undefined) assertText(options.body, "body", 128);
	if (options.timeExpire !== undefined) assertDate(options.timeExpire);
	if (
		options.timeoutExpress !== undefined &&
		!/^[1-9]\d{0,4}[mhdc]$/.test(options.timeoutExpress)
	) {
		protocolError("INVALID_INPUT", "timeoutExpress is invalid");
	}

	const bizContent: Record<string, string> = {
		out_trade_no: options.merchantOrderNo,
		product_code: "FAST_INSTANT_TRADE_PAY",
		total_amount: formatAlipayAmount(options.amountCents),
		subject: options.subject,
	};
	if (options.body !== undefined) bizContent.body = options.body;
	if (options.timeoutExpress !== undefined) {
		bizContent.timeout_express = options.timeoutExpress;
	}
	if (options.timeExpire !== undefined) {
		bizContent.time_expire = formatAlipayTimestamp(options.timeExpire);
	}

	const parameters = commonRequestParameters(
		options,
		"alipay.trade.page.pay",
		options.timestamp,
	);
	parameters.notify_url = options.notifyUrl;
	if (options.returnUrl !== undefined) parameters.return_url = options.returnUrl;
	parameters.biz_content = JSON.stringify(bizContent);

	return buildSignedGatewayUrl(options, parameters);
}

export function buildTradeQueryUrl(options: BuildTradeQueryUrlOptions): string {
	const bizContent: Record<string, string> = {};
	if ("merchantOrderNo" in options && options.merchantOrderNo !== undefined) {
		assertOutTradeNo(options.merchantOrderNo);
		bizContent.out_trade_no = options.merchantOrderNo;
	} else if ("alipayTradeNo" in options && options.alipayTradeNo !== undefined) {
		assertIdentifier(options.alipayTradeNo, "alipayTradeNo");
		bizContent.trade_no = options.alipayTradeNo;
	} else {
		protocolError("INVALID_INPUT", "A trade query requires exactly one trade number");
	}

	const parameters = commonRequestParameters(
		options,
		"alipay.trade.query",
		options.timestamp,
	);
	parameters.biz_content = JSON.stringify(bizContent);
	return buildSignedGatewayUrl(options, parameters);
}

export function buildTradeCloseUrl(options: BuildTradeCloseUrlOptions): string {
	assertOutTradeNo(options.merchantOrderNo);
	const parameters = commonRequestParameters(
		options,
		"alipay.trade.close",
		options.timestamp,
	);
	parameters.biz_content = JSON.stringify({
		out_trade_no: options.merchantOrderNo,
	});
	return buildSignedGatewayUrl(options, parameters);
}

function skipJsonWhitespace(input: string, start: number): number {
	let index = start;
	while (/\s/.test(input[index] ?? "")) index += 1;
	return index;
}

function scanJsonString(input: string, start: number): number {
	if (input[start] !== '"') {
		protocolError("INVALID_RESPONSE", "Expected a JSON string");
	}
	let escaped = false;
	for (let index = start + 1; index < input.length; index += 1) {
		const character = input[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') return index + 1;
	}
	return protocolError("INVALID_RESPONSE", "Unterminated JSON string");
}

function parseJsonString(input: string, start: number, end: number): string {
	try {
		const parsed = JSON.parse(input.slice(start, end)) as unknown;
		if (typeof parsed !== "string") {
			return protocolError("INVALID_RESPONSE", "Invalid JSON object key");
		}
		return parsed;
	} catch {
		return protocolError("INVALID_RESPONSE", "Invalid JSON string");
	}
}

function validateJsonValue(input: string, start: number): number {
	let index = skipJsonWhitespace(input, start);
	const character = input[index];

	if (character === '"') {
		const end = scanJsonString(input, index);
		parseJsonString(input, index, end);
		return end;
	}

	if (character === "{") {
		index = skipJsonWhitespace(input, index + 1);
		if (input[index] === "}") return index + 1;
		const keys = new Set<string>();

		while (index < input.length) {
			const keyStart = index;
			const keyEnd = scanJsonString(input, keyStart);
			const key = parseJsonString(input, keyStart, keyEnd);
			if (isForbiddenKey(key) || keys.has(key)) {
				protocolError("INVALID_RESPONSE", `Unsafe or duplicate JSON key: ${key}`);
			}
			keys.add(key);

			index = skipJsonWhitespace(input, keyEnd);
			if (input[index] !== ":") {
				protocolError("INVALID_RESPONSE", "Expected a colon after a JSON key");
			}
			index = skipJsonWhitespace(input, validateJsonValue(input, index + 1));
			if (input[index] === "}") return index + 1;
			if (input[index] !== ",") {
				protocolError("INVALID_RESPONSE", "Expected a comma in a JSON object");
			}
			index = skipJsonWhitespace(input, index + 1);
		}
		return protocolError("INVALID_RESPONSE", "Unterminated JSON object");
	}

	if (character === "[") {
		index = skipJsonWhitespace(input, index + 1);
		if (input[index] === "]") return index + 1;
		while (index < input.length) {
			index = skipJsonWhitespace(input, validateJsonValue(input, index));
			if (input[index] === "]") return index + 1;
			if (input[index] !== ",") {
				protocolError("INVALID_RESPONSE", "Expected a comma in a JSON array");
			}
			index = skipJsonWhitespace(input, index + 1);
		}
		return protocolError("INVALID_RESPONSE", "Unterminated JSON array");
	}

	const primitiveStart = index;
	while (index < input.length && !/[\s,}\]]/.test(input[index] ?? "")) {
		index += 1;
	}
	if (index === primitiveStart) {
		protocolError("INVALID_RESPONSE", "Invalid JSON value");
	}
	try {
		JSON.parse(input.slice(primitiveStart, index));
	} catch {
		return protocolError("INVALID_RESPONSE", "Invalid JSON primitive");
	}
	return index;
}

function sanitizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => sanitizeJson(item)));
	}
	if (value !== null && typeof value === "object") {
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value)) {
			if (isForbiddenKey(key)) {
				protocolError("INVALID_RESPONSE", `Unsafe JSON key: ${key}`);
			}
			result[key] = sanitizeJson(item);
		}
		return Object.freeze(result);
	}
	return value;
}

function parseSafeJson(input: string): unknown {
	const start = skipJsonWhitespace(input, 0);
	const end = skipJsonWhitespace(input, validateJsonValue(input, start));
	if (end !== input.length) {
		protocolError("INVALID_RESPONSE", "Unexpected data after JSON value");
	}
	try {
		return sanitizeJson(JSON.parse(input) as unknown);
	} catch (error) {
		if (error instanceof AlipayProtocolError) throw error;
		return protocolError("INVALID_RESPONSE", "Invalid JSON response");
	}
}

function topLevelJsonMembers(input: string): ReadonlyMap<string, string> {
	let index = skipJsonWhitespace(input, 0);
	if (input[index] !== "{") {
		return protocolError("INVALID_RESPONSE", "Alipay response must be a JSON object");
	}
	index = skipJsonWhitespace(input, index + 1);
	const members = new Map<string, string>();

	if (input[index] === "}") return members;
	while (index < input.length) {
		const keyStart = index;
		const keyEnd = scanJsonString(input, keyStart);
		const key = parseJsonString(input, keyStart, keyEnd);
		index = skipJsonWhitespace(input, keyEnd);
		if (input[index] !== ":") {
			protocolError("INVALID_RESPONSE", "Expected a colon after a JSON key");
		}
		const valueStart = skipJsonWhitespace(input, index + 1);
		const valueEnd = validateJsonValue(input, valueStart);
		members.set(key, input.slice(valueStart, valueEnd));
		index = skipJsonWhitespace(input, valueEnd);
		if (input[index] === "}") return members;
		if (input[index] !== ",") {
			protocolError("INVALID_RESPONSE", "Expected a comma in Alipay response");
		}
		index = skipJsonWhitespace(input, index + 1);
	}
	return protocolError("INVALID_RESPONSE", "Unterminated Alipay response");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireStringField(
	record: Readonly<Record<string, unknown>>,
	name: string,
): string {
	const value = record[name];
	if (typeof value !== "string" || value === "") {
		protocolError("INVALID_RESPONSE", `Missing or invalid ${name}`);
	}
	return value;
}

export function verifyAlipayResponse(
	options: VerifyAlipayResponseOptions,
): Readonly<Record<string, unknown>> {
	const responseKey = options.responseKey ?? "alipay_trade_query_response";
	assertParameterName(responseKey);
	const body = readTextInput(options.body, MAX_JSON_BYTES, "Alipay response");
	parseSafeJson(body);
	const members = topLevelJsonMembers(body);
	const responseJson = members.get(responseKey);
	const signJson = members.get("sign");
	if (responseJson === undefined || signJson === undefined) {
		protocolError("INVALID_RESPONSE", "Alipay response payload or signature is missing");
	}
	const signTypeJson = members.get("sign_type");
	if (signTypeJson !== undefined && parseSafeJson(signTypeJson) !== "RSA2") {
		protocolError("INVALID_RESPONSE", "Only Alipay RSA2 responses are supported");
	}

	const signature = parseSafeJson(signJson);
	if (
		typeof signature !== "string" ||
		!verifyContentSignature(responseJson, signature, options.alipayPublicKey)
	) {
		protocolError("INVALID_SIGNATURE", "Invalid Alipay response signature");
	}

	const responseValue = parseSafeJson(responseJson);
	if (!isJsonObject(responseValue)) {
		protocolError("INVALID_RESPONSE", "Alipay response payload is invalid");
	}
	const response = responseValue;
	requireStringField(response, "code");

	if (options.expected?.merchantOrderNo !== undefined) {
		assertOutTradeNo(options.expected.merchantOrderNo);
		if (response.out_trade_no !== options.expected.merchantOrderNo) {
			protocolError("VALUE_MISMATCH", "Alipay query order number does not match");
		}
	}
	if (options.expected?.amountCents !== undefined) {
		assertAmountCents(options.expected.amountCents);
		if (
			typeof response.total_amount !== "string" ||
			parseAlipayAmount(response.total_amount) !== options.expected.amountCents
		) {
			protocolError("VALUE_MISMATCH", "Alipay query amount does not match");
		}
	}

	return response;
}

export function verifyTradeQueryResponse(
	input: string | Uint8Array,
	alipayPublicKey: AlipayKey,
	expected: AlipayResponseExpected = {},
): Readonly<AlipayTradeQueryResponse> {
	return verifyAlipayResponse({
		body: input,
		alipayPublicKey,
		expected,
	}) as Readonly<AlipayTradeQueryResponse>;
}

export function verifyTradeCloseResponse(
	input: string | Uint8Array,
	alipayPublicKey: AlipayKey,
): Readonly<AlipayTradeCloseResponse> {
	return verifyAlipayResponse({
		body: input,
		alipayPublicKey,
		responseKey: "alipay_trade_close_response",
	}) as Readonly<AlipayTradeCloseResponse>;
}

function requireNotificationParameter(
	parameters: Readonly<Record<string, string>>,
	name: string,
): string {
	const value = parameters[name];
	if (value === undefined || value === "") {
		protocolError("INVALID_INPUT", `Missing notification parameter: ${name}`);
	}
	return value;
}

function assertExpectedValue(actual: string, expected: string, label: string): void {
	if (actual !== expected) {
		protocolError("VALUE_MISMATCH", `${label} does not match`);
	}
}

function verifyParsedNotification(
	parameters: Readonly<Record<string, string>>,
	alipayPublicKey: AlipayKey,
	expected: AlipayNotificationExpected,
): VerifiedAlipayNotification {
	assertIdentifier(expected.appId, "expected appId");
	if (expected.sellerId) assertIdentifier(expected.sellerId, "expected sellerId");
	assertOutTradeNo(expected.merchantOrderNo);
	assertAmountCents(expected.amountCents);

	if (Object.hasOwn(parameters, "return_url")) {
		protocolError(
			"INVALID_INPUT",
			"Browser return_url parameters are not payment notifications",
		);
	}
	if (requireNotificationParameter(parameters, "sign_type") !== "RSA2") {
		protocolError("INVALID_INPUT", "Only Alipay RSA2 notifications are supported");
	}

	const signature = requireNotificationParameter(parameters, "sign");
	const signedContent = canonicalizeParameters(parameters, {
		exclude: ["sign", "sign_type"],
	});
	if (!verifyContentSignature(signedContent, signature, alipayPublicKey)) {
		protocolError("INVALID_SIGNATURE", "Invalid Alipay notification signature");
	}

	const appId = requireNotificationParameter(parameters, "app_id");
	const sellerId = requireNotificationParameter(parameters, "seller_id");
	const outTradeNo = requireNotificationParameter(parameters, "out_trade_no");
	const tradeNo = requireNotificationParameter(parameters, "trade_no");
	assertExpectedValue(appId, expected.appId, "Alipay app_id");
	if (expected.sellerId) {
		assertExpectedValue(sellerId, expected.sellerId, "Alipay seller_id");
	}
	assertExpectedValue(outTradeNo, expected.merchantOrderNo, "Alipay out_trade_no");
	if (parameters.auth_app_id !== undefined) {
		assertExpectedValue(parameters.auth_app_id, expected.appId, "Alipay auth_app_id");
	}

	const totalAmountCents = parseAlipayAmount(
		requireNotificationParameter(parameters, "total_amount"),
	);
	if (totalAmountCents !== expected.amountCents) {
		protocolError("VALUE_MISMATCH", "Alipay total_amount does not match");
	}

	const status = requireNotificationParameter(parameters, "trade_status");
	if (status !== "TRADE_SUCCESS" && status !== "TRADE_FINISHED") {
		protocolError("UNSUPPORTED_STATUS", `Unsupported Alipay trade status: ${status}`);
	}

	return {
		payload: parameters,
		appId,
		sellerId,
		merchantOrderNo: outTradeNo,
		alipayTradeNo: tradeNo,
		amountCents: totalAmountCents,
		tradeStatus: status,
		notifyId: parameters.notify_id || undefined,
		paidAt: parameters.gmt_payment || undefined,
	};
}

/**
 * Verifies an asynchronous Alipay server notification. Browser return_url query
 * parameters are deliberately rejected and must never be used to fulfil an order.
 */
export function verifyAlipayNotification(
	options: VerifyAlipayNotificationOptions,
): VerifiedAlipayNotification {
	let parameters: Readonly<Record<string, string>>;
	if (typeof options.payload === "string") {
		parameters = parseFormUrlEncoded(options.payload);
	} else if (options.payload instanceof URLSearchParams) {
		parameters = copyUniqueSearchParameters(options.payload);
	} else {
		parameters = copyParameterRecord(options.payload);
	}

	return verifyParsedNotification(parameters, options.alipayPublicKey, options.expected);
}

export function verifyNotification(
	input: string | Uint8Array,
	expected: AlipayNotificationExpected & { alipayPublicKey: AlipayKey },
): VerifiedAlipayNotification {
	const parameters = parseFormUrlEncoded(input);
	return verifyParsedNotification(parameters, expected.alipayPublicKey, expected);
}
