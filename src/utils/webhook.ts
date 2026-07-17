import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Address4, Address6 } from "ip-address";
import { prisma } from "~/server/db";
import type { HookBase } from "~/types/webhooks";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
const DEFAULT_WEBHOOK_MAX_CONCURRENCY = 4;
const MAX_WEBHOOK_REDIRECTS = 3;
export const WEBHOOK_MAX_URL_LENGTH = 2_048;
export const WEBHOOK_MAX_DELIVERIES_PER_EVENT = 20;
const WEBHOOK_MAX_PENDING_DELIVERIES = 200;

function boundedInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed)
		? Math.min(maximum, Math.max(minimum, parsed))
		: fallback;
}

export const WEBHOOK_REQUEST_TIMEOUT_MS = boundedInteger(
	process.env.WEBHOOK_REQUEST_TIMEOUT_MS,
	DEFAULT_WEBHOOK_TIMEOUT_MS,
	100,
	30_000,
);

export const WEBHOOK_MAX_CONCURRENCY = boundedInteger(
	process.env.WEBHOOK_MAX_CONCURRENCY,
	DEFAULT_WEBHOOK_MAX_CONCURRENCY,
	1,
	16,
);

const BLOCKED_IPV4_RANGES = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.31.196.0/24",
	"192.52.193.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"192.175.48.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
].map((range) => new Address4(range));

const BLOCKED_IPV6_RANGES = [
	"::/128",
	"::1/128",
	"::ffff:0:0/96",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"3fff::/20",
	"5f00::/16",
	"fc00::/7",
	"fe80::/10",
	"fec0::/10",
	"ff00::/8",
].map((range) => new Address6(range));

type LookupAll = (
	hostname: string,
	options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const defaultLookup: LookupAll = (hostname, options) => lookup(hostname, options);

export function isBlockedWebhookAddress(address: string): boolean {
	const normalized = address.replace(/^\[|\]$/g, "");

	if (Address4.isValid(normalized)) {
		const parsed = new Address4(normalized);
		return BLOCKED_IPV4_RANGES.some((range) => parsed.isInSubnet(range));
	}

	if (Address6.isValid(normalized)) {
		const parsed = new Address6(normalized);
		if (parsed.is4() || parsed.getType() !== "Global unicast") return true;
		return BLOCKED_IPV6_RANGES.some((range) => parsed.isInSubnet(range));
	}

	return true;
}

interface ResolvedWebhookTarget {
	url: URL;
	address: string;
	family: number;
}

async function resolveWebhookTarget(
	value: string,
	lookupAll: LookupAll = defaultLookup,
): Promise<ResolvedWebhookTarget> {
	if (value.length > WEBHOOK_MAX_URL_LENGTH) {
		throw new Error("Webhook URL is too long.");
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Webhook URL is invalid.");
	}

	if (url.protocol !== "https:") {
		throw new Error("Webhook URL must use HTTPS.");
	}
	if (url.username || url.password) {
		throw new Error("Webhook URL must not contain credentials.");
	}
	const hostname = url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase();
	if (
		!hostname ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".home.arpa")
	) {
		throw new Error("Webhook URL host is not allowed.");
	}

	const literalFamily = Address4.isValid(hostname)
		? 4
		: Address6.isValid(hostname)
			? 6
			: 0;
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily }]
		: await lookupAll(hostname, { all: true, verbatim: true });
	const selectedAddress = addresses[0];

	if (
		!selectedAddress ||
		addresses.some(({ address }) => isBlockedWebhookAddress(address))
	) {
		throw new Error("Webhook URL resolves to a non-public address.");
	}

	return {
		url,
		address: selectedAddress.address,
		family: selectedAddress.family,
	};
}

