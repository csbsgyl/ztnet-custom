import crypto from "crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "~/server/db";
import { AuthorizationType } from "~/types/apiTypes";
import { canAccessProtectedResources } from "./accountAccess";

const ZTNET_SECRET = process.env.NEXTAUTH_SECRET;

export const SMTP_SECRET = "_smtp";
export const API_TOKEN_SECRET = "_ztnet_api_token";
export const ORG_API_TOKEN_SECRET = "_ztnet_organization_api_token";
export const ORG_INVITE_TOKEN_SECRET = "_ztnet_org_invite";
export const PASSWORD_RESET_SECRET = "_ztnet_passwd_reset";
export const VERIFY_EMAIL_SECRET = "_ztnet_email_verify";
export const TOTP_MFA_TOKEN_SECRET = "_ztnet_mfa_totp_token";

const API_TOKEN_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_API_TOKEN_MIGRATION_BATCH_SIZE = 100;

export const hashApiToken = (token: string) =>
	crypto.createHash("sha256").update(token, "utf8").digest("hex");

function storedApiTokenMatches(stored: string, supplied: string): boolean {
	const isDigest = API_TOKEN_DIGEST_PATTERN.test(stored);
	const expected = Buffer.from(stored, isDigest ? "hex" : "utf8");
	const actual = Buffer.from(
		isDigest ? hashApiToken(supplied) : supplied,
		isDigest ? "hex" : "utf8",
	);
	return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

type ApiTokenMigrationClient = Pick<PrismaClient, "aPIToken">;

/** Converts legacy bearer-token rows to digests without overwriting concurrent changes. */
export async function migrateLegacyApiTokenDigests(
	client: ApiTokenMigrationClient = prisma,
	batchSize = DEFAULT_API_TOKEN_MIGRATION_BATCH_SIZE,
): Promise<number> {
	const requestedBatchSize = Math.trunc(batchSize);
	const take = Math.min(
		1_000,
		Math.max(
			1,
			Number.isFinite(requestedBatchSize)
				? requestedBatchSize
				: DEFAULT_API_TOKEN_MIGRATION_BATCH_SIZE,
		),
	);
	let cursor: string | undefined;
	let migrated = 0;

	while (true) {
		const tokens = await client.aPIToken.findMany({
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			orderBy: { id: "asc" },
			take,
			select: { id: true, token: true },
		});

		for (const token of tokens) {
			if (API_TOKEN_DIGEST_PATTERN.test(token.token)) continue;
			const result = await client.aPIToken.updateMany({
				where: { id: token.id, token: token.token },
				data: { token: hashApiToken(token.token) },
			});
			migrated += result.count;
		}

		if (tokens.length < take) break;
		cursor = tokens[tokens.length - 1]?.id;
		if (!cursor) break;
	}

	return migrated;
}

// Generate instance specific auth secret using salt
export const generateInstanceSecret = (contextSuffix: string) => {
	const salt = crypto
		.createHash("sha256")
		.update(String(ZTNET_SECRET))
		.update(String(contextSuffix))
		.digest();

	return salt;
};

// Encryption Function
export const encrypt = (text: string, secret: Buffer) => {
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv(
		"aes-256-cbc",
		Buffer.from(secret.slice(0, 32)),
		iv,
	);
	const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
	return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
};

// Decryption Function
export const decrypt = <T>(text: string, secret: Buffer) => {
	try {
		if (!secret) {
			throw new Error("Secret is empty");
		}

		const secretBuffer = Buffer.from(secret);

		if (secretBuffer.length !== 32) {
			throw new Error(`Invalid key length: ${secretBuffer.length}, Secret: ${secret}`);
		}

		const textParts = text.split(":");
		const iv = Buffer.from(textParts.shift()!, "hex");
		const encryptedText = Buffer.from(textParts.join(":"), "hex");

		const decipher = crypto.createDecipheriv("aes-256-cbc", secretBuffer, iv);

		const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
		return decrypted.toString() as T;
	} catch (err) {
		throw new Error(err);
	}
};

type DecryptedTokenData = {
	userId: string;
	name: string;
	apiAuthorizationType: AuthorizationType;
	tokenId: string;
};

type VerifyToken = {
	apiKey: string;
	requireAdmin?: boolean;
	apiAuthorizationType: AuthorizationType;
	client?: Pick<PrismaClient, "aPIToken" | "user">;
};

export async function decryptAndVerifyToken({
	apiKey,
	requireAdmin = false,
	apiAuthorizationType,
	client = prisma,
}: VerifyToken): Promise<DecryptedTokenData> {
	// Check if API key is provided
	if (!apiKey) {
		throw new Error("API key missing");
	}

	let decryptedData: DecryptedTokenData;

	// Try decrypting the token
	try {
		const decryptedString = decrypt<string>(
			apiKey,
			generateInstanceSecret(API_TOKEN_SECRET),
		);
		decryptedData = JSON.parse(decryptedString);
	} catch (_error) {
		throw new Error("Invalid token");
	}

	// Validate the decrypted data structure (add more validations as necessary)
	if (
		!decryptedData.userId ||
		typeof decryptedData.userId !== "string" ||
		!decryptedData.tokenId
	) {
		throw new Error("Invalid token");
	}
	// validate the authorization type in token with the required authorization type
	if (
		!Array.isArray(decryptedData.apiAuthorizationType) ||
		!decryptedData.apiAuthorizationType.includes(apiAuthorizationType)
	) {
		throw new Error("Invalid Authorization Type");
	}

	// get the token from the database
	const token = await client.aPIToken.findUnique({
		where: {
			id: decryptedData.tokenId,
			userId: decryptedData.userId,
		},
		select: {
			expiresAt: true,
			isActive: true,
			token: true,
		},
	});
	if (!token || !storedApiTokenMatches(token.token, apiKey)) {
		throw new Error("Invalid token");
	}
	if (!token.isActive) {
		throw new Error("Invalid token");
	}

	// check if the token is expired
	if (token.expiresAt) {
		const expiresAt = new Date(token.expiresAt);
		if (expiresAt.getTime() <= Date.now()) {
			throw new Error("Invalid token");
		}
	}
	if (token.token === apiKey) {
		// Transparently migrate legacy bearer-token rows after their next valid use.
		await client.aPIToken.update({
			where: { id: decryptedData.tokenId },
			data: { token: hashApiToken(apiKey) },
		});
	}

	// Verify if the user exists and has the required token
	const user = await client.user.findUnique({
		where: {
			id: decryptedData.userId,
		},
		select: {
			id: true,
			role: true,
			isActive: true,
			suspensionReason: true,
			expiresAt: true,
		},
	});

	if (!user) {
		throw new Error("Invalid token");
	}

	if (!canAccessProtectedResources(user)) {
		throw new Error("Invalid token");
	}

	if (user.role !== "ADMIN" && requireAdmin) {
		throw new Error("Invalid token");
	}

	return decryptedData;
}
