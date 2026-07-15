import {
	getSystemUpdateStatus,
	resetSystemUpdateCacheForTests,
	triggerSystemUpdate,
} from "~/server/systemUpdate";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const fetchMock = jest.fn();
const OLD_COMMIT = "abc1234567890abc1234567890abc1234567890";
const NEW_COMMIT = "def1234567890def1234567890def1234567890";

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});

const registryResponse = (url: string, commit: string) => {
	if (url.endsWith("/manifests/latest")) {
		return jsonResponse({
			manifests: [
				{
					digest: "sha256:platform",
					platform: { architecture: "amd64", os: "linux" },
				},
			],
		});
	}
	if (url.endsWith("/manifests/sha256%3Aplatform")) {
		return jsonResponse({ config: { digest: "sha256:config" } });
	}
	if (url.endsWith("/blobs/sha256%3Aconfig")) {
		return jsonResponse({
			created: "2026-07-14T04:00:00Z",
			config: {
				Labels: {
					"org.opencontainers.image.created": "2026-07-14T04:00:00Z",
					"org.opencontainers.image.revision": commit,
					"org.opencontainers.image.source": "https://github.com/csbsgyl/ztnet-custom",
				},
			},
		});
	}
	return null;
};

describe("system update service", () => {
	beforeEach(() => {
		process.env = {
			...originalEnv,
			AUTO_UPDATE: "true",
			AUTO_UPDATE_INTERVAL: "600",
			UPDATE_API_URL: "http://updater:8080",
			UPDATE_API_TOKEN: "update-token",
			NEXT_PUBLIC_APP_VERSION: OLD_COMMIT,
			ZTNET_IMAGE: "ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest",
		};
		global.fetch = fetchMock;
		fetchMock.mockReset();
		resetSystemUpdateCacheForTests();
	});

	afterAll(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
	});

	it("reads the latest build from the configured image registry when GitHub is unavailable", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("api.github.com")) return new Response(null, { status: 503 });
			const registry = registryResponse(url, NEW_COMMIT);
			return registry || new Response(null, { status: 200 });
		});

		const status = await getSystemUpdateStatus();

		expect(status.updateAvailable).toBe(true);
		expect(status.latestBuild?.commit).toBe(NEW_COMMIT);
		expect(status.latestBuild?.url).toBe(
			`https://github.com/csbsgyl/ztnet-custom/commit/${NEW_COMMIT}`,
		);
		expect(status.updaterConnection).toBe("connected");
		expect(status.autoUpdateEnabled).toBe(true);
		expect(status.updateIntervalSeconds).toBe(600);
		expect(status.image).toBe("ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("api.github.com"),
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": "ztnet-custom-update-checker",
				}),
			}),
		);
	});

	it("falls back to the successful GitHub workflow when registry metadata is unavailable", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("api.github.com")) {
				return jsonResponse({
					workflow_runs: [
						{
							head_sha: NEW_COMMIT,
							updated_at: "2026-07-14T04:00:00Z",
							html_url: "https://github.com/example/run",
						},
					],
				});
			}
			if (url.includes("/v1/metrics")) return new Response(null, { status: 200 });
			return new Response(null, { status: 503 });
		});

		const status = await getSystemUpdateStatus();

		expect(status.latestBuild).toEqual({
			commit: NEW_COMMIT,
			builtAt: "2026-07-14T04:00:00Z",
			url: "https://github.com/example/run",
		});
		expect(status.updateAvailable).toBe(true);
	});

	it("bypasses the one-minute cache for an explicit update check", async () => {
		let registryCommit = OLD_COMMIT;
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("api.github.com")) return new Response(null, { status: 503 });
			const registry = registryResponse(url, registryCommit);
			return registry || new Response(null, { status: 200 });
		});

		const initial = await getSystemUpdateStatus();
		registryCommit = NEW_COMMIT;
		const cached = await getSystemUpdateStatus();
		const refreshed = await getSystemUpdateStatus({ forceRefresh: true });

		expect(initial.latestBuild?.commit).toBe(OLD_COMMIT);
		expect(cached.latestBuild?.commit).toBe(OLD_COMMIT);
		expect(refreshed.latestBuild?.commit).toBe(NEW_COMMIT);
		expect(
			fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/manifests/latest")),
		).toHaveLength(2);
	});

	it("follows a registry bearer challenge for official GHCR images", async () => {
		process.env.ZTNET_IMAGE = "ghcr.io/csbsgyl/ztnet-custom:latest";
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.includes("api.github.com")) return new Response(null, { status: 503 });
			if (url.startsWith("https://ghcr.io/token")) {
				return jsonResponse({ token: "registry-token" });
			}
			if (
				url.includes("ghcr.io/v2/") &&
				!new Headers(init?.headers).has("Authorization")
			) {
				return new Response(null, {
					status: 401,
					headers: {
						"WWW-Authenticate":
							'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:csbsgyl/ztnet-custom:pull"',
					},
				});
			}
			const registry = registryResponse(url, NEW_COMMIT);
			return registry || new Response(null, { status: 200 });
		});

		const status = await getSystemUpdateStatus({ forceRefresh: true });

		expect(status.latestBuild?.commit).toBe(NEW_COMMIT);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ghcr.io/v2/csbsgyl/ztnet-custom/manifests/latest",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer registry-token" }),
			}),
		);
	});

	it("reports an unavailable updater when automatic updates are disabled", async () => {
		process.env.AUTO_UPDATE = "false";
		process.env.UPDATE_API_TOKEN = "";
		fetchMock.mockResolvedValue({ ok: false });

		const status = await getSystemUpdateStatus();

		expect(status.autoUpdateEnabled).toBe(false);
		expect(status.updaterConnection).toBe("unavailable");
		expect(fetchMock).not.toHaveBeenCalledWith(
			"http://updater:8080/v1/metrics",
			expect.anything(),
		);
	});

	it("triggers the scoped updater with its bearer token", async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });

		await expect(triggerSystemUpdate()).resolves.toMatchObject({
			accepted: true,
			alreadyRunning: false,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://updater:8080/v1/update?async=true",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer update-token" },
			}),
		);
	});

	it("continues monitoring when Watchtower reports an update already running", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 429,
			text: async () => JSON.stringify({ error: "another update is already running" }),
		});

		await expect(triggerSystemUpdate()).resolves.toMatchObject({
			accepted: true,
			alreadyRunning: true,
		});
	});

	it("does not mistake a generic rate-limit response for a running update", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 429,
			text: async () => "",
		});

		await expect(triggerSystemUpdate()).rejects.toThrow("rejected the request (429)");
	});

	it("refuses manual updates when the updater token is absent", async () => {
		process.env.UPDATE_API_TOKEN = "";

		await expect(triggerSystemUpdate()).rejects.toThrow("not configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
