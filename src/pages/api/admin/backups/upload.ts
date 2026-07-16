import fs from "node:fs";
import path from "node:path";
import formidable from "formidable";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	BACKUP_DIRECTORY,
	MAX_BACKUP_UPLOAD_BYTES,
	resolveBackupFile,
} from "~/server/backupFiles";
import { requireAdministrator } from "~/server/api/auth/adminApi";

export const config = {
	api: {
		bodyParser: false,
	},
};

export default async function uploadBackup(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).json({ message: "Method Not Allowed" });
	}
	if (!(await requireAdministrator(req, res))) return;

	await fs.promises.mkdir(/* turbopackIgnore: true */ BACKUP_DIRECTORY, {
		recursive: true,
		mode: 0o700,
	});
	const uploadDir = path.join(/* turbopackIgnore: true */ BACKUP_DIRECTORY, ".upload");
	await fs.promises.mkdir(/* turbopackIgnore: true */ uploadDir, {
		recursive: true,
		mode: 0o700,
	});
	const form = formidable({
		uploadDir,
		keepExtensions: false,
		maxFiles: 1,
		maxFileSize: MAX_BACKUP_UPLOAD_BYTES,
		maxTotalFileSize: MAX_BACKUP_UPLOAD_BYTES,
	});
	let temporaryFile: string | undefined;
	let destination: string | undefined;
	form.on("fileBegin", (_name, file) => {
		temporaryFile = file.filepath;
	});

	try {
		const [_fields, files] = await form.parse(req);
		const file = files.file?.[0];
		temporaryFile = file?.filepath;
		if (!file?.originalFilename) {
			return res.status(400).json({ message: "Backup file is required" });
		}
		destination = resolveBackupFile(file.originalFilename);
		await fs.promises.copyFile(
			/* turbopackIgnore: true */ file.filepath,
			destination,
			fs.constants.COPYFILE_EXCL,
		);
		await fs.promises.chmod(/* turbopackIgnore: true */ destination, 0o600);
		const stats = await fs.promises.stat(/* turbopackIgnore: true */ destination);
		return res.status(201).json({
			success: true,
			fileName: file.originalFilename,
			size: stats.size,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (destination && code !== "EEXIST") {
			await fs.promises
				.unlink(/* turbopackIgnore: true */ destination)
				.catch(() => undefined);
		}
		return res.status(code === "EEXIST" ? 409 : 400).json({
			message: error instanceof Error ? error.message : "Backup upload failed",
		});
	} finally {
		if (temporaryFile) {
			await fs.promises
				.unlink(/* turbopackIgnore: true */ temporaryFile)
				.catch(() => undefined);
		}
	}
}