/** Validates both URL syntax and every address currently returned by DNS. */
export async function validateWebhookUrl(
	value: string,
	lookupAll: LookupAll = defaultLookup,
): Promise<URL> {
	return (await resolveWebhookTarget(value, lookupAll)).url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface WebhookResponse {
	status: number;
	statusText: string;
	headers: IncomingHttpHeaders;
}

function requestWebhook(
	target: ResolvedWebhookTarget,
	body: string,
	signal: AbortSignal,
): Promise<WebhookResponse> {
	const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
		const completeLookup = callback as unknown as (
			error: NodeJS.ErrnoException | null,
			address: string | LookupAddress[],
			family?: number,
		) => void;
		if (typeof options === "object" && options.all) {
			completeLookup(null, [{ address: target.address, family: target.family }]);
			return;
		}
		completeLookup(null, target.address, target.family);
	};

	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			target.url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body).toString(),
				},
				lookup: pinnedLookup,
				signal,
			},
			(response) => {
				const result = {
					status: response.statusCode || 0,
					statusText: response.statusMessage || "",
					headers: response.headers,
				};
				response.destroy();
				resolve(result);
			},
		);
		request.once("error", reject);
		request.end(body);
	});
}

async function postWebhook(
	value: string,
	body: string,
	signal: AbortSignal,
	redirectCount = 0,
): Promise<WebhookResponse> {
	const target = await resolveWebhookTarget(value);
	const response = await requestWebhook(target, body, signal);

	if (!REDIRECT_STATUSES.has(response.status)) return response;
	if (redirectCount >= MAX_WEBHOOK_REDIRECTS) {
		throw new Error("Webhook redirect limit exceeded.");
	}

	const locationHeader = response.headers.location;
	const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
	if (!location) throw new Error("Webhook redirect is missing a destination.");
	return postWebhook(
		new URL(location, target.url).toString(),
		body,
		signal,
		redirectCount + 1,
	);
}

async function deliverWebhook(url: string, body: string): Promise<void> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new Error("Webhook request timed out."));
		}, WEBHOOK_REQUEST_TIMEOUT_MS);
	});

	try {
		const response = await Promise.race([
			postWebhook(url, body, controller.signal),
			timeoutPromise,
		]);
		if (response.status < 200 || response.status >= 300) {
			console.error(`Failed to send webhook: ${response.status} ${response.statusText}`);
		}
	} catch (error) {
		console.error(
			`Error sending webhook: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

interface PendingDelivery {
	url: string;
	body: string;
}

let activeDeliveries = 0;
const pendingDeliveries: PendingDelivery[] = [];

function processDeliveryQueue(): void {
	while (activeDeliveries < WEBHOOK_MAX_CONCURRENCY && pendingDeliveries.length > 0) {
		const delivery = pendingDeliveries.shift();
		if (!delivery) return;
		activeDeliveries += 1;
		void deliverWebhook(delivery.url, delivery.body)
			.catch((error) => {
				console.error(
					`Unhandled webhook delivery error: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			})
			.finally(() => {
				activeDeliveries -= 1;
				processDeliveryQueue();
			});
	}
}

function enqueueWebhook(delivery: PendingDelivery): boolean {
	if (activeDeliveries + pendingDeliveries.length >= WEBHOOK_MAX_PENDING_DELIVERIES) {
		return false;
	}
	pendingDeliveries.push(delivery);
	processDeliveryQueue();
	return true;
}

// Generic function to send a webhook
export const sendWebhook = async <T extends HookBase>(data: T): Promise<void> => {
	if (!data?.organizationId) return;

	const webhookData = await prisma.webhook.findMany({
		where: { organizationId: data.organizationId, enabled: true },
		orderBy: { id: "asc" },
		select: {
			url: true,
			enabled: true,
			eventTypes: true,
		},
	});
	const body = JSON.stringify(data);
	const deliveries = webhookData
		.filter(
			(webhook) =>
				webhook.enabled &&
				Array.isArray(webhook.eventTypes) &&
				webhook.eventTypes.includes(data.hookType),
		)
		.slice(0, WEBHOOK_MAX_DELIVERIES_PER_EVENT);

	const dropped = deliveries.reduce(
		(count, webhook) => count + (enqueueWebhook({ url: webhook.url, body }) ? 0 : 1),
		0,
	);
	if (dropped > 0) {
		console.error(`Dropped ${dropped} webhook deliveries because the queue is full.`);
	}
};
