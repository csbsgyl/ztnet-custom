import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import archiver from "archiver";
import { extract } from "tar-stream";

export const BACKUP_DIRECTORY =
	process.env.BACKUP_DIR ||
	path.join(/* turbopackIgnore: true */ process.cwd(), "tmp", "backups");
export const MAX_BACKUP_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_ARCHIVE_ENTRIES = 250_000;
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 4096;
const MAX_ARCHIVE_SEGMENT_BYTES = 255;
const BACKUP_BASE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,118}[A-Za-z0-9])?$/;
const BACKUP_FILE_NAME_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,118}[A-Za-z0-9])?\.tar\.gz$/;

type BackupEntryType = "file" | "directory";

export function getBackupFileName(name: string | undefined, fallback: string): string {
	const value = name?.trim() || fallback;
	if (!BACKUP_BASE_NAME_PATTERN.test(value)) {
		throw new Error(
			"Backup name may contain only letters, numbers, dots, underscores, and hyphens.",
		);
	}
	return `${value}.tar.gz`;
}

export function resolveBackupFile(fileName: string): string {
	if (!BACKUP_FILE_NAME_PATTERN.test(fileName)) {
		throw new Error("Invalid backup filename.");
	}
	const backupDir = path.resolve(/* turbopackIgnore: true */ BACKUP_DIRECTORY);
	const filePath = path.resolve(/* turbopackIgnore: true */ backupDir, fileName);
	if (path.dirname(/* turbopackIgnore: true */ filePath) !== backupDir) {
		throw new Error("Invalid backup path.");
	}
	return filePath;
}

export function isBackupFileName(fileName: string): boolean {
	return BACKUP_FILE_NAME_PATTERN.test(fileName);
}

function safeArchivePath(name: string): string[] {
	if (
		!name ||
		name.includes("\\") ||
		name.includes("\0") ||
		name.startsWith("/") ||
		Buffer.byteLength(name, "utf8") > MAX_ARCHIVE_PATH_BYTES
	) {
		throw new Error("Backup archive contains an invalid path.");
	}

	const withoutDotPrefix = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
	const segments = withoutDotPrefix.split("/");
	if (
		segments.length === 0 ||
		segments.some(
			(segment) =>
				segment === "" ||
				segment === "." ||
				segment === ".." ||
				Buffer.byteLength(segment, "utf8") > MAX_ARCHIVE_SEGMENT_BYTES,
		)
	) {
		throw new Error("Backup archive contains an unsafe path.");
	}
	return segments;
}

function validateEntryLayout(segments: string[], type: BackupEntryType, size = 0): void {
	const [topLevel] = segments;
	if (topLevel === "database_dump.sql" || topLevel === "backup_metadata.json") {
		if (segments.length !== 1 || type !== "file") {
			throw new Error("Backup archive contains an invalid top-level file.");
		}
		if (topLevel === "backup_metadata.json" && size > MAX_METADATA_BYTES) {
			throw new Error("Backup metadata is too large.");
		}
		return;
	}

	if (topLevel !== "zerotier") {
		throw new Error("Backup archive contains an unexpected file.");
	}
	if (segments.length === 1 && type !== "directory") {
		throw new Error("The top-level zerotier entry must be a directory.");
	}
}

function validateBackupSource(sourceDirectory: string): void {
	let entries = 0;
	let totalBytes = 0;
	let hasMetadata = false;
	let hasPayload = false;
	let hasZerotierRoot = false;

	const walk = (currentDirectory: string, relativeDirectory = "") => {
		const children = fs
			.readdirSync(/* turbopackIgnore: true */ currentDirectory, {
				withFileTypes: true,
			})
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			const relativePath = relativeDirectory
				? `${relativeDirectory}/${child.name}`
				: child.name;
			const segments = safeArchivePath(relativePath);
			const absolutePath = path.join(
				/* turbopackIgnore: true */ currentDirectory,
				child.name,
			);
			const stats = fs.lstatSync(/* turbopackIgnore: true */ absolutePath);

			entries += 1;
			if (entries > MAX_ARCHIVE_ENTRIES) {
				throw new Error("Backup contains too many entries.");
			}

			if (stats.isDirectory()) {
				validateEntryLayout(segments, "directory");
				if (relativePath === "zerotier") hasZerotierRoot = true;
				walk(absolutePath, relativePath);
				continue;
			}
			if (!stats.isFile()) {
				throw new Error("Backup source contains links or special files.");
			}

			validateEntryLayout(segments, "file", stats.size);
			totalBytes += stats.size;
			if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXTRACTED_BYTES) {
				throw new Error("Backup source exceeds the allowed size.");
			}
			if (relativePath === "backup_metadata.json") hasMetadata = true;
			if (relativePath === "database_dump.sql" || segments[0] === "zerotier") {
				hasPayload = true;
			}
		}
	};

	walk(sourceDirectory);
	if (!hasMetadata || !hasPayload) {
		throw new Error("Backup must contain metadata and at least one payload.");
	}
	if (
		hasPayload &&
		fs.existsSync(path.join(/* turbopackIgnore: true */ sourceDirectory, "zerotier")) &&
		!hasZerotierRoot
	) {
		throw new Error("Backup contains an invalid zerotier directory.");
	}
}

