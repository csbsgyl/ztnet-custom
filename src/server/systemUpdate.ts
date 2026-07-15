const DEFAULT_BUILD_STATUS_URL =
	"https://api.github.com/repos/csbsgyl/ztnet-custom/actions/workflows/ghcr-image.yml/runs?branch=main&status=success&per_page=1";
const DEFAULT_ZTNET_IMAGE = "ghcr.io/csbsgyl/ztnet-custom:latest";
const DEFAULT_UPDATER_URL = "http://updater:8080";
const REQUEST_TIMEOUT_MS = 8000;
const BUILD_CACHE_MS = 60_000;
const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type UpdaterConnection = "connected" | "error" | "unavailable";

interface LatestBuild {
	commit: string;
	builtAt: string | null;
	url: string | null;
}

interface ImageReference {
	registry: string;
	repository: string;
	reference: string;
}

interface RegistryManifest {
	config?: { digest?: string };
	manifests?: Array<{
		digest?: string;
		platform?: { architecture?: string; os?: string };
	}>;
}

interface RegistryImageConfig {
	created?: string;
	config?: {
		Env?: string[];
		Labels?: Record<string, string>;
	};
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

const parseImageReference = (image: string): ImageReference | null => {
	const withoutDigest = image.split("@", 1)[0];
	const slashIndex = withoutDigest.indexOf("/");
	if (slashIndex <= 0) return null;

	const registry = withoutDigest.slice(0, slashIndex);
	const path = withoutDigest.slice(slashIndex + 1);
	const lastSlash = path.lastIndexOf("/");
	const colonIndex = path.lastIndexOf(":");
	const hasTag = colonIndex > lastSlash;
	const repository = hasTag ? path.slice(0, colonIndex) : path;
	const reference = hasTag ? path.slice(colonIndex + 1) : "latest";
	if (!registry || !repository || !reference) return null;

	return { registry, repository, reference };
};

const parseBearerChallenge = (value: string | null) => {
	if (!value?.toLowerCase().startsWith("bearer ")) return null;
	const parameters = Object.fromEntries(
		Array.from(value.matchAll(/([a-z_]+)="([^"]*)"/gi), (match) => [
			match[1].toLowerCase(),
			match[2],
		]),
	);
	if (!parameters.realm) return null;
	return parameters;
};

const fetchRegistryResource = async (url: string, accept: string) => {
	const headers = { Accept: accept };
	let response = await fetchWithTimeout(url, { headers });
	if (response.status !== 401) return response;

	const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
	if (!challenge) return response;
	const tokenUrl = new URL(challenge.realm);
	if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
	if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
	const tokenResponse = await fetchWithTimeout(tokenUrl.toString(), {
		headers: { Accept: "application/json" },
	});
	if (!tokenResponse.ok) return response;
	const tokenData = (await tokenResponse.json()) as {
		token?: string;
		access_token?: string;
	};
	const token = tokenData.token || tokenData.access_token;
	if (!token) return response;

	response = await fetchWithTimeout(url, {
		headers: { ...headers, Authorization: `Bearer ${token}` },
	});
	return response;
};

const runtimeArchitecture = () => {
	switch (process.arch) {
		case "x64":
			return "amd64";
		case "arm64":
			return "arm64";
		default:
			return process.arch;
	}
};

const getLatestRegistryBuild = async (image: string): Promise<LatestBuild | null> => {
	const parsed = parseImageReference(image);
	if (!parsed) return null;
	const baseUrl = `https://${parsed.registry}/v2/${parsed.repository}`;
	let response = await fetchRegistryResource(
		`${baseUrl}/manifests/${encodeURIComponent(parsed.reference)}`,
		MANIFEST_ACCEPT,
	);
	if (!response.ok) return null;
	let manifest = (await response.json()) as RegistryManifest;

	if (!manifest.config?.digest && manifest.manifests?.length) {
		const architecture = runtimeArchitecture();
		const platformManifest =
			manifest.manifests.find(
				(candidate) =>
					candidate.platform?.os === "linux" &&
					candidate.platform.architecture === architecture,
			) || manifest.manifests.find((candidate) => candidate.platform?.os === "linux");
		if (!platformManifest?.digest) return null;
		response = await fetchRegistryResource(
			`${baseUrl}/manifests/${encodeURIComponent(platformManifest.digest)}`,
			MANIFEST_ACCEPT,
		);
		if (!response.ok) return null;
		manifest = (await response.json()) as RegistryManifest;
	}

	const configDigest = manifest.config?.digest;
	if (!configDigest) return null;
	response = await fetchRegistryResource(
		`${baseUrl}/blobs/${encodeURIComponent(configDigest)}`,
		"application/vnd.oci.image.config.v1+json, application/json",
	);
	if (!response.ok) return null;
	const imageConfig = (await response.json()) as RegistryImageConfig;
	const labels = imageConfig.config?.Labels || {};
	const envVersion = imageConfig.config?.Env?.find((value) =>
		value.startsWith("NEXT_PUBLIC_APP_VERSION="),
	);
	const commit = normalizeCommit(
		labels["org.opencontainers.image.revision"] || envVersion?.split("=", 2)[1],
	);
	if (!commit) return null;
	const source = labels["org.opencontainers.image.source"];

	return {
		commit,
		builtAt: labels["org.opencontainers.image.created"] || imageConfig.created || null,
		url: source ? `${source.replace(/\/+$/, "")}/commit/${commit}` : null,
	};
};

const getLatestWorkflowBuild = async (): Promise<LatestBuild | null> => {
	const response = await fetchWithTimeout(
		process.env.UPDATE_CHECK_URL || DEFAULT_BUILD_STATUS_URL,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "ztnet-custom-update-checker",
			},
		},
	);
	if (!response.ok) return null;
	const data = (await response.json()) as WorkflowRunsResponse;
	const run = data.workflow_runs?.[0];
	if (!run?.head_sha) return null;
	return {
		commit: run.head_sha.toLowerCase(),
		builtAt: run.updated_at || null,
		url: run.html_url || null,
	};
};

const getLatestBuild = async (forceRefresh = false): Promise<LatestBuild | null> => {
	if (!forceRefresh && latestBuildCache && latestBuildCache.expiresAt > Date.now()) {
		return latestBuildCache.value;
	}

	const [workflowBuild, registryBuild] = await Promise.all([
		getLatestWorkflowBuild().catch(() => null),
		getLatestRegistryBuild(process.env.ZTNET_IMAGE || DEFAULT_ZTNET_IMAGE).catch(
			() => null,
		),
	]);
	const latestBuild = workflowBuild || registryBuild;

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

export const getSystemUpdateStatus = async ({ forceRefresh = false } = {}) => {
	const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "development";
	const currentCommit = normalizeCommit(currentVersion);
	const [latestBuild, updaterConnection] = await Promise.all([
		getLatestBuild(forceRefresh),
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
