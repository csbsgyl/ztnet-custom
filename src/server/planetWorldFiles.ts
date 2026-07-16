import fs from "node:fs";
import path from "node:path";

const MAX_WORLD_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_WORLD_FILE_BYTES = 10 * 1024 * 1024;

export const PLANET_WORLD_DOWNLOAD_FILES = [
	"mkworld.config.json",
	"current.c25519",
	"previous.c25519",
	"planet.custom",
] as const;

export interface PlanetWorldDownloadEntry {
	name: (typeof PLANET_WORLD_DOWNLOAD_FILES)[number];
	data: Buffer;
}

function readRegularFile(filePath: string, label: string): Buffer | null {
	const initial = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!initial) return null;
	if (!initial.isFile() || initial.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file.`);
	}

	const descriptor = fs.openSync(
		/* turbopackIgnore: true */ filePath,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const stats = fs.fstatSync(descriptor);
		if (!stats.isFile() || stats.size === 0 || stats.size > MAX_WORLD_FILE_BYTES) {
			throw new Error(`${label} has an invalid size.`);
		}
		return fs.readFileSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Reads only the files required to recreate the active custom Planet. */
export function readPlanetWorldDownloadEntries(
	worldDirectory: string,
): PlanetWorldDownloadEntry[] {
	const directoryStats = fs.lstatSync(/* turbopackIgnore: true */ worldDirectory, {
		throwIfNoEntry: false,
	});
	if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error("The Planet configuration folder was not found.");
	}

	const entries: PlanetWorldDownloadEntry[] = [];
	let totalBytes = 0;
	for (const name of PLANET_WORLD_DOWNLOAD_FILES) {
		const filePath = path.join(/* turbopackIgnore: true */ worldDirectory, name);
		const data = readRegularFile(filePath, name);
		if (!data) continue;
		totalBytes += data.length;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_WORLD_DOWNLOAD_BYTES) {
			throw new Error("The Planet configuration exceeds the download size limit.");
		}
		entries.push({ name, data });
	}

	if (!entries.some((entry) => entry.name === "mkworld.config.json")) {
		throw new Error("mkworld.config.json was not found.");
	}
	return entries;
}
