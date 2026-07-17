import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createContainerOpsServer, createDockerClient } from "../../container-ops.mjs";

const TOKEN = "t".repeat(32);
const SCOPE = "ztnet-test";
const TARGET_ID = "a".repeat(64);

function target(scope = SCOPE) {
	return {
		Id: TARGET_ID,
		Labels: {
			"io.ztnet.instance": scope,
			"io.ztnet.role": "zerotier",
			"io.ztnet.restart-enabled": "true",
		},
	};
}

/**
 * @param {ReturnType<typeof createDockerClient>} dockerClient
 * @param {(baseUrl: string) => Promise<void>} callback
 */
async function withServer(dockerClient, callback) {
	const logger = { log() {}, warn() {}, error() {} };
	const server = createContainerOpsServer({ token: TOKEN, scope: SCOPE, dockerClient, logger });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
	try {
		await callback(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

function authorized(method = "GET") {
	return { method, headers: { Authorization: `Bearer ${TOKEN}` } };
}

test("Docker client uses only fixed label filters and restart path", async () => {
	const calls = [];
	const client = createDockerClient({
		socketPath: "/test/docker.sock",
		async requestDocker(options) {
			calls.push(options);
			if (options.path === `/containers/${TARGET_ID}/json`) {
				return {
					statusCode: 200,
					body: JSON.stringify({ State: { Running: true, Status: "running" } }),
				};
			}
			if (options.method === "GET") {
				return { statusCode: 200, body: JSON.stringify([target()]) };
			}
			return { statusCode: 204, body: "" };
		},
	});

	await client.listRestartTargets(SCOPE);
	await client.restartContainer(TARGET_ID);

	assert.equal(calls[0].socketPath, "/test/docker.sock");
	assert.equal(calls[0].method, "GET");
	const query = new URL(calls[0].path, "http://docker").searchParams;
	assert.equal(query.get("all"), "1");
	assert.deepEqual(JSON.parse(query.get("filters")), {
		label: [
			`io.ztnet.instance=${SCOPE}`,
			"io.ztnet.role=zerotier",
			"io.ztnet.restart-enabled=true",
		],
	});
	assert.deepEqual(calls[1], {
		socketPath: "/test/docker.sock",
		method: "POST",
		path: `/containers/${TARGET_ID}/restart?t=10`,
		timeoutMs: 15_000,
	});
	assert.deepEqual(calls[2], {
		socketPath: "/test/docker.sock",
		method: "GET",
		path: `/containers/${TARGET_ID}/json`,
		timeoutMs: 3_000,
	});
});

test("Docker client verifies that ZeroTier remains running", async () => {
	const client = createDockerClient({
		async requestDocker(options) {
			if (options.method === "POST") return { statusCode: 204, body: "" };
			return {
				statusCode: 200,
				body: JSON.stringify({ State: { Running: false, Status: "exited" } }),
			};
		},
	});

	await assert.rejects(() => client.restartContainer(TARGET_ID), /did not remain running/i);
});

test("health requires authentication and checks Docker", async () => {
	let pingCount = 0;
	let targetQueryCount = 0;
	await withServer(
		{
			async ping() {
				pingCount += 1;
			},
			async listRestartTargets() {
				targetQueryCount += 1;
				return [target()];
			},
			async restartContainer() {},
		},
		async (baseUrl) => {
			const unauthorized = await fetch(`${baseUrl}/v1/health`);
			assert.equal(unauthorized.status, 401);
			assert.equal((await unauthorized.json()).error.code, "unauthorized");

			const healthy = await fetch(`${baseUrl}/v1/health`, authorized());
			assert.equal(healthy.status, 200);
			const payload = await healthy.json();
			assert.equal(payload.status, "ok");
			assert.equal(payload.docker, "connected");
			assert.equal(payload.scope, SCOPE);
			assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
		},
	);
	assert.equal(pingCount, 1);
	assert.equal(targetQueryCount, 1);
});

test("restart resolves the fixed labeled target and accepts no input", async () => {
	let observedScope;
	let restartedId;
	await withServer(
		{
			async ping() {},
			async listRestartTargets(scope) {
				observedScope = scope;
				return [target(scope)];
			},
			async restartContainer(id) {
				restartedId = id;
			},
		},
		async (baseUrl) => {
			const queryRejected = await fetch(
				`${baseUrl}/v1/restart-zerotier?container=anything`,
				authorized("POST"),
			);
			assert.equal(queryRejected.status, 400);
			assert.equal((await queryRejected.json()).error.code, "invalid_request");

			const rejected = await fetch(`${baseUrl}/v1/restart-zerotier`, {
				...authorized("POST"),
				headers: { ...authorized("POST").headers, "Content-Type": "application/json" },
				body: JSON.stringify({ container: "anything" }),
			});
			assert.equal(rejected.status, 400);
			assert.equal((await rejected.json()).error.code, "request_body_not_allowed");

			const restarted = await fetch(`${baseUrl}/v1/restart-zerotier`, authorized("POST"));
			assert.equal(restarted.status, 200);
			const payload = await restarted.json();
			assert.equal(payload.restarted, true);
			assert.equal(Number.isNaN(Date.parse(payload.restartedAt)), false);
			assert.equal(payload.status, "restarted");
			assert.equal(payload.role, "zerotier");
		},
	);
	assert.equal(observedScope, SCOPE);
	assert.equal(restartedId, TARGET_ID);
});

test("restart refuses missing or ambiguous targets", async () => {
	const cases = [
		{ containers: [], expectedCode: "target_not_found" },
		{ containers: [target(), target()], expectedCode: "target_not_unique" },
		{ containers: [target("another-scope")], expectedCode: "target_label_mismatch" },
	];
	for (const { containers, expectedCode } of cases) {
		await withServer(
			{
				async ping() {},
				async listRestartTargets() {
					return containers;
				},
				async restartContainer() {
					assert.fail("restart must not run without one unique target");
				},
			},
			async (baseUrl) => {
				const response = await fetch(
					`${baseUrl}/v1/restart-zerotier`,
					authorized("POST"),
				);
				const payload = await response.json();
				assert.equal(payload.error.code, expectedCode);
				assert.equal(response.status, expectedCode === "target_not_found" ? 404 : 412);
			},
		);
	}
});

test("restart is single-flight", async () => {
	let releaseRestart;
	let restartStarted;
	const started = new Promise((resolve) => {
		restartStarted = resolve;
	});
	const release = new Promise((resolve) => {
		releaseRestart = resolve;
	});

	await withServer(
		{
			async ping() {},
			async listRestartTargets() {
				return [target()];
			},
			async restartContainer() {
				restartStarted();
				await release;
			},
		},
		async (baseUrl) => {
			const first = fetch(`${baseUrl}/v1/restart-zerotier`, authorized("POST"));
			await started;
			const second = await fetch(`${baseUrl}/v1/restart-zerotier`, authorized("POST"));
			assert.equal(second.status, 409);
			assert.equal((await second.json()).error.code, "restart_in_progress");
			releaseRestart();
			assert.equal((await first).status, 200);
		},
	);
});

test("restart timeout blocks an immediate retry while the result is uncertain", async () => {
	await withServer(
		{
			async ping() {},
			async listRestartTargets() {
				return [target()];
			},
			async restartContainer() {
				throw Object.assign(new Error("Docker request timed out."), {
					code: "docker_timeout",
				});
			},
		},
		async (baseUrl) => {
			const first = await fetch(`${baseUrl}/v1/restart-zerotier`, authorized("POST"));
			assert.equal(first.status, 500);

			const second = await fetch(`${baseUrl}/v1/restart-zerotier`, authorized("POST"));
			assert.equal(second.status, 409);
			assert.equal((await second.json()).error.code, "restart_in_progress");
		},
	);
});
