import { EventEmitter } from "node:events";

jest.mock("node:dns/promises", () => ({
	lookup: jest.fn(),
}));

jest.mock("node:https", () => ({
	request: jest.fn(),
}));

jest.mock("~/server/db", () => ({
	prisma: {
		webhook: {
			findMany: jest.fn(),
		},
	},
}));

import { prisma } from "~/server/db";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { HookType } from "~/types/webhooks";
import {
	isBlockedWebhookAddress,
	sendWebhook,
	validateWebhookUrl,
	WEBHOOK_MAX_CONCURRENCY,
	WEBHOOK_MAX_DELIVERIES_PER_EVENT,
	WEBHOOK_MAX_URL_LENGTH,
	WEBHOOK_REQUEST_TIMEOUT_MS,
} from "~/utils/webhook";

const findMany = prisma.webhook.findMany as jest.Mock;
const lookup = dnsLookup as jest.Mock;
const request = httpsRequest as jest.Mock;

const event = {
	organizationId: "org-1",
	hookType: HookType.NETWORK_CREATED,
	networkId: "network-1",
	userId: "user-1",
	userEmail: "user@example.com",
};

function webhook(url: string, enabled = true) {
	return {
		url,
		enabled,
		eventTypes: [HookType.NETWORK_CREATED],
	};
}

interface MockResponseOptions {
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	delay?: boolean;
}

function mockHttpsResponse({
	status = 204,
	statusText = "No Content",
	headers = {},
	delay = false,
}: MockResponseOptions = {}) {
	request.mockImplementation((_url: URL, options, callback) => {
		const outgoing = new EventEmitter() as EventEmitter & {
			end: jest.Mock;
		};
		outgoing.end = jest.fn(() => {
			if (delay) return;
			setImmediate(() =>
				callback({
					statusCode: status,
					statusMessage: statusText,
					headers,
					destroy: jest.fn(),
				}),
			);
		});
		options.signal?.addEventListener("abort", () => {
			outgoing.emit("error", new Error("aborted"));
		});
		return outgoing;
	});
}

async function waitForRequestCount(expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (request.mock.calls.length === expected) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(
		`Expected ${expected} HTTPS requests, received ${request.mock.calls.length}.`,
	);
}

async function flushBackgroundDelivery(): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("webhook URL validation", () => {
	it.each([
		"0.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.168.1.1",
		"192.0.2.1",
		"198.18.0.1",
		"224.0.0.1",
		"240.0.0.1",
		"::1",
		"fe80::1",
		"fc00::1",
		"2001:db8::1",
		"::ffff:127.0.0.1",
	])("blocks non-public address %s", (address) => {
		expect(isBlockedWebhookAddress(address)).toBe(true);
	});

	it.each([
		"http://8.8.8.8/hook",
		"https://user:password@8.8.8.8/hook",
		"https://127.0.0.1/hook",
		"https://[::1]/hook",
		"https://169.254.169.254/latest/meta-data",
	])("rejects unsafe URL %s", async (url) => {
		await expect(validateWebhookUrl(url)).rejects.toThrow();
	});

	it("rejects an overlong URL", async () => {
		const url = `https://8.8.8.8/${"a".repeat(WEBHOOK_MAX_URL_LENGTH)}`;
		await expect(validateWebhookUrl(url)).rejects.toThrow("too long");
	});

	it("accepts a valid public HTTPS port", async () => {
		await expect(validateWebhookUrl("https://8.8.8.8:9443/hook")).resolves.toEqual(
			new URL("https://8.8.8.8:9443/hook"),
		);
	});

	it("rejects a hostname when any DNS answer is non-public", async () => {
		const lookup = jest.fn().mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "10.0.0.5", family: 4 },
		]);

		await expect(
			validateWebhookUrl("https://hooks.example/hook", lookup),
		).rejects.toThrow("non-public");
	});

	it("accepts a structured HTTPS URL resolving only to public addresses", async () => {
		const lookup = jest.fn().mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "2001:4860:4860::8888", family: 6 },
		]);

		await expect(
			validateWebhookUrl("https://hooks.example/events", lookup),
		).resolves.toEqual(new URL("https://hooks.example/events"));
	});
});

