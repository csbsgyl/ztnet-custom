import { isRunningInDocker } from "~/utils/docker";

const DEFAULT_RESTART_API_URL = "http://restart-helper:8081";
const REQUEST_TIMEOUT_MS = 30_000;

export type ZeroTierRestartConnection = "connected" | "error" | "unavailable";

interface RestartHelperResponse {
	restarted?: boolean;
	restartedAt?: string;
	error?: {
		code?: string;
	};
}

const getRestartConfig = () => ({
	url: (process.env.RESTART_API_URL || DEFAULT_RESTART_API_URL).replace(/\/+$/, ""),
	token: process.env.RESTART_API_TOKEN || "",
});

const getManualRestartCommand = () =>
	isRunningInDocker()
		? "docker compose restart zerotier"
		: "sudo systemctl restart zerotier-one";

const fetchWithTimeout = async (url: string, init?: RequestInit) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

const authorizationHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/json",
});

export const getZeroTierRestartStatus = async () => {
	const { url, token } = getRestartConfig();
	const manualCommand = getManualRestartCommand();
	if (!token) {
		return {
			connection: "unavailable" as const,
			manualCommand,
		};
	}

	try {
		const response = await fetchWithTimeout(`${url}/v1/health`, {
			headers: authorizationHeaders(token),
		});
		const result = response.ok
			? ((await response.json().catch(() => null)) as {
					status?: string;
					docker?: string;
				} | null)
			: null;
		return {
			connection: (response.ok && result?.status === "ok" && result.docker === "connected"
				? "connected"
				: "error") as ZeroTierRestartConnection,
			manualCommand,
		};
	} catch {
		return {
			connection: "error" as const,
			manualCommand,
		};
	}
};

export const restartZeroTier = async () => {
	const { url, token } = getRestartConfig();
	if (!token) {
		throw new Error(
			"The ZeroTier restart service is not configured for this deployment.",
		);
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(`${url}/v1/restart-zerotier`, {
			method: "POST",
			headers: authorizationHeaders(token),
		});
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"name" in error &&
			error.name === "AbortError"
		) {
			throw new Error("The ZeroTier restart request timed out.");
		}
		throw new Error("The ZeroTier restart service is not reachable.");
	}

	const result = (await response
		.json()
		.catch(() => null)) as RestartHelperResponse | null;
	if (response.status === 409 && result?.error?.code === "restart_in_progress") {
		return {
			restarted: false,
			alreadyRunning: true,
		};
	}
	if (!response.ok) {
		throw new Error(
			`The ZeroTier restart service rejected the request (${response.status}).`,
		);
	}

	if (
		result?.restarted !== true ||
		typeof result.restartedAt !== "string" ||
		Number.isNaN(Date.parse(result.restartedAt))
	) {
		throw new Error("The ZeroTier restart service returned an invalid response.");
	}

	return {
		restarted: true,
		alreadyRunning: false,
		restartedAt: result.restartedAt,
	};
};

export const resetZeroTierRestartStateForTests = () => undefined;
