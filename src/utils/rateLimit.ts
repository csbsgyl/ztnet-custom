import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextApiResponse } from "next";
import { LRUCache } from "lru-cache";

type Options = {
	uniqueTokenPerInterval?: number;
	interval?: number;
};

// Helper function to get rate limit config values
// This ensures values are read at runtime, not module load time
function getApiWindowMs(): number {
	const windowMinutes = Number.parseInt(process.env.RATE_LIMIT_API_WINDOW || "1", 10);
	return (Number.isNaN(windowMinutes) ? 1 : windowMinutes) * 60 * 1000;
}

function getApiMaxRequests(): number {
	const maxRequests = Number.parseInt(
		process.env.RATE_LIMIT_API_MAX_REQUESTS || "50",
		10,
	);
	return Number.isNaN(maxRequests) ? 50 : maxRequests;
}

// Rate limit configuration - use functions for lazy evaluation
export const RATE_LIMIT_CONFIG = {
	get API_WINDOW_MS(): number {
		return getApiWindowMs();
	},
	get API_MAX_REQUESTS(): number {
		return getApiMaxRequests();
	},
};

type ResponseWithRequest = NextApiResponse & { req?: IncomingMessage };

function firstHeader(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value[0] || "" : value || "";
}

function digestIdentity(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function requestIdentity(res: NextApiResponse): string {
	const req = (res as ResponseWithRequest).req;
	const directAddress = req?.socket?.remoteAddress || "unknown";
	const forwardedAddress =
		process.env.RATE_LIMIT_TRUST_PROXY === "true"
			? firstHeader(req?.headers["x-forwarded-for"]).split(",", 1)[0]?.trim()
			: "";
	const clientAddress = forwardedAddress || directAddress;
	return digestIdentity(clientAddress);
}

function consumeBucket(cache: LRUCache<string, number[]>, key: string): number {
	const tokenCount = cache.get(key) || [0];
	if (tokenCount[0] === 0) cache.set(key, tokenCount);
	tokenCount[0] += 1;
	return tokenCount[0];
}

export default function rateLimit(options?: Options) {
	const cacheOptions = {
		max: options?.uniqueTokenPerInterval || 500,
		ttl: options?.interval || 60000,
	};
	const clientCache = new LRUCache<string, number[]>(cacheOptions);
	const subjectCache = new LRUCache<string, number[]>(cacheOptions);

	return {
		check: (res: NextApiResponse, limit: number, scope: string, subject?: string) =>
			new Promise<void>((resolve, reject) => {
				const usages = [consumeBucket(clientCache, `${scope}:${requestIdentity(res)}`)];
				const normalizedSubject = subject?.trim();
				if (normalizedSubject) {
					usages.push(
						consumeBucket(subjectCache, `${scope}:${digestIdentity(normalizedSubject)}`),
					);
				}

				const strictestUsage = Math.max(...usages);
				const isRateLimited = usages.some((usage) => usage > limit);
				res.setHeader("X-RateLimit-Limit", limit);
				res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - strictestUsage));

				return isRateLimited ? reject() : resolve();
			}),
		reset: () => {
			clientCache.clear();
			subjectCache.clear();
		},
	};
}
