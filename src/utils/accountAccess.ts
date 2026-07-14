export const SUBSCRIPTION_EXPIRED_REASON = "SUBSCRIPTION_EXPIRED" as const;

export interface ProtectedAccountRecord {
	role: string;
	isActive: boolean;
	suspensionReason: string | null;
	expiresAt: Date | string | null;
}

/**
 * Administrators retain access to recovery controls. Every other account is
 * denied as soon as any persisted suspension or expiration signal applies.
 */
export function canAccessProtectedResources(
	account: ProtectedAccountRecord,
	now = new Date(),
): boolean {
	if (account.role === "ADMIN") return true;
	if (!account.isActive) return false;
	if (account.suspensionReason === SUBSCRIPTION_EXPIRED_REASON) return false;
	if (!account.expiresAt) return true;

	const expiresAt = new Date(account.expiresAt).getTime();
	return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}
