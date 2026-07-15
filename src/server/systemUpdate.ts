const DEFAULT_BUILD_STATUS_URL =
	"https://api.github.com/repos/csbsgyl/ztnet-custom/actions/workflows/ghcr-image.yml/runs?branch=main&status=success&per_page=1";
const DEFAULT_UPDATER_URL = "http://updater:8080";
const REQUEST_TIMEOUT_MS = 8000;
const BUILD_CACHE_MS = 60_000;

type UpdaterConnection = "connected" | "error" | "unavailable";

interface LatestBuild {
	commit: string;
	builtAt: string | null;
	url: string | null;
}

interface WorkflowRunsResponse {
	workflow_runs?: Array<{
		head_sha?: string;
		updated_at?: string;
		html_url?: string;
	}>;
}

let latestBuildCache:
	| {
			expiresAt: number;
			value: LatestBuild | null;
	  }
	| undefined;

const fetchWithTimeout = async (url: string, init?: RequestInit) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

const getUpdaterConfig = () => ({
	url: (process.env.UPDATE_API_URL || DEFAULT_UPDATER_URL).replace(/\/+$/, ""),
	token: process.env.UPDATE_API_TOKEN || "",
});

const normalizeCommit = (version: string | undefined) => {
	const match = version?.toLowerCase().match(/(?:sha-)?([0-9a-f]{7,40})/);
	return match?.[1] || null;
};

const commitsMatch = (current: string, latest: string) =>
	current.startsWith(latest) || latest.startsWith(current);

const getLatestBuild = async (): Promise<LatestBuild | null> => {
	if (latestBuildCache && latestBuildCache.expiresAt > Date.now()) {
		return latestBuildCache.value;
	}

	let latestBuild: LatestBuild | null = null;
	try {
		const response = await fetchWithTimeout(
			process.env.UPDATE_CHECK_URL || DEFAULT_BUILD_STATUS_URL,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "ztnet-custom-update-checker",
				},
			},
		);
		if (response.ok) {
			const data = (await response.json()) as WorkflowRunsResponse;
			const run = data.workflow_runs?.[0];
			if (run?.head_sha) {
				latestBuild = {
					commit: run.head_sha.toLowerCase(),
					builtAt: run.updated_at || null,
					url: run.html_url || null,
				};
			}
		}
	} catch {
		latestBuild = null;
	}

	latestBuildCache = {
		value: latestBuild,
		expiresAt: Date.now() + BUILD_CACHE_MS,
	};
	return latestBuild;
};

const getUpdaterConnection = async (): Promise<UpdaterConnection> => {
	const { url, token } = getUpdaterConfig();
	if (process.env.AUTO_UPDATE !== "true" || !token) {
		return "unavailable";
	}

	try {
		const response = await fetchWithTimeout(`${url}/v1/metrics`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		return response.ok ? "connected" : "error";
	} catch {
		return "error";
	}
};

export const getSystemUpdateStatus = async () => {
	const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "development";
	const currentCommit = normalizeCommit(currentVersion);
	const [latestBuild, updaterConnection] = await Promise.all([
		getLatestBuild(),
		getUpdaterConnection(),
	]);
	const interval = Number.parseInt(process.env.AUTO_UPDATE_INTERVAL || "3600", 10);

	return {
		currentVersion,
		currentCommit,
		latestBuild,
		updateAvailable:
			currentCommit && latestBuild
				? !commitsMatch(currentCommit, latestBuild.commit)
				: null,
		autoUpdateEnabled: process.env.AUTO_UPDATE === "true",
		updateIntervalSeconds: Number.isFinite(interval) ? interval : 3600,
		updaterConnection,
		image: process.env.ZTNET_IMAGE || null,
		checkedAt: new Date().toISOString(),
	};
};

export const triggerSystemUpdate = async () => {
	const { url, token } = getUpdaterConfig();
	if (process.env.AUTO_UPDATE !== "true" || !token) {
		throw new Error("The update service is not configured for this deployment.");
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(`${url}/v1/update?async=true`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
	} catch {
		throw new Error("The update service is not reachable.");
	}

	if (response.status === 429) {
		const responseBody = await response.text().catch(() => "");
		if (responseBody.toLowerCase().includes("another update is already running")) {
			return {
				accepted: true,
				alreadyRunning: true,
				triggeredAt: new Date().toISOString(),
			};
		}
	}

	if (!response.ok) {
		throw new Error(`The update service rejected the request (${response.status}).`);
	}

	return {
		accepted: true,
		alreadyRunning: false,
		triggeredAt: new Date().toISOString(),
	};
};

export const resetSystemUpdateCacheForTests = () => {
	latestBuildCache = undefined;
};
