import fs from "node:fs";
import path from "node:path";

const PLANET_BACKUP_NAME = /^planet\.bak\.[A-Za-z0-9_-]{1,160}$/;

function assertRegularNonemptyFile(filePath: string, label: string): void {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!stats?.isFile() || stats.isSymbolicLink() || stats.size === 0) {
		throw new Error(`${label} must be a non-empty regular file.`);
	}
}

function assertRealDirectory(directory: string, label: string): void {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ directory, {
		throwIfNoEntry: false,
	});
	if (!stats?.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory.`);
	}
}

function assertChildPath(parent: string, child: string, label: string): void {
	const relative = path.relative(
		/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ parent),
		path.resolve(/* turbopackIgnore: true */ child),
	);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${label} must be a child of the ZeroTier folder.`);
	}
}

function uniqueSibling(filePath: string, label: string): string {
	return `${filePath}.${label}-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2)}`;
}

function validateOptionalPlanet(filePath: string): boolean {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!stats) return false;
	assertRegularNonemptyFile(filePath, "The active Planet");
	return true;
}

function validateOptionalWorldDirectory(directory: string): boolean {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ directory, {
		throwIfNoEntry: false,
	});
	if (!stats) return false;
	assertRealDirectory(directory, "The active Planet configuration folder");
	return true;
}

function assertBackupDirectory(backupDirectory: string): boolean {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ backupDirectory, {
		throwIfNoEntry: false,
	});
	if (!stats) return false;
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error("The Planet backup path must be a real directory.");
	}
	return true;
}

export function listOriginalPlanetBackups(backupDirectory: string): string[] {
	if (!assertBackupDirectory(backupDirectory)) return [];

	const backups: string[] = [];
	for (const entry of fs.readdirSync(/* turbopackIgnore: true */ backupDirectory, {
		withFileTypes: true,
	})) {
		if (!PLANET_BACKUP_NAME.test(entry.name)) continue;
		const filePath = path.join(/* turbopackIgnore: true */ backupDirectory, entry.name);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error(`Planet backup ${entry.name} is not a regular file.`);
		}
		assertRegularNonemptyFile(filePath, `Planet backup ${entry.name}`);
		backups.push(filePath);
	}
	return backups.sort((left, right) =>
		path.basename(left).localeCompare(path.basename(right)),
	);
}

export function getLatestOriginalPlanetBackup(backupDirectory: string): string {
	const latest = listOriginalPlanetBackups(backupDirectory).at(-1);
	if (!latest) throw new Error("No original Planet backup is available.");
	return latest;
}

export function ensureOriginalPlanetBackup(
	backupDirectory: string,
	planetPath: string,
): string {
	const existing = listOriginalPlanetBackups(backupDirectory).at(-1);
	if (existing) return existing;

	assertRegularNonemptyFile(planetPath, "The current Planet");
	if (!fs.existsSync(/* turbopackIgnore: true */ backupDirectory)) {
		fs.mkdirSync(/* turbopackIgnore: true */ backupDirectory, {
			recursive: true,
			mode: 0o700,
		});
	}
	assertBackupDirectory(backupDirectory);

	const timestamp = new Date().toISOString().replace(/[^a-zA-Z0-9]/g, "_");
	const backupPath = path.join(
		/* turbopackIgnore: true */ backupDirectory,
		`planet.bak.${timestamp}_${process.pid}`,
	);
	fs.copyFileSync(
		/* turbopackIgnore: true */ planetPath,
		backupPath,
		fs.constants.COPYFILE_EXCL,
	);
	fs.chmodSync(/* turbopackIgnore: true */ backupPath, 0o600);
	assertRegularNonemptyFile(backupPath, "The created Planet backup");
	return backupPath;
}

