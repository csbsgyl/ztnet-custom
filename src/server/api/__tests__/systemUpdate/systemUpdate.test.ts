import {
	getSystemUpdateStatus,
	resetSystemUpdateCacheForTests,
	triggerSystemUpdate,
} from "~/server/systemUpdate";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const fetchMock = jest.fn();

describe("system update service", () => {
	beforeEach(() => {
		process.env = {
			...originalEnv,
			AUTO_UPDATE: "true",
			AUTO_UPDATE_INTERVAL: "600",
			UPDATE_API_URL: "http://updater:8080",
			UPDATE_API_TOKEN: "update-token",
			NEXT_PUBLIC_APP_VERSION: "abc1234567890abc1234567890abc1234567890",
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

	it("reports the latest successful image build and updater connection", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("api.github.com")) {
				return {
					ok: true,
					json: async () => ({
						workflow_runs: [
							{
								head_sha: "def1234567890def1234567890def1234567890",
								updated_at: "2026-07-14T04:00:00Z",
								html_url: "https://github.com/example/run",
							},
						],
					}),
				};
			}
			return { ok: true };
		});

		const status = await getSystemUpdateStatus();

		expect(status.updateAvailable).toBe(true);
		expect(status.latestBuild?.commit).toBe("def1234567890def1234567890def1234567890");
		expect(status.updaterConnection).toBe("connected");
		expect(status.autoUpdateEnabled).toBe(true);
		expect(status.updateIntervalSeconds).toBe(600);
		expect(status.image).toBe("ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest");
	});

	it("reports an unavailable updater when automatic updates are disabled", async () => {
		process.env.AUTO_UPDATE = "false";
		process.env.UPDATE_API_TOKEN = "";
		fetchMock.mockResolvedValue({ ok: false });

		const status = await getSystemUpdateStatus();

		expect(status.autoUpdateEnabled).toBe(false);
		expect(status.updaterConnection).toBe("unavailable");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("triggers the scoped updater with its bearer token", async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });

		await expect(triggerSystemUpdate()).resolves.toMatchObject({ accepted: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://updater:8080/v1/update?async=true",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer update-token" },
			}),
		);
	});

	it("refuses manual updates when the updater token is absent", async () => {
		process.env.UPDATE_API_TOKEN = "";

		await expect(triggerSystemUpdate()).rejects.toThrow("not configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
