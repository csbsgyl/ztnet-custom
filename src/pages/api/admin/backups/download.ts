import fs from "node:fs";
import type { NextApiRequest, NextApiResponse } from "next";
import { resolveBackupFile } from "~/server/backupFiles";
import { requireAdministrator } from "~/server/api/auth/adminApi";

export default async function downloadBackup(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).json({ message: "Method Not Allowed" });
	}
	if (!(await requireAdministrator(req, res))) return;

	try {
		const fileName = Array.isArray(req.query.fileName)
			? req.query.fileName[0]
			: req.query.fileName;
		if (!fileName) return res.status(400).json({ message: "Filename is required" });
		const filePath = resolveBackupFile(fileName);
		const stats = await fs.promises.lstat(/* turbopackIgnore: true */ filePath);
		if (!stats.isFile()) throw new Error("Backup file not found.");

		res.setHeader("Content-Type", "application/gzip");
		res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
		res.setHeader("Content-Length", stats.size.toString());
		res.setHeader("Cache-Control", "private, no-store, max-age=0");
		res.setHeader("X-Content-Type-Options", "nosniff");
		const stream = fs.createReadStream(/* turbopackIgnore: true */ filePath);
		stream.once("error", (error) => {
			console.error("Backup download failed", error);
			if (!res.headersSent) res.status(500).end();
			else res.destroy(error);
		});
		return stream.pipe(res);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return res.status(404).json({ message: "Backup file not found" });
		}
		return res.status(400).json({
			message: error instanceof Error ? error.message : "Backup download failed",
		});
	}
}