export async function createBackupArchive(
	sourceDirectory: string,
	destination: string,
): Promise<void> {
	validateBackupSource(sourceDirectory);

	await new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(/* turbopackIgnore: true */ destination, {
			flags: "wx",
			mode: 0o600,
		});
		const archive = archiver("tar", {
			gzip: true,
			gzipOptions: { level: 9 },
		});
		let destinationCreated = false;
		let settled = false;

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			archive.abort();
			output.destroy();
			const cleanup = destinationCreated
				? fs.promises
						.unlink(/* turbopackIgnore: true */ destination)
						.catch(() => undefined)
				: Promise.resolve();
			void cleanup.finally(() => reject(error));
		};

		output.once("open", () => {
			destinationCreated = true;
		});
		output.once("close", () => {
			if (settled) return;
			settled = true;
			resolve();
		});
		output.once("error", fail);
		archive.once("warning", fail);
		archive.once("error", fail);
		archive.pipe(output);
		archive.directory(/* turbopackIgnore: true */ sourceDirectory, false);
		void archive.finalize().catch(fail);
	});
}

export async function extractBackupArchive(
	archivePath: string,
	destinationDirectory: string,
): Promise<void> {
	fs.mkdirSync(/* turbopackIgnore: true */ destinationDirectory, {
		recursive: true,
		mode: 0o700,
	});
	const destinationRoot = path.resolve(/* turbopackIgnore: true */ destinationDirectory);

	await new Promise<void>((resolve, reject) => {
		const unpack = extract();
		const source = fs.createReadStream(/* turbopackIgnore: true */ archivePath);
		const gunzip = createGunzip();
		const seen = new Set<string>();
		let entries = 0;
		let extractedBytes = 0;
		let settled = false;
		let hasMetadata = false;
		let hasPayload = false;
		let hasZerotierEntry = false;
		let hasZerotierRoot = false;

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			source.destroy();
			gunzip.destroy();
			unpack.destroy();
			reject(error);
		};

		unpack.on("entry", (header, entry, next) => {
			try {
				entries += 1;
				if (entries > MAX_ARCHIVE_ENTRIES) {
					throw new Error("Backup archive contains too many entries.");
				}
				if (header.type !== "file" && header.type !== "directory") {
					throw new Error("Backup archive contains links or special files.");
				}
				if (!Number.isSafeInteger(header.size) || header.size < 0) {
					throw new Error("Backup archive contains an invalid file size.");
				}

				const segments = safeArchivePath(header.name);
				validateEntryLayout(segments, header.type, header.size);
				if (segments[0] === "zerotier") hasZerotierEntry = true;
				const relativePath = segments.join(path.sep);
				if (seen.has(relativePath)) {
					throw new Error("Backup archive contains duplicate entries.");
				}
				seen.add(relativePath);

				const target = path.resolve(
					/* turbopackIgnore: true */ destinationRoot,
					relativePath,
				);
				if (
					target !== destinationRoot &&
					!target.startsWith(`${destinationRoot}${path.sep}`)
				) {
					throw new Error("Backup archive escaped the extraction directory.");
				}

				if (header.type === "directory") {
					if (segments.length === 1 && segments[0] === "zerotier") {
						hasZerotierRoot = true;
					}
					fs.mkdirSync(/* turbopackIgnore: true */ target, {
						recursive: true,
						mode: 0o700,
					});
					entry.once("end", next);
					entry.once("error", fail);
					entry.resume();
					return;
				}

				extractedBytes += header.size;
				if (
					!Number.isSafeInteger(extractedBytes) ||
					extractedBytes > MAX_EXTRACTED_BYTES
				) {
					throw new Error("Backup archive expands beyond the allowed size.");
				}
				if (segments.length === 1 && segments[0] === "backup_metadata.json") {
					hasMetadata = true;
				}
				if (segments.length === 1 && segments[0] === "database_dump.sql") {
					hasPayload = true;
				}
				if (segments[0] === "zerotier") hasPayload = true;
				fs.mkdirSync(path.dirname(/* turbopackIgnore: true */ target), {
					recursive: true,
					mode: 0o700,
				});
				const output = fs.createWriteStream(/* turbopackIgnore: true */ target, {
					flags: "wx",
					mode: 0o600,
				});
				entry.once("error", fail);
				output.once("error", fail);
				output.once("finish", next);
				entry.pipe(output);
			} catch (error) {
				entry.resume();
				fail(error instanceof Error ? error : new Error("Invalid backup archive."));
			}
		});
		unpack.once("finish", () => {
			if (settled) return;
			if (!hasMetadata || !hasPayload || (hasZerotierEntry && !hasZerotierRoot)) {
				fail(new Error("Backup archive is missing its required layout."));
				return;
			}
			settled = true;
			resolve();
		});
		unpack.once("error", fail);
		gunzip.once("error", fail);
		source.once("error", fail);
		source.pipe(gunzip).pipe(unpack);
	});
}
