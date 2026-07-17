import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_PORT = 8081;
const DOCKER_QUERY_TIMEOUT_MS = 3_000;
const DOCKER_RESTART_TIMEOUT_MS = 15_000;
const RESTART_STOP_TIMEOUT_SECONDS = 10;
const RESTART_UNCERTAIN_HOLD_MS = 30_000;
const MAX_DOCKER_RESPONSE_BYTES = 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

/** @typedef {{ statusCode: number, body: string }} DockerResponse */
/** @typedef {{ socketPath: string, method: string, path: string, timeoutMs: number }} DockerRequestOptions */
/** @typedef {(options: DockerRequestOptions) => Promise<DockerResponse>} DockerRequestFunction */
/** @typedef {{ Id: string, Labels: Record<string, string> }} DockerContainer */
/** @typedef {{ ping: () => Promise<void>, listRestartTargets: (scope: string) => Promise<DockerContainer[]>, restartContainer: (containerId: string) => Promise<void> }} DockerClient */
/** @typedef {{ log?: (message?: unknown) => void, warn?: (message?: unknown) => void, error?: (message?: unknown) => void }} OpsLogger */

class OpsError extends Error {
	/**
	 * @param {number} statusCode
	 * @param {string} code
	 * @param {string} message
	 */
	constructor(statusCode, code, message) {
		super(message);
		this.name = "OpsError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

/** @param {string} token @param {string} scope */
function validateConfiguration(token, scope) {
	if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
		throw new Error(`RESTART_API_TOKEN must contain at least ${MIN_TOKEN_LENGTH} characters.`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(scope || "")) {
		throw new Error("OPS_SCOPE must be a valid deployment identifier.");
	}
}

/** @param {string | undefined} header @param {string} expectedToken */
function tokenMatches(header, expectedToken) {
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
	const expected = Buffer.from(expectedToken, "utf8");
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** @param {unknown} error @param {string} expected */
function hasErrorCode(error, expected) {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code === expected
	);
}

/** @param {DockerRequestOptions} options @returns {Promise<DockerResponse>} */
function dockerRequest({ socketPath, method, path, timeoutMs }) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			callback(value);
		};
		const request = httpRequest(
			{
				socketPath,
				method,
				path,
				headers: { Host: "docker", "Content-Length": "0" },
			},
			(response) => {
				/** @type {Buffer[]} */
				const chunks = [];
				let size = 0;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_DOCKER_RESPONSE_BYTES) {
						request.destroy(new Error("Docker response exceeded the size limit."));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					finish(resolve, {
						statusCode: response.statusCode || 500,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);

		request.setTimeout(timeoutMs, () => {
			const error = Object.assign(new Error("Docker request timed out."), {
				code: "ETIMEDOUT",
			});
			request.destroy(error);
		});
		request.on("error", (error) => {
			const timedOut = hasErrorCode(error, "ETIMEDOUT");
			finish(
				reject,
				new OpsError(
					timedOut ? 504 : 502,
					timedOut ? "docker_timeout" : "docker_unavailable",
					timedOut
						? "The Docker operation timed out."
						: "The Docker daemon is unavailable.",
				),
			);
		});
		request.end();
	});
}

/**
 * @param {{ socketPath?: string, requestDocker?: DockerRequestFunction }} [options]
 * @returns {DockerClient}
 */
export function createDockerClient({
	socketPath = DEFAULT_SOCKET_PATH,
	requestDocker = dockerRequest,
} = {}) {
	return {
		async ping() {
			const response = await requestDocker({
				socketPath,
				method: "GET",
				path: "/_ping",
				timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
			});
			if (response.statusCode !== 200 || response.body.trim() !== "OK") {
				throw new OpsError(502, "docker_unhealthy", "The Docker daemon is not healthy.");
			}
		},

		async listRestartTargets(scope) {
			const requiredLabels = [
				`io.ztnet.instance=${scope}`,
				"io.ztnet.role=zerotier",
				"io.ztnet.restart-enabled=true",
			];
			const query = new URLSearchParams({
				all: "1",
				filters: JSON.stringify({ label: requiredLabels }),
			});
			const response = await requestDocker({
				socketPath,
				method: "GET",
				path: `/containers/json?${query.toString()}`,
				timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
			});
			if (response.statusCode !== 200) {
				throw new OpsError(502, "docker_query_failed", "Docker rejected the target query.");
			}
			try {
				const containers = JSON.parse(response.body);
				if (!Array.isArray(containers)) throw new Error("Expected an array.");
				return containers;
			} catch {
				throw new OpsError(502, "docker_invalid_response", "Docker returned invalid target data.");
			}
		},

		async restartContainer(containerId) {
			if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
				throw new OpsError(502, "docker_invalid_target", "Docker returned an invalid target ID.");
			}
			const response = await requestDocker({
				socketPath,
				method: "POST",
				path: `/containers/${containerId}/restart?t=${RESTART_STOP_TIMEOUT_SECONDS}`,
				timeoutMs: DOCKER_RESTART_TIMEOUT_MS,
			});
			if (response.statusCode !== 204) {
				throw new OpsError(502, "docker_restart_failed", "Docker could not restart ZeroTier.");
			}

			const inspectResponse = await requestDocker({
				socketPath,
				method: "GET",
				path: `/containers/${containerId}/json`,
				timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
			});
			if (inspectResponse.statusCode !== 200) {
				throw new OpsError(
					502,
					"docker_inspect_failed",
					"Docker could not verify ZeroTier after the restart.",
				);
			}
			try {
				const inspected = JSON.parse(inspectResponse.body);
				if (
					inspected?.State?.Running !== true ||
					inspected?.State?.Status !== "running" ||
					inspected?.State?.Health?.Status === "unhealthy"
				) {
					throw new Error("ZeroTier is not running.");
				}
			} catch {
				throw new OpsError(
					502,
					"zerotier_not_running",
					"ZeroTier did not remain running after the restart.",
				);
			}
		},
	};
}

