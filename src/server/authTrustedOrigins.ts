import { getHostFromSource, getProtocolFromSource } from "better-auth";

/**
 * Resolve the exact external origin represented by the current request.
 * Better Auth still compares the browser Origin/Referer against this value,
 * so a different site remains blocked by its CSRF origin check.
 */
export function getRequestTrustedOrigins(request?: Request): string[] {
	if (!request) return [];

	const host = getHostFromSource(request, true);
	if (!host) return [];

	const protocol = getProtocolFromSource(request, "auto", true);
	try {
		return [new URL(`${protocol}://${host}`).origin];
	} catch {
		return [];
	}
}