describe("webhook delivery controls", () => {
	beforeEach(() => {
		jest.useRealTimers();
		findMany.mockReset();
		lookup.mockReset();
		lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
		request.mockReset();
		mockHttpsResponse();
		jest.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("queries and sends only enabled matching webhooks", async () => {
		findMany.mockResolvedValue([
			webhook("https://8.8.8.8/enabled"),
			webhook("https://8.8.4.4/disabled", false),
			{
				...webhook("https://1.1.1.1/other-event"),
				eventTypes: [HookType.MEMBER_DELETED],
			},
		]);

		await sendWebhook(event);
		await waitForRequestCount(1);
		await flushBackgroundDelivery();

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", enabled: true },
			}),
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0].toString()).toBe("https://8.8.8.8/enabled");
		const pinnedLookup = request.mock.calls[0][1].lookup;
		const lookupResult = jest.fn();
		pinnedLookup("ignored", {}, lookupResult);
		expect(lookupResult).toHaveBeenCalledWith(null, "8.8.8.8", 4);
	});

	it("finds matching webhooks after non-matching entries", async () => {
		const nonMatching = Array.from(
			{ length: WEBHOOK_MAX_DELIVERIES_PER_EVENT },
			(_, index) => ({
				...webhook(`https://8.8.8.8/other-${index}`),
				eventTypes: [HookType.MEMBER_DELETED],
			}),
		);
		findMany.mockResolvedValue([
			...nonMatching,
			webhook("https://8.8.8.8/matching-after-limit"),
		]);

		await sendWebhook(event);
		await waitForRequestCount(1);
		await flushBackgroundDelivery();

		expect(request.mock.calls[0][0].toString()).toBe(
			"https://8.8.8.8/matching-after-limit",
		);
		expect(findMany).toHaveBeenCalledWith(
			expect.not.objectContaining({ take: expect.anything() }),
		);
	});

	it("pins the validated DNS answer into the outbound HTTPS request", async () => {
		findMany.mockResolvedValue([webhook("https://hooks.example/events")]);

		await sendWebhook(event);
		await waitForRequestCount(1);
		await flushBackgroundDelivery();

		expect(lookup).toHaveBeenCalledTimes(1);
		const pinnedLookup = request.mock.calls[0][1].lookup;
		const lookupResult = jest.fn();
		pinnedLookup("hooks.example", {}, lookupResult);
		expect(lookupResult).toHaveBeenCalledWith(null, "8.8.8.8", 4);
	});

	it("returns an address array when Node requests lookup options.all", async () => {
		findMany.mockResolvedValue([webhook("https://hooks.example/events")]);

		await sendWebhook(event);
		await waitForRequestCount(1);
		await flushBackgroundDelivery();

		const pinnedLookup = request.mock.calls[0][1].lookup;
		const lookupResult = jest.fn();
		pinnedLookup("hooks.example", { all: true }, lookupResult);
		expect(lookupResult).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
	});

	it("does not follow a redirect to a private destination", async () => {
		findMany.mockResolvedValue([webhook("https://8.8.8.8/start")]);
		mockHttpsResponse({
			status: 302,
			statusText: "Found",
			headers: { location: "https://127.0.0.1/internal" },
		});

		await sendWebhook(event);
		await waitForRequestCount(1);
		await flushBackgroundDelivery();

		expect(request).toHaveBeenCalledTimes(1);
	});

	it("returns before a slow endpoint finishes", async () => {
		findMany.mockResolvedValue([webhook("https://8.8.8.8/slow-background")]);
		let finishRequest: (() => void) | undefined;
		request.mockImplementation((_url: URL, options, callback) => {
			const outgoing = new EventEmitter() as EventEmitter & { end: jest.Mock };
			outgoing.end = jest.fn(() => {
				finishRequest = () =>
					callback({
						statusCode: 204,
						statusMessage: "No Content",
						headers: {},
						destroy: jest.fn(),
					});
			});
			options.signal?.addEventListener("abort", () => {
				outgoing.emit("error", new Error("aborted"));
			});
			return outgoing;
		});

		await expect(sendWebhook(event)).resolves.toBeUndefined();
		await waitForRequestCount(1);
		expect(finishRequest).toBeDefined();

		finishRequest?.();
		await flushBackgroundDelivery();
	});

	it("aborts a request after the configured timeout", async () => {
		jest.useFakeTimers();
		findMany.mockResolvedValue([webhook("https://8.8.8.8/slow")]);
		let observedSignal: AbortSignal | undefined;
		request.mockImplementation((_url: URL, options) => {
			observedSignal = options.signal;
			const outgoing = new EventEmitter() as EventEmitter & { end: jest.Mock };
			outgoing.end = jest.fn();
			observedSignal?.addEventListener("abort", () => {
				outgoing.emit("error", new Error("aborted"));
			});
			return outgoing;
		});

		const delivery = sendWebhook(event);
		await delivery;
		for (let attempt = 0; attempt < 5 && !observedSignal; attempt += 1) {
			await Promise.resolve();
		}
		await jest.advanceTimersByTimeAsync(WEBHOOK_REQUEST_TIMEOUT_MS + 1);
		await Promise.resolve();

		expect(observedSignal?.aborted).toBe(true);
	});

	it("caps simultaneous outbound deliveries", async () => {
		const webhooks = Array.from({ length: WEBHOOK_MAX_CONCURRENCY * 2 + 1 }, (_, index) =>
			webhook(`https://8.8.8.8/hook-${index}`),
		);
		findMany.mockResolvedValue(webhooks);
		let active = 0;
		let maximumActive = 0;
		request.mockImplementation((_url: URL, options, callback) => {
			const outgoing = new EventEmitter() as EventEmitter & { end: jest.Mock };
			outgoing.end = jest.fn(() => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				setImmediate(() => {
					active -= 1;
					callback({
						statusCode: 204,
						statusMessage: "No Content",
						headers: {},
						destroy: jest.fn(),
					});
				});
			});
			options.signal?.addEventListener("abort", () => {
				outgoing.emit("error", new Error("aborted"));
			});
			return outgoing;
		});

		await Promise.all([sendWebhook(event), sendWebhook(event)]);
		await waitForRequestCount(webhooks.length * 2);
		await flushBackgroundDelivery();

		expect(maximumActive).toBe(WEBHOOK_MAX_CONCURRENCY);
		expect(request).toHaveBeenCalledTimes(webhooks.length * 2);
	});

	it("limits the number of deliveries scheduled for one event", async () => {
		const webhooks = Array.from(
			{ length: WEBHOOK_MAX_DELIVERIES_PER_EVENT + 5 },
			(_, index) => webhook(`https://8.8.8.8/limited-${index}`),
		);
		findMany.mockResolvedValue(webhooks);

		await sendWebhook(event);
		await waitForRequestCount(WEBHOOK_MAX_DELIVERIES_PER_EVENT);
		await flushBackgroundDelivery();

		expect(request).toHaveBeenCalledTimes(WEBHOOK_MAX_DELIVERIES_PER_EVENT);
	});
});