/** @param {DockerContainer[]} containers @param {string} scope */
function selectRestartTarget(containers, scope) {
	if (containers.length === 0) {
		throw new OpsError(404, "target_not_found", "The managed ZeroTier container was not found.");
	}
	if (containers.length !== 1) {
		throw new OpsError(
			412,
			"target_not_unique",
			"The managed ZeroTier target is ambiguous; no container was restarted.",
		);
	}

	const target = containers[0];
	const labels = target?.Labels;
	if (
		typeof target?.Id !== "string" ||
		labels?.["io.ztnet.instance"] !== scope ||
		labels?.["io.ztnet.role"] !== "zerotier" ||
		labels?.["io.ztnet.restart-enabled"] !== "true"
	) {
		throw new OpsError(
			412,
			"target_label_mismatch",
			"The Docker target did not match the required restart labels.",
		);
	}
	return target.Id;
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {unknown} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(response, statusCode, payload, extraHeaders = {}) {
	const body = JSON.stringify(payload);
	response.writeHead(statusCode, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"X-Content-Type-Options": "nosniff",
		...extraHeaders,
	});
	response.end(body);
}

/** @param {import("node:http").IncomingMessage} request */
function requestHasBody(request) {
	const contentLength = request.headers["content-length"];
	return (
		request.headers["transfer-encoding"] !== undefined ||
		(contentLength !== undefined && contentLength !== "0")
	);
}

/**
 * @param {OpsLogger} logger
 * @param {"info" | "warn" | "error"} level
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
function logEvent(logger, level, event, fields = {}) {
	const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
	const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
	logger[method]?.(line);
}

/**
 * @param {{ token: string, scope: string, dockerClient: DockerClient, logger?: OpsLogger }} options
 */
export function createContainerOpsServer({ token, scope, dockerClient, logger = console }) {
	validateConfiguration(token, scope);
	if (!dockerClient) throw new Error("A Docker client is required.");

	let restartInFlight = false;
	let restartBlockedUntil = 0;
	return createServer(async (request, response) => {
		const requestId = randomUUID();
		try {
			if (!tokenMatches(request.headers.authorization, token)) {
				throw new OpsError(401, "unauthorized", "A valid Bearer token is required.");
			}

			const url = new URL(request.url || "/", "http://container-ops");
			if (url.search) {
				throw new OpsError(400, "invalid_request", "Query parameters are not accepted.");
			}

			if (request.method === "GET" && url.pathname === "/v1/health") {
				await dockerClient.ping();
				const targets = await dockerClient.listRestartTargets(scope);
				selectRestartTarget(targets, scope);
				sendJson(response, 200, { status: "ok", docker: "connected", scope, requestId });
				return;
			}

			if (request.method === "POST" && url.pathname === "/v1/restart-zerotier") {
				if (requestHasBody(request)) {
					request.resume();
					throw new OpsError(400, "request_body_not_allowed", "This endpoint accepts no body.");
				}
				if (restartInFlight || Date.now() < restartBlockedUntil) {
					throw new OpsError(409, "restart_in_progress", "A ZeroTier restart is already running.");
				}

				restartInFlight = true;
				try {
					const targets = await dockerClient.listRestartTargets(scope);
					const containerId = selectRestartTarget(targets, scope);
					await dockerClient.restartContainer(containerId);
				} catch (error) {
					if (hasErrorCode(error, "docker_timeout")) {
						restartBlockedUntil = Date.now() + RESTART_UNCERTAIN_HOLD_MS;
					}
					throw error;
				} finally {
					restartInFlight = false;
				}

				const restartedAt = new Date().toISOString();
				logEvent(logger, "info", "zerotier_restarted", { requestId, scope, restartedAt });
				sendJson(response, 200, {
					restarted: true,
					restartedAt,
					status: "restarted",
					role: "zerotier",
					scope,
					requestId,
				});
				return;
			}

			throw new OpsError(404, "not_found", "The requested operation does not exist.");
		} catch (error) {
			const known = error instanceof OpsError;
			const statusCode = known ? error.statusCode : 500;
			const code = known ? error.code : "internal_error";
			const message = known ? error.message : "The operation failed unexpectedly.";
			logEvent(logger, statusCode >= 500 ? "error" : "warn", "request_failed", {
				requestId,
				code,
				statusCode,
			});
			sendJson(
				response,
				statusCode,
				{ error: { code, message, requestId } },
				statusCode === 401 ? { "WWW-Authenticate": 'Bearer realm="container-ops"' } : {},
			);
		}
	});
}

/** @returns {Promise<import("node:http").Server>} */
export async function startContainerOps() {
	const token = process.env.RESTART_API_TOKEN || "";
	const scope = process.env.OPS_SCOPE || "";
	/** @type {number} */
	const port = Number.parseInt(process.env.OPS_PORT || String(DEFAULT_PORT), 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("OPS_PORT must be an integer between 1 and 65535.");
	}

	const server = createContainerOpsServer({
		token,
		scope,
		dockerClient: createDockerClient({
			socketPath: process.env.DOCKER_SOCKET_PATH || DEFAULT_SOCKET_PATH,
		}),
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen({ port, host: "0.0.0.0" }, () => resolve(undefined));
	});
	logEvent(console, "info", "container_ops_started", { port, scope });

	const shutdown = () => server.close(() => process.exit(0));
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	startContainerOps().catch((error) => {
		logEvent(console, "error", "container_ops_start_failed", {
			message: error instanceof Error ? error.message : "Unknown startup error.",
		});
		process.exit(1);
	});
}
