import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import formidable from "formidable";
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdministrator } from "~/server/api/auth/adminApi";
import { prisma } from "~/server/db";
import { parsePlanetArchive } from "~/server/planetArchive";
import { activatePreparedPlanet } from "~/server/planetFiles";
import { readPlanetWorldDownloadEntries } from "~/server/planetWorldFiles";
import { updateLocalConf } from "~/utils/planet";
import { ZT_FOLDER } from "~/utils/ztPaths";

const MAX_WORLD_ARCHIVE_BYTES = 10 * 1024 * 1024;
const ZTMKWORLD_BINARY = "/usr/local/bin/ztmkworld";

export const config = {
	api: {
		bodyParser: false,
	},
};

async function downloadWorld(res: NextApiResponse): Promise<void> {
	const folderPath = path.join(/* turbopackIgnore: true */ ZT_FOLDER, "zt-mkworld");
	const entries = readPlanetWorldDownloadEntries(folderPath);

	res.setHeader("Content-Disposition", "attachment; filename=zt-mkworld.zip");
	res.setHeader("Content-Type", "application/zip");
	res.setHeader("Cache-Control", "private, no-store, max-age=0");
	res.setHeader("X-Content-Type-Options", "nosniff");

	await new Promise<void>((resolve) => {
		const archive = archiver("zip", { zlib: { level: 9 } });
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		archive.once("warning", (error) => {
			console.error("Unable to archive Planet configuration", error);
			if (!res.headersSent) res.status(500).end();
			else res.destroy(error);
			finish();
		});
		archive.once("error", (error) => {
			console.error("Unable to archive Planet configuration", error);
			if (!res.headersSent) res.status(500).end();
			else res.destroy(error);
			finish();
		});
		res.once("finish", finish);
		res.once("close", finish);
		archive.pipe(res);
		for (const entry of entries) {
			archive.append(entry.data, { name: entry.name });
		}
		void archive.finalize();
	});
}

async function importWorld(req: NextApiRequest, res: NextApiResponse): Promise<void> {
	const form = formidable({
		uploadDir: "/tmp",
		keepExtensions: false,
		maxFiles: 1,
		maxFileSize: MAX_WORLD_ARCHIVE_BYTES,
		maxTotalFileSize: MAX_WORLD_ARCHIVE_BYTES,
	});
	let uploadedFilePath: string | undefined;
	form.on("fileBegin", (_name, file) => {
		uploadedFilePath = file.filepath;
	});

	let stagingDirectory: string | undefined;

	try {
		const [_fields, files] = await form.parse(req);
		const uploadedFile = files.file?.[0];
		uploadedFilePath = uploadedFile?.filepath || uploadedFilePath;
		if (!uploadedFilePath) {
			res.status(400).json({ error: "No file uploaded." });
			return;
		}
		if (!fs.existsSync(/* turbopackIgnore: true */ ZTMKWORLD_BINARY)) {
			throw new Error("ztmkworld is not available in this installation.");
		}

		const imported = await parsePlanetArchive(uploadedFilePath);
		const worldDirectory = path.join(/* turbopackIgnore: true */ ZT_FOLDER, "zt-mkworld");
		stagingDirectory = fs.mkdtempSync(
			path.join(/* turbopackIgnore: true */ ZT_FOLDER, ".zt-mkworld-import-"),
		);
		fs.writeFileSync(
			path.join(/* turbopackIgnore: true */ stagingDirectory, "mkworld.config.json"),
			JSON.stringify(imported.config, null, 2),
			{ mode: 0o600 },
		);

		for (const keyName of ["current.c25519", "previous.c25519"] as const) {
			const importedKey = imported.keyFiles.get(keyName);
			const existingKeyPath = path.join(
				/* turbopackIgnore: true */ worldDirectory,
				keyName,
			);
			if (importedKey) {
				fs.writeFileSync(
					path.join(/* turbopackIgnore: true */ stagingDirectory, keyName),
					importedKey,
					{ mode: 0o600 },
				);
			} else if (
				fs
					.lstatSync(/* turbopackIgnore: true */ existingKeyPath, {
						throwIfNoEntry: false,
					})
					?.isFile()
			) {
				const stagedKeyPath = path.join(
					/* turbopackIgnore: true */ stagingDirectory,
					keyName,
				);
				fs.copyFileSync(/* turbopackIgnore: true */ existingKeyPath, stagedKeyPath);
				fs.chmodSync(/* turbopackIgnore: true */ stagedKeyPath, 0o600);
			}
		}

		execFileSync(
			ZTMKWORLD_BINARY,
			[
				"-c",
				path.join(/* turbopackIgnore: true */ stagingDirectory, "mkworld.config.json"),
			],
			{
				cwd: stagingDirectory,
				stdio: ["ignore", "ignore", "pipe"],
				timeout: 60_000,
			},
		);
		const generatedPlanet = path.join(
			/* turbopackIgnore: true */ stagingDirectory,
			"planet.custom",
		);
		const generatedStats = fs.lstatSync(/* turbopackIgnore: true */ generatedPlanet, {
			throwIfNoEntry: false,
		});
		if (!generatedStats?.isFile() || generatedStats.size === 0) {
			throw new Error("ztmkworld did not create a valid Planet file.");
		}

		await activatePreparedPlanet({
			ztFolder: ZT_FOLDER,
			stagedWorldDirectory: stagingDirectory,
			ports: imported.ports,
			updatePorts: updateLocalConf,
			commitDatabase: () =>
				prisma.$transaction(async (tx) => {
					await tx.planet.upsert({
						where: { id: 1 },
						update: {
							globalOptions: { connect: { id: 1 } },
							plBirth: imported.config.plBirth,
							plID: imported.config.plID,
							plRecommend: imported.config.plRecommend,
							rootNodes: {
								deleteMany: {},
								create: imported.config.rootNodes,
							},
						},
						create: {
							id: 1,
							globalOptions: { connect: { id: 1 } },
							plBirth: imported.config.plBirth,
							plID: imported.config.plID,
							plRecommend: imported.config.plRecommend,
							rootNodes: { create: imported.config.rootNodes },
						},
					});
					await tx.globalOptions.update({
						where: { id: 1 },
						data: { customPlanetUsed: true },
					});
				}),
		});
		stagingDirectory = undefined;
		res.status(200).json({ message: "Planet configuration imported successfully." });
	} catch (error) {
		console.error("Unable to import Planet configuration", error);
		res.status(400).json({
			error:
				error instanceof Error ? error.message : "Unable to import Planet configuration.",
		});
	} finally {
		if (uploadedFilePath) {
			fs.rmSync(/* turbopackIgnore: true */ uploadedFilePath, { force: true });
		}
		if (stagingDirectory) {
			fs.rmSync(/* turbopackIgnore: true */ stagingDirectory, {
				recursive: true,
				force: true,
			});
		}
	}
}

export default async function worldConfig(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET" && req.method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		return res.status(405).json({ error: "Method Not Allowed" });
	}
	if (!(await requireAdministrator(req, res))) return;

	if (req.method === "GET") {
		try {
			await downloadWorld(res);
		} catch (error) {
			console.error("Unable to download Planet configuration", error);
			if (!res.headersSent) res.status(500).send("Internal Server Error.");
		}
		return;
	}
	await importWorld(req, res);
}