export function readOptionalRegularFile(filePath: string, label: string): Buffer | null {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!stats) return null;
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file.`);
	}
	return fs.readFileSync(/* turbopackIgnore: true */ filePath);
}

export function restoreFileSnapshot(
	filePath: string,
	previous: Buffer | null,
	mode = 0o600,
): void {
	if (previous === null) {
		fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true });
		return;
	}
	fs.writeFileSync(/* turbopackIgnore: true */ filePath, previous, { mode });
	fs.chmodSync(/* turbopackIgnore: true */ filePath, mode);
}

interface PlanetFileTransactionOptions {
	ztFolder: string;
	updatePorts: (ports: number[]) => Promise<unknown>;
	commitDatabase: () => Promise<unknown>;
}

export interface ActivatePreparedPlanetOptions extends PlanetFileTransactionOptions {
	stagedWorldDirectory: string;
	ports: number[];
}

/**
 * Atomically installs a fully generated zt-mkworld directory and active Planet
 * before committing its database projection. A failed database commit restores
 * all prior files. After a successful commit, only best-effort cleanup remains.
 */
export async function activatePreparedPlanet({
	ztFolder,
	stagedWorldDirectory,
	ports,
	updatePorts,
	commitDatabase,
}: ActivatePreparedPlanetOptions): Promise<void> {
	assertRealDirectory(ztFolder, "The ZeroTier folder");
	assertChildPath(ztFolder, stagedWorldDirectory, "The staged Planet folder");
	assertRealDirectory(stagedWorldDirectory, "The staged Planet folder");
	const generatedPlanet = path.join(
		/* turbopackIgnore: true */ stagedWorldDirectory,
		"planet.custom",
	);
	assertRegularNonemptyFile(generatedPlanet, "The generated Planet");

	const worldDirectory = path.join(/* turbopackIgnore: true */ ztFolder, "zt-mkworld");
	const planetPath = path.join(/* turbopackIgnore: true */ ztFolder, "planet");
	const localConfPath = path.join(/* turbopackIgnore: true */ ztFolder, "local.conf");
	const backupDirectory = path.join(
		/* turbopackIgnore: true */ ztFolder,
		"planet_backup",
	);
	const hadWorldDirectory = validateOptionalWorldDirectory(worldDirectory);
	const hadPlanet = validateOptionalPlanet(planetPath);
	ensureOriginalPlanetBackup(backupDirectory, planetPath);
	const previousLocalConf = readOptionalRegularFile(localConfPath, "local.conf");

	const pendingPlanet = uniqueSibling(planetPath, "pending");
	const previousPlanet = uniqueSibling(planetPath, "previous");
	const previousWorld = uniqueSibling(worldDirectory, "previous");
	fs.copyFileSync(
		/* turbopackIgnore: true */ generatedPlanet,
		pendingPlanet,
		fs.constants.COPYFILE_EXCL,
	);
	fs.chmodSync(/* turbopackIgnore: true */ pendingPlanet, 0o600);
	assertRegularNonemptyFile(pendingPlanet, "The staged active Planet");

	let worldSwitched = false;
	let planetSwitched = false;
	let databaseCommitted = false;
	try {
		if (hadWorldDirectory) {
			fs.renameSync(/* turbopackIgnore: true */ worldDirectory, previousWorld);
		}
		fs.renameSync(/* turbopackIgnore: true */ stagedWorldDirectory, worldDirectory);
		worldSwitched = true;

		if (hadPlanet) fs.renameSync(/* turbopackIgnore: true */ planetPath, previousPlanet);
		fs.renameSync(/* turbopackIgnore: true */ pendingPlanet, planetPath);
		planetSwitched = true;

		await updatePorts(ports);
		await commitDatabase();
		databaseCommitted = true;
	} catch (error) {
		if (!databaseCommitted) {
			try {
				restoreFileSnapshot(localConfPath, previousLocalConf);
				if (planetSwitched) {
					fs.rmSync(/* turbopackIgnore: true */ planetPath, { force: true });
				}
				if (hadPlanet && fs.existsSync(/* turbopackIgnore: true */ previousPlanet)) {
					fs.renameSync(/* turbopackIgnore: true */ previousPlanet, planetPath);
				}
				if (worldSwitched) {
					fs.rmSync(/* turbopackIgnore: true */ worldDirectory, {
						recursive: true,
						force: true,
					});
				}
				if (
					hadWorldDirectory &&
					fs.existsSync(/* turbopackIgnore: true */ previousWorld)
				) {
					fs.renameSync(/* turbopackIgnore: true */ previousWorld, worldDirectory);
				}
			} catch (rollbackError) {
				console.error("Planet activation rollback failed", rollbackError);
			}
		}
		throw error;
	} finally {
		fs.rmSync(/* turbopackIgnore: true */ pendingPlanet, { force: true });
	}

	try {
		fs.rmSync(/* turbopackIgnore: true */ previousPlanet, { force: true });
		fs.rmSync(/* turbopackIgnore: true */ previousWorld, {
			recursive: true,
			force: true,
		});
	} catch (cleanupError) {
		console.warn("Planet activation cleanup was incomplete", cleanupError);
	}
}

/** Restores the latest original Planet while preserving its backup for reuse. */
export async function restoreOriginalPlanet({
	ztFolder,
	updatePorts,
	commitDatabase,
}: PlanetFileTransactionOptions): Promise<void> {
	assertRealDirectory(ztFolder, "The ZeroTier folder");
	const worldDirectory = path.join(/* turbopackIgnore: true */ ztFolder, "zt-mkworld");
	const planetPath = path.join(/* turbopackIgnore: true */ ztFolder, "planet");
	const localConfPath = path.join(/* turbopackIgnore: true */ ztFolder, "local.conf");
	const backupDirectory = path.join(
		/* turbopackIgnore: true */ ztFolder,
		"planet_backup",
	);
	const originalPlanet = getLatestOriginalPlanetBackup(backupDirectory);
	const hadWorldDirectory = validateOptionalWorldDirectory(worldDirectory);
	const hadPlanet = validateOptionalPlanet(planetPath);
	const previousLocalConf = readOptionalRegularFile(localConfPath, "local.conf");

	const pendingPlanet = uniqueSibling(planetPath, "reset-pending");
	const previousPlanet = uniqueSibling(planetPath, "reset-previous");
	const previousWorld = uniqueSibling(worldDirectory, "reset-previous");
	fs.copyFileSync(
		/* turbopackIgnore: true */ originalPlanet,
		pendingPlanet,
		fs.constants.COPYFILE_EXCL,
	);
	fs.chmodSync(/* turbopackIgnore: true */ pendingPlanet, 0o600);
	assertRegularNonemptyFile(pendingPlanet, "The staged original Planet");

	let worldMoved = false;
	let planetSwitched = false;
	let databaseCommitted = false;
	try {
		if (hadWorldDirectory) {
			fs.renameSync(/* turbopackIgnore: true */ worldDirectory, previousWorld);
			worldMoved = true;
		}
		if (hadPlanet) fs.renameSync(/* turbopackIgnore: true */ planetPath, previousPlanet);
		fs.renameSync(/* turbopackIgnore: true */ pendingPlanet, planetPath);
		planetSwitched = true;

		await updatePorts([9993]);
		await commitDatabase();
		databaseCommitted = true;
	} catch (error) {
		if (!databaseCommitted) {
			try {
				restoreFileSnapshot(localConfPath, previousLocalConf);
				if (planetSwitched) {
					fs.rmSync(/* turbopackIgnore: true */ planetPath, { force: true });
				}
				if (hadPlanet && fs.existsSync(/* turbopackIgnore: true */ previousPlanet)) {
					fs.renameSync(/* turbopackIgnore: true */ previousPlanet, planetPath);
				}
				if (worldMoved && fs.existsSync(/* turbopackIgnore: true */ previousWorld)) {
					fs.renameSync(/* turbopackIgnore: true */ previousWorld, worldDirectory);
				}
			} catch (rollbackError) {
				console.error("Planet reset rollback failed", rollbackError);
			}
		}
		throw error;
	} finally {
		fs.rmSync(/* turbopackIgnore: true */ pendingPlanet, { force: true });
	}

	try {
		fs.rmSync(/* turbopackIgnore: true */ previousPlanet, { force: true });
		fs.rmSync(/* turbopackIgnore: true */ previousWorld, {
			recursive: true,
			force: true,
		});
	} catch (cleanupError) {
		console.warn("Planet reset cleanup was incomplete", cleanupError);
	}
}
