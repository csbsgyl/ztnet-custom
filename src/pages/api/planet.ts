import { promises as fs } from "node:fs";
import path from "node:path";
import { fromNodeHeaders } from "better-auth/node";
import type { NextApiRequest, NextApiResponse } from "next";
import { auth } from "~/lib/auth";
import { prisma } from "~/server/db";
import { canAccessProtectedResources } from "~/utils/accountAccess";
import { ZT_FOLDER } from "~/utils/ztApi";

const accountSelect = {
	id: true,
	role: true,
	isActive: true,
	suspensionReason: true,
	expiresAt: true,
} as const;

export default async function planetDownload(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).send("Method Not Allowed");
	}

	const session = await auth.api.getSession({
		headers: fromNodeHeaders(req.headers),
	});
	if (!session?.user?.id) {
		return res.status(401).send("Authentication required");
	}

	const [account, options] = await Promise.all([
		prisma.user.findUnique({
			where: { id: session.user.id },
			select: accountSelect,
		}),
		prisma.globalOptions.findUnique({
			where: { id: 1 },
			select: { planetId: true },
		}),
	]);

	if (!account) {
		return res.status(401).send("Authentication required");
	}
	if (!canAccessProtectedResources(account)) {
		return res.status(403).send("Account is inactive or expired");
	}
	if (options?.planetId == null) {
		return res.status(404).send("Planet file is not available");
	}

	try {
		// This is the file mounted into and used by the ZeroTier container.
		const planet = await fs.readFile(path.join(ZT_FOLDER, "planet"));
		if (planet.length === 0) {
			return res.status(404).send("Planet file is not available");
		}

		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("Content-Disposition", 'attachment; filename="planet"');
		res.setHeader("Content-Length", planet.length.toString());
		res.setHeader("Cache-Control", "private, no-store, max-age=0");
		res.setHeader("X-Content-Type-Options", "nosniff");
		return res.status(200).send(planet);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return res.status(404).send("Planet file is not available");
		}
		console.error("Unable to download the active planet file", error);
		return res.status(500).send("Internal Server Error");
	}
}
