import type { NextApiResponse } from "next";
import rateLimit from "~/utils/rateLimit";

function response(
	address: string,
	headers: Record<string, string> = {},
): NextApiResponse {
	return {
		req: { headers, socket: { remoteAddress: address } },
		setHeader: jest.fn(),
	} as unknown as NextApiResponse;
}

describe("rateLimit", () => {
	const previousTrustProxy = process.env.RATE_LIMIT_TRUST_PROXY;

	afterEach(() => {
		if (previousTrustProxy === undefined) process.env.RATE_LIMIT_TRUST_PROXY = undefined;
		else process.env.RATE_LIMIT_TRUST_PROXY = previousTrustProxy;
	});

	it("allows exactly the configured number of requests", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const res = response("203.0.113.10");

		await expect(limiter.check(res, 2, "login")).resolves.toBeUndefined();
		await expect(limiter.check(res, 2, "login")).resolves.toBeUndefined();
		await expect(limiter.check(res, 2, "login")).rejects.toBeUndefined();
	});

	it("keeps client buckets independent", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const first = response("203.0.113.11");
		const second = response("203.0.113.12");

		await limiter.check(first, 1, "password-reset", "first@example.com");
		await expect(
			limiter.check(second, 1, "password-reset", "second@example.com"),
		).resolves.toBeUndefined();
	});

	it("does not allow one client to bypass its limit by rotating subjects", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const client = response("203.0.113.11");

		await limiter.check(client, 1, "password-reset", "first@example.com");
		await expect(
			limiter.check(client, 1, "password-reset", "second@example.com"),
		).rejects.toBeUndefined();
	});

	it("shares a subject limit across client addresses", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const first = response("203.0.113.11");
		const second = response("203.0.113.12");

		await limiter.check(first, 1, "password-reset", "target@example.com");
		await expect(
			limiter.check(second, 1, "password-reset", "target@example.com"),
		).rejects.toBeUndefined();
	});

	it("reports remaining capacity from the stricter bucket", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const client = response("203.0.113.13");

		await limiter.check(client, 2, "password-reset", "first@example.com");
		await limiter.check(client, 2, "password-reset", "second@example.com");

		expect(client.setHeader).toHaveBeenLastCalledWith("X-RateLimit-Remaining", 0);
	});

	it("does not allow rotating API credentials to bypass the client bucket", async () => {
		const limiter = rateLimit({ interval: 60_000 });
		const first = response("127.0.0.1", { "x-ztnet-auth": "token-a" });
		const second = response("127.0.0.1", { "x-ztnet-auth": "token-b" });

		await limiter.check(first, 1, "api");
		await expect(limiter.check(second, 1, "api")).rejects.toBeUndefined();
	});

	it("uses forwarded addresses only when the proxy is explicitly trusted", async () => {
		process.env.RATE_LIMIT_TRUST_PROXY = "true";
		const limiter = rateLimit({ interval: 60_000 });
		const first = response("127.0.0.1", { "x-forwarded-for": "198.51.100.1" });
		const second = response("127.0.0.1", { "x-forwarded-for": "198.51.100.2" });

		await limiter.check(first, 1, "api");
		await expect(limiter.check(second, 1, "api")).resolves.toBeUndefined();
	});
});
