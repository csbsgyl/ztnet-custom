import { fromNodeHeaders } from "better-auth/node";
import type { NextApiRequest, NextApiResponse } from "next";
import { auth } from "~/lib/auth";
import { prisma } from "~/server/db";
import { canAccessProtectedResources } from "~/utils/accountAccess";

export async function requireAdministrator(
	req: NextApiRequest,
	res: NextApiResponse,
): Promise<boolean> {
	const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
	if (!session?.user?.id) {
		res.status(401).json({ message: "Authorization Error" });
		return false;
	}

	const account = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: {
			role: true,
			isActive: true,
			suspensionReason: true,
			expiresAt: true,
		},
	});
	if (
		session.user.role !== "ADMIN" ||
		account?.role !== "ADMIN" ||
		!canAccessProtectedResources(account)
	) {
		res.status(403).json({ message: "Administrator access required" });
		return false;
	}
	return true;
}
