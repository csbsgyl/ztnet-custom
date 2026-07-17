jest.mock("~/utils/docker", () => ({
	isRunningInDocker: jest.fn(() => true),
}));

import {
	getZeroTierRestartStatus,
	restartZeroTier,
	resetZeroTierRestartStateForTests,
} from "~/server/zeroTierRestart";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const fetchMock = jest.fn();
const restartApiUrl = "http://restart-helper:8080";
const restartApiToken = "zero-tier-restart-token-must-not-leak";
const manualCommand = "docker compose restart zerotier";

describe("ZeroTier restart service", () => {
	beforeEach(() => {
		process.env = {
			...originalEnv,
			RESTART_API_URL: `${restartApiUrl}/`,
			RESTART_API_TOKEN: restartApiToken,
		};
		global.fetch = fetchMock;
		fetchMock.mockReset();
		resetZeroTierRestartStateForTests();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	afterAll(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
	});

	it("reports an unavailable helper without configuration and keeps a manual fallback", async () => {
		Reflect.deleteProperty(process.env, "RESTART_API_URL");
		Reflect.deleteProperty(process.env, "RESTART_API_TOKEN");

		await expect(getZeroTierRestartStatus()).resolves.toEqual({
			connection: "unavailable",
			manualCommand,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports a connected authenticated health endpoint", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ status: "ok", docker: "connected" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(getZeroTierRestartStatus()).resolves.toEqual({
			connection: "connected",
			manualCommand,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`${restartApiUrl}/v1/health`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Bearer ${restartApiToken}`,
				}),
			}),
		);
	});

	it("reports an error when health authentication is rejected", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

		await expect(getZeroTierRestartStatus()).resolves.toEqual({
			connection: "error",
			manualCommand,
		});
	});

	it("reports an error instead of throwing when the health endpoint is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error(`connect failed: Bearer ${restartApiToken}`));

		await expect(getZeroTierRestartStatus()).resolves.toEqual({
			connection: "error",
			manualCommand,
		});
	});

	it("refuses a restart when the helper is not configured", async () => {
		Reflect.deleteProperty(process.env, "RESTART_API_TOKEN");

		const error = await restartZeroTier().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/not configured/i);
		expect((error as Error).message).not.toContain(restartApiToken);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends an authenticated restart request and returns a timestamped result", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ restarted: true, restartedAt: "2026-07-17T12:00:00.000Z" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await restartZeroTier();

		expect(result).toMatchObject({ restarted: true, alreadyRunning: false });
		expect(Number.isNaN(Date.parse(result.restartedAt))).toBe(false);
		expect(fetchMock).toHaveBeenCalledWith(
			`${restartApiUrl}/v1/restart-zerotier`,
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: `Bearer ${restartApiToken}`,
				}),
			}),
		);
	});

	it("keeps an in-progress restart distinct from a completed restart", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "restart_in_progress" } }), {
				status: 409,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(restartZeroTier()).resolves.toEqual({
			restarted: false,
			alreadyRunning: true,
		});
	});

	it("does not treat an unrelated conflict as an in-progress restart", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "other_conflict" } }), {
				status: 409,
			}),
		);

		await expect(restartZeroTier()).rejects.toThrow(/rejected.*409/i);
	});

	it("rejects a successful status with an invalid helper payload", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ restarted: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(restartZeroTier()).rejects.toThrow(/invalid response/i);
	});

	it("aborts a restart that exceeds the request timeout", async () => {
		jest.useFakeTimers();
		fetchMock.mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The request was aborted.", "AbortError"));
					});
				}),
		);

		const pendingError = restartZeroTier().catch((cause: unknown) => cause);
		await jest.advanceTimersByTimeAsync(60_000);
		const error = await pendingError;

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/timed out/i);
		expect((error as Error).message).not.toContain(restartApiToken);
	});

	it("sanitizes a rejected helper response without exposing its body or token", async () => {
		fetchMock.mockResolvedValue(
			new Response(`invalid Bearer ${restartApiToken}`, { status: 403 }),
		);

		const error = await restartZeroTier().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/rejected.*403/i);
		expect((error as Error).message).not.toContain(restartApiToken);
	});

	it("sanitizes network failures without exposing the configured token", async () => {
		fetchMock.mockRejectedValue(
			new Error(`socket error while using Bearer ${restartApiToken}`),
		);

		const error = await restartZeroTier().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/not reachable/i);
		expect((error as Error).message).not.toContain(restartApiToken);
	});
});
