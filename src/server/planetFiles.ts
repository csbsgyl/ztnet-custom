import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLANET_BACKUP_NAME = /^planet\.bak\.[A-Za-z0-9_-]{1,160}$/;
const STAGED_WORLD_NAME = /^\.zt-mkworld-(?:generate|import)-[A-Za-z0-9_-]{1,160}$/;
const TRANSACTION_ARTIFACT_SUFFIX = /^[A-Za-z0-9_-]{1,160}$/;
export const PLANET_LOCK_FILE_NAME = ".ztnet-planet.lock";
export const PLANET_JOURNAL_FILE_NAME = ".ztnet-planet-transaction.json";

const PLANET_LOCK_GATE_FILE_NAME = ".ztnet-planet.lock-gate";
const LOCK_VERSION = 1;
const JOURNAL_VERSION = 1;
const LOCK_HEARTBEAT_MS = 2_000;
const LOCK_STALE_MS = 120_000;
const LOCK_GATE_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_ACQUIRE_TIMEOUT_MS = LOCK_STALE_MS + 60_000;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_SIGNING_KEY_BYTES = 1024 * 1024;
const PLANET_SIGNING_KEY_NAMES = ["current.c25519", "previous.c25519"] as const;

type PlanetOrigin = "UNKNOWN" | "LOCAL_GENERATED" | "IMPORTED";

export interface PlanetDatabaseState {
	customPlanetUsed: boolean;
	planet: {
		plID: string | number | bigint;
		plBirth: string | number | bigint;
		plRecommend: boolean;
		origin: PlanetOrigin;
		downloadSha256: string | null;
		rootNodes: Array<{
			identity: string;
			comments?: string | null;
			endpoints: unknown;
		}>;
	} | null;
}

export const PLANET_DATABASE_STATE_SELECT = {
	customPlanetUsed: true,
	planet: {
		select: {
			plID: true,
			plBirth: true,
			plRecommend: true,
			origin: true,
			downloadSha256: true,
			rootNodes: {
				orderBy: { id: "asc" as const },
				select: { identity: true, comments: true, endpoints: true },
			},
		},
	},
} as const;

interface LockMetadata {
	version: typeof LOCK_VERSION;
	token: string;
	pid: number;
	hostname: string;
	processStartId: string | null;
	createdAt: string;
}

type JournalPhase =
	| "prepared"
	| "files_installed"
	| "database_commit_started"
	| "database_committed";

interface PlanetTransactionJournal {
	version: typeof JOURNAL_VERSION;
	token: string;
	operation: "activate" | "restore";
	phase: JournalPhase;
	hadWorldDirectory: boolean;
	hadPlanet: boolean;
	stagedWorldName: string | null;
	pendingPlanetName: string;
	previousPlanetName: string;
	previousWorldName: string;
	previousLocalConfBase64: string | null;
	databaseStateId: string;
	createdAt: string;
}

interface HeldControlFile {
	path: string;
	fd: number;
	metadata: LockMetadata;
}

interface HeldPlanetLock extends HeldControlFile {
	heartbeat: ReturnType<typeof setInterval>;
}

const inProcessLockTails = new Map<string, Promise<void>>();

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeDatabaseState(state: PlanetDatabaseState) {
	const rootNodes = state.planet?.rootNodes.map((node) => {
		if (
			!Array.isArray(node.endpoints) ||
			!node.endpoints.every((endpoint) => typeof endpoint === "string")
		) {
			throw new Error("Planet database state contains invalid endpoints.");
		}
		return {
			identity: node.identity,
			comments: node.comments ?? "",
			endpoints: node.endpoints,
		};
	});
	rootNodes?.sort((left, right) => {
		const leftKey = JSON.stringify([left.identity, left.comments, left.endpoints]);
		const rightKey = JSON.stringify([right.identity, right.comments, right.endpoints]);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});

	return {
		customPlanetUsed: state.customPlanetUsed,
		planet: state.planet
			? {
					plID: String(state.planet.plID),
					plBirth: String(state.planet.plBirth),
					plRecommend: state.planet.plRecommend,
					origin: state.planet.origin,
					downloadSha256: state.planet.downloadSha256,
					rootNodes: rootNodes ?? [],
				}
			: null,
	};
}

export function createPlanetDatabaseStateId(state: PlanetDatabaseState): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizeDatabaseState(state)))
		.digest("hex");
}

function getLinuxProcessStartId(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const fieldsAfterCommand = stat
			.slice(commandEnd + 2)
			.trim()
			.split(/\s+/);
		return fieldsAfterCommand[19] || null;
	} catch {
		return null;
	}
}

type ControlFileOwnerStatus = "active" | "gone" | "unknown";

function controlFileOwnerStatus(metadata: LockMetadata): ControlFileOwnerStatus {
	if (metadata.hostname !== os.hostname()) return "unknown";
	try {
		process.kill(metadata.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "gone";
		if (code !== "EPERM") return "unknown";
	}
	if (metadata.processStartId === null) return "unknown";
	const currentStartId = getLinuxProcessStartId(metadata.pid);
	if (currentStartId === null) return "unknown";
	return currentStartId === metadata.processStartId ? "active" : "gone";
}

function readControlJson(filePath: string): unknown {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > MAX_CONTROL_FILE_BYTES) {
		throw new Error(`Planet control file ${path.basename(filePath)} is invalid.`);
	}
	return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"));
}

function parseLockMetadata(value: unknown): LockMetadata | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const metadata = value as Partial<LockMetadata>;
	if (
		metadata.version !== LOCK_VERSION ||
		typeof metadata.token !== "string" ||
		!Number.isInteger(metadata.pid) ||
		(metadata.pid ?? 0) < 1 ||
		typeof metadata.hostname !== "string" ||
		(metadata.processStartId !== null &&
			(typeof metadata.processStartId !== "string" ||
				metadata.processStartId.length === 0)) ||
		typeof metadata.createdAt !== "string"
	) {
		return null;
	}
	return metadata as LockMetadata;
}

function controlFileIsStale(filePath: string, staleAfterMs: number): boolean {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	return Boolean(stats && Date.now() - stats.mtimeMs > staleAfterMs);
}

function canReclaimControlFile(filePath: string, staleAfterMs: number): boolean {
	let metadata: LockMetadata | null = null;
	try {
		metadata = parseLockMetadata(readControlJson(filePath));
	} catch {
		// Malformed ownership data is reclaimable only after its lease expires.
	}
	if (metadata) {
		const ownerStatus = controlFileOwnerStatus(metadata);
		if (ownerStatus === "gone") return true;
		if (ownerStatus === "active") return false;
	}
	return controlFileIsStale(filePath, staleAfterMs);
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function restoreQuarantinedControlFile(quarantinePath: string, filePath: string): void {
	try {
		// link(2) supplies the O_EXCL behavior that rename(2) lacks. It will not
		// overwrite a newer lock which appeared while the old one was inspected.
		fs.linkSync(/* turbopackIgnore: true */ quarantinePath, filePath);
		fs.unlinkSync(/* turbopackIgnore: true */ quarantinePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST" && code !== "ENOENT") throw error;
	}
}

function quarantineStaleControlFile(filePath: string, staleAfterMs: number): boolean {
	const observedStats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!observedStats || !canReclaimControlFile(filePath, staleAfterMs)) return false;

	const quarantinePath = `${filePath}.stale-${randomUUID()}`;
	try {
		fs.renameSync(/* turbopackIgnore: true */ filePath, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}

	const quarantinedStats = fs.lstatSync(/* turbopackIgnore: true */ quarantinePath, {
		throwIfNoEntry: false,
	});
	if (
		!quarantinedStats ||
		!sameFile(observedStats, quarantinedStats) ||
		!canReclaimControlFile(quarantinePath, staleAfterMs)
	) {
		if (quarantinedStats) restoreQuarantinedControlFile(quarantinePath, filePath);
		return false;
	}

	fs.rmSync(/* turbopackIgnore: true */ quarantinePath, { force: true });
	return true;
}

function removeControlFileByDescriptor(filePath: string, fd: number): void {
	const descriptorStats = fs.fstatSync(fd);
	const pathStats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!pathStats || !sameFile(pathStats, descriptorStats)) return;

	const quarantinePath = `${filePath}.failed-${randomUUID()}`;
	try {
		fs.renameSync(/* turbopackIgnore: true */ filePath, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const quarantinedStats = fs.lstatSync(/* turbopackIgnore: true */ quarantinePath, {
		throwIfNoEntry: false,
	});
	if (quarantinedStats && sameFile(quarantinedStats, descriptorStats)) {
		fs.rmSync(/* turbopackIgnore: true */ quarantinePath, { force: true });
	} else if (quarantinedStats) {
		restoreQuarantinedControlFile(quarantinePath, filePath);
	}
}

function createControlFile(filePath: string, metadata: LockMetadata): number {
	const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR;
	const fd = fs.openSync(/* turbopackIgnore: true */ filePath, flags, 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(metadata));
		fs.fsyncSync(fd);
		return fd;
	} catch (error) {
		try {
			removeControlFileByDescriptor(filePath, fd);
		} finally {
			fs.closeSync(fd);
		}
		throw error;
	}
}

function newLockMetadata(): LockMetadata {
	return {
		version: LOCK_VERSION,
		token: randomUUID(),
		pid: process.pid,
		hostname: os.hostname(),
		processStartId: getLinuxProcessStartId(process.pid),
		createdAt: new Date().toISOString(),
	};
}

function assertControlFileOwnership(controlFile: HeldControlFile): void {
	const metadata = parseLockMetadata(readControlJson(controlFile.path));
	const pathStats = fs.lstatSync(/* turbopackIgnore: true */ controlFile.path);
	const descriptorStats = fs.fstatSync(controlFile.fd);
	if (
		metadata?.token !== controlFile.metadata.token ||
		!sameFile(pathStats, descriptorStats)
	) {
		throw new Error(
			`Planet control file ${path.basename(controlFile.path)} ownership was lost.`,
		);
	}
}

function removeOwnedControlFile(controlFile: HeldControlFile): void {
	const pathStats = fs.lstatSync(/* turbopackIgnore: true */ controlFile.path, {
		throwIfNoEntry: false,
	});
	if (!pathStats) return;

	const descriptorStats = fs.fstatSync(controlFile.fd);
	let metadata: LockMetadata | null = null;
	try {
		metadata = parseLockMetadata(readControlJson(controlFile.path));
	} catch {
		return;
	}
	if (
		metadata?.token !== controlFile.metadata.token ||
		!sameFile(pathStats, descriptorStats)
	) {
		return;
	}

	const quarantinePath = `${controlFile.path}.release-${randomUUID()}`;
	try {
		fs.renameSync(/* turbopackIgnore: true */ controlFile.path, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}

	const quarantinedStats = fs.lstatSync(/* turbopackIgnore: true */ quarantinePath, {
		throwIfNoEntry: false,
	});
	let quarantinedMetadata: LockMetadata | null = null;
	try {
		if (quarantinedStats) {
			quarantinedMetadata = parseLockMetadata(readControlJson(quarantinePath));
		}
	} catch {
		// Leave an unexpectedly changed file in quarantine rather than deleting it.
	}
	if (
		quarantinedStats &&
		sameFile(quarantinedStats, descriptorStats) &&
		quarantinedMetadata?.token === controlFile.metadata.token
	) {
		fs.rmSync(/* turbopackIgnore: true */ quarantinePath, { force: true });
		return;
	}
	if (quarantinedStats) restoreQuarantinedControlFile(quarantinePath, controlFile.path);
}

async function acquireGate(ztFolder: string): Promise<HeldControlFile> {
	const gatePath = path.join(
		/* turbopackIgnore: true */ ztFolder,
		PLANET_LOCK_GATE_FILE_NAME,
	);
	const startedAt = Date.now();
	while (true) {
		const metadata = newLockMetadata();
		try {
			const fd = createControlFile(gatePath, metadata);
			return { path: gatePath, fd, metadata };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (quarantineStaleControlFile(gatePath, LOCK_GATE_STALE_MS)) continue;
			if (Date.now() - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
				throw new Error("Timed out waiting for the Planet lifecycle lock gate.");
			}
			await delay(LOCK_RETRY_MS);
		}
	}
}

function releaseGate(gate: HeldControlFile): void {
	try {
		try {
			removeOwnedControlFile(gate);
		} catch (error) {
			console.error("Planet lifecycle lock gate release failed", error);
		}
	} finally {
		fs.closeSync(gate.fd);
	}
}

async function acquirePlanetFileLock(ztFolder: string): Promise<HeldPlanetLock> {
	const lockPath = path.join(/* turbopackIgnore: true */ ztFolder, PLANET_LOCK_FILE_NAME);
	const startedAt = Date.now();
	while (true) {
		const gate = await acquireGate(ztFolder);
		let acquired: Omit<HeldPlanetLock, "heartbeat"> | null = null;
		let shouldWait = false;
		try {
			assertControlFileOwnership(gate);
			if (fs.existsSync(/* turbopackIgnore: true */ lockPath)) {
				shouldWait = !quarantineStaleControlFile(lockPath, LOCK_STALE_MS);
			}

			if (!shouldWait) {
				const metadata = newLockMetadata();
				try {
					const fd = createControlFile(lockPath, metadata);
					acquired = { path: lockPath, fd, metadata };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					shouldWait = true;
				}
			}
		} finally {
			releaseGate(gate);
		}

		if (acquired) {
			const held = acquired;
			const heartbeat = setInterval(() => {
				try {
					const now = new Date();
					fs.futimesSync(held.fd, now, now);
				} catch {
					// Ownership is checked again before every durable state transition.
				}
			}, LOCK_HEARTBEAT_MS);
			heartbeat.unref?.();
			return { ...held, heartbeat };
		}
		if (Date.now() - startedAt > LOCK_ACQUIRE_TIMEOUT_MS) {
			throw new Error("Timed out waiting for the Planet lifecycle lock.");
		}
		await delay(LOCK_RETRY_MS);
	}
}

function assertPlanetLockOwnership(lock: HeldPlanetLock): void {
	assertControlFileOwnership(lock);
}

async function releasePlanetFileLock(
	ztFolder: string,
	lock: HeldPlanetLock,
): Promise<void> {
	clearInterval(lock.heartbeat);
	try {
		const gate = await acquireGate(ztFolder);
		try {
			assertControlFileOwnership(gate);
			removeOwnedControlFile(lock);
		} finally {
			releaseGate(gate);
		}
	} finally {
		fs.closeSync(lock.fd);
	}
}

async function withInProcessPlanetLock<T>(
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = inProcessLockTails.get(key) ?? Promise.resolve();
	let releaseTurn: () => void = () => undefined;
	const turn = new Promise<void>((resolve) => {
		releaseTurn = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => turn);
	inProcessLockTails.set(key, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		releaseTurn();
		if (inProcessLockTails.get(key) === tail) inProcessLockTails.delete(key);
	}
}

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

function assertStagedWorldDirectory(
	ztFolder: string,
	stagedWorldDirectory: string,
): string {
	assertChildPath(ztFolder, stagedWorldDirectory, "The staged Planet folder");
	if (
		path.dirname(path.resolve(/* turbopackIgnore: true */ stagedWorldDirectory)) !==
		path.resolve(/* turbopackIgnore: true */ ztFolder)
	) {
		throw new Error(
			"The staged Planet folder must be a direct child of the ZeroTier folder.",
		);
	}
	assertRealDirectory(stagedWorldDirectory, "The staged Planet folder");
	const stagedWorldName = path.basename(stagedWorldDirectory);
	if (!STAGED_WORLD_NAME.test(stagedWorldName)) {
		throw new Error("The staged Planet folder has an unsafe name.");
	}
	return stagedWorldName;
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

function assertSafeJournalName(name: string, label: string): void {
	if (
		name.length === 0 ||
		name.length > 255 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		path.basename(name) !== name
	) {
		throw new Error(`Planet transaction journal contains an invalid ${label}.`);
	}
}

function hasTransactionArtifactPrefix(name: string, prefix: string): boolean {
	return (
		name.startsWith(prefix) && TRANSACTION_ARTIFACT_SUFFIX.test(name.slice(prefix.length))
	);
}

function parsePlanetTransactionJournal(value: unknown): PlanetTransactionJournal {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Planet transaction journal is invalid.");
	}
	const journal = value as Partial<PlanetTransactionJournal>;
	const validPhases: JournalPhase[] = [
		"prepared",
		"files_installed",
		"database_commit_started",
		"database_committed",
	];
	if (
		journal.version !== JOURNAL_VERSION ||
		(journal.operation !== "activate" && journal.operation !== "restore") ||
		!validPhases.includes(journal.phase as JournalPhase) ||
		typeof journal.token !== "string" ||
		journal.token.length === 0 ||
		journal.token.length > 200 ||
		typeof journal.hadWorldDirectory !== "boolean" ||
		typeof journal.hadPlanet !== "boolean" ||
		typeof journal.pendingPlanetName !== "string" ||
		typeof journal.previousPlanetName !== "string" ||
		typeof journal.previousWorldName !== "string" ||
		(journal.stagedWorldName !== null && typeof journal.stagedWorldName !== "string") ||
		(journal.previousLocalConfBase64 !== null &&
			typeof journal.previousLocalConfBase64 !== "string") ||
		typeof journal.databaseStateId !== "string" ||
		journal.databaseStateId.length === 0 ||
		journal.databaseStateId.length > 256 ||
		typeof journal.createdAt !== "string"
	) {
		throw new Error("Planet transaction journal is invalid.");
	}

	const parsed = journal as PlanetTransactionJournal;
	assertSafeJournalName(parsed.pendingPlanetName, "pending Planet name");
	assertSafeJournalName(parsed.previousPlanetName, "previous Planet name");
	assertSafeJournalName(parsed.previousWorldName, "previous world name");
	if (parsed.stagedWorldName !== null) {
		assertSafeJournalName(parsed.stagedWorldName, "staged world name");
	}

	const expectedNames =
		parsed.operation === "activate"
			? {
					pendingPlanet: "planet.pending-",
					previousPlanet: "planet.previous-",
					previousWorld: "zt-mkworld.previous-",
				}
			: {
					pendingPlanet: "planet.reset-pending-",
					previousPlanet: "planet.reset-previous-",
					previousWorld: "zt-mkworld.reset-previous-",
				};
	if (
		!hasTransactionArtifactPrefix(
			parsed.pendingPlanetName,
			expectedNames.pendingPlanet,
		) ||
		!hasTransactionArtifactPrefix(
			parsed.previousPlanetName,
			expectedNames.previousPlanet,
		) ||
		!hasTransactionArtifactPrefix(
			parsed.previousWorldName,
			expectedNames.previousWorld,
		) ||
		(parsed.operation === "activate") !== (parsed.stagedWorldName !== null) ||
		(parsed.stagedWorldName !== null && !STAGED_WORLD_NAME.test(parsed.stagedWorldName))
	) {
		throw new Error("Planet transaction journal contains unexpected artifact names.");
	}
	if (
		parsed.previousLocalConfBase64 !== null &&
		(parsed.previousLocalConfBase64.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				parsed.previousLocalConfBase64,
			))
	) {
		throw new Error(
			"Planet transaction journal contains an invalid local.conf snapshot.",
		);
	}
	return parsed;
}

function fsyncDirectory(directory: string): void {
	const fd = fs.openSync(/* turbopackIgnore: true */ directory, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function writePlanetTransactionJournal(
	ztFolder: string,
	journal: PlanetTransactionJournal,
	lock: HeldPlanetLock,
	initial: boolean,
): void {
	assertPlanetLockOwnership(lock);
	parsePlanetTransactionJournal(journal);
	const journalPath = path.join(
		/* turbopackIgnore: true */ ztFolder,
		PLANET_JOURNAL_FILE_NAME,
	);
	const existing = fs.lstatSync(/* turbopackIgnore: true */ journalPath, {
		throwIfNoEntry: false,
	});
	if (initial && existing) {
		throw new Error("An unresolved Planet transaction journal already exists.");
	}
	if (!initial && (!existing?.isFile() || existing.isSymbolicLink())) {
		throw new Error("The Planet transaction journal disappeared during the operation.");
	}

	const contents = JSON.stringify(journal);
	if (Buffer.byteLength(contents) > MAX_CONTROL_FILE_BYTES) {
		throw new Error("Planet transaction journal is too large.");
	}
	const temporaryPath = path.join(
		/* turbopackIgnore: true */ ztFolder,
		`${PLANET_JOURNAL_FILE_NAME}.tmp-${journal.token}-${randomUUID()}`,
	);
	let fd: number | null = null;
	try {
		fd = fs.openSync(
			/* turbopackIgnore: true */ temporaryPath,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
			0o600,
		);
		fs.writeFileSync(fd, contents, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = null;
		assertPlanetLockOwnership(lock);
		fs.renameSync(/* turbopackIgnore: true */ temporaryPath, journalPath);
		fsyncDirectory(ztFolder);
	} finally {
		if (fd !== null) fs.closeSync(fd);
		fs.rmSync(/* turbopackIgnore: true */ temporaryPath, { force: true });
	}
}

function readPlanetTransactionJournal(ztFolder: string): PlanetTransactionJournal | null {
	const journalPath = path.join(
		/* turbopackIgnore: true */ ztFolder,
		PLANET_JOURNAL_FILE_NAME,
	);
	const stats = fs.lstatSync(/* turbopackIgnore: true */ journalPath, {
		throwIfNoEntry: false,
	});
	if (!stats) return null;
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CONTROL_FILE_BYTES) {
		throw new Error("Planet transaction journal must be a small regular file.");
	}
	return parsePlanetTransactionJournal(
		JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ journalPath, "utf8")),
	);
}

function removePlanetTransactionJournal(ztFolder: string, lock: HeldPlanetLock): void {
	assertPlanetLockOwnership(lock);
	const journalPath = path.join(
		/* turbopackIgnore: true */ ztFolder,
		PLANET_JOURNAL_FILE_NAME,
	);
	const stats = fs.lstatSync(/* turbopackIgnore: true */ journalPath, {
		throwIfNoEntry: false,
	});
	if (!stats) return;
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error("Planet transaction journal is no longer a regular file.");
	}
	fs.unlinkSync(/* turbopackIgnore: true */ journalPath);
	fsyncDirectory(ztFolder);
}

function journalArtifactPath(ztFolder: string, name: string): string {
	assertSafeJournalName(name, "artifact name");
	return path.join(/* turbopackIgnore: true */ ztFolder, name);
}

function removeWorldArtifact(directory: string): void {
	fs.rmSync(/* turbopackIgnore: true */ directory, { recursive: true, force: true });
}

function rollbackPlanetTransaction(
	ztFolder: string,
	journal: PlanetTransactionJournal,
	lock: HeldPlanetLock,
): void {
	const worldDirectory = path.join(/* turbopackIgnore: true */ ztFolder, "zt-mkworld");
	const planetPath = path.join(/* turbopackIgnore: true */ ztFolder, "planet");
	const localConfPath = path.join(/* turbopackIgnore: true */ ztFolder, "local.conf");
	const pendingPlanet = journalArtifactPath(ztFolder, journal.pendingPlanetName);
	const previousPlanet = journalArtifactPath(ztFolder, journal.previousPlanetName);
	const previousWorld = journalArtifactPath(ztFolder, journal.previousWorldName);
	const stagedWorld = journal.stagedWorldName
		? journalArtifactPath(ztFolder, journal.stagedWorldName)
		: null;

	assertPlanetLockOwnership(lock);
	restoreFileSnapshot(
		localConfPath,
		journal.previousLocalConfBase64 === null
			? null
			: Buffer.from(journal.previousLocalConfBase64, "base64"),
	);

	assertPlanetLockOwnership(lock);
	if (fs.existsSync(/* turbopackIgnore: true */ previousPlanet)) {
		assertRegularNonemptyFile(previousPlanet, "The previous active Planet");
		fs.rmSync(/* turbopackIgnore: true */ planetPath, { force: true });
		fs.renameSync(/* turbopackIgnore: true */ previousPlanet, planetPath);
	} else if (!journal.hadPlanet) {
		fs.rmSync(/* turbopackIgnore: true */ planetPath, { force: true });
	}

	assertPlanetLockOwnership(lock);
	if (fs.existsSync(/* turbopackIgnore: true */ previousWorld)) {
		assertRealDirectory(previousWorld, "The previous Planet configuration folder");
		removeWorldArtifact(worldDirectory);
		fs.renameSync(/* turbopackIgnore: true */ previousWorld, worldDirectory);
	} else if (!journal.hadWorldDirectory) {
		removeWorldArtifact(worldDirectory);
	}

	assertPlanetLockOwnership(lock);
	fs.rmSync(/* turbopackIgnore: true */ pendingPlanet, { force: true });
	if (stagedWorld) removeWorldArtifact(stagedWorld);
	fs.rmSync(/* turbopackIgnore: true */ previousPlanet, { force: true });
	removeWorldArtifact(previousWorld);
	fsyncOptionalRegularFile(localConfPath, "The rolled back local.conf");
	fsyncDirectory(ztFolder);

	if (journal.hadPlanet) assertRegularNonemptyFile(planetPath, "The rolled back Planet");
	else if (fs.existsSync(/* turbopackIgnore: true */ planetPath)) {
		throw new Error("Planet rollback did not restore the absence of the active Planet.");
	}
	if (journal.hadWorldDirectory) {
		assertRealDirectory(worldDirectory, "The rolled back Planet configuration folder");
	} else if (fs.existsSync(/* turbopackIgnore: true */ worldDirectory)) {
		throw new Error("Planet rollback did not restore the absence of the world folder.");
	}
	const expectedLocalConf =
		journal.previousLocalConfBase64 === null
			? null
			: Buffer.from(journal.previousLocalConfBase64, "base64");
	const restoredLocalConf = readOptionalRegularFile(
		localConfPath,
		"The rolled back local.conf",
	);
	if (
		(expectedLocalConf === null) !== (restoredLocalConf === null) ||
		(expectedLocalConf !== null && !expectedLocalConf.equals(restoredLocalConf))
	) {
		throw new Error("Planet rollback did not restore local.conf.");
	}
	removePlanetTransactionJournal(ztFolder, lock);
}

function completePlanetTransaction(
	ztFolder: string,
	journal: PlanetTransactionJournal,
	lock: HeldPlanetLock,
): void {
	const worldDirectory = path.join(/* turbopackIgnore: true */ ztFolder, "zt-mkworld");
	const planetPath = path.join(/* turbopackIgnore: true */ ztFolder, "planet");
	assertRegularNonemptyFile(planetPath, "The committed active Planet");
	if (journal.operation === "activate") {
		assertRealDirectory(worldDirectory, "The committed Planet configuration folder");
	} else if (fs.existsSync(/* turbopackIgnore: true */ worldDirectory)) {
		throw new Error("The committed Planet reset still has a custom world folder.");
	}

	assertPlanetLockOwnership(lock);
	fs.rmSync(
		/* turbopackIgnore: true */ journalArtifactPath(ztFolder, journal.pendingPlanetName),
		{ force: true },
	);
	fs.rmSync(
		/* turbopackIgnore: true */ journalArtifactPath(ztFolder, journal.previousPlanetName),
		{ force: true },
	);
	removeWorldArtifact(journalArtifactPath(ztFolder, journal.previousWorldName));
	if (journal.stagedWorldName) {
		removeWorldArtifact(journalArtifactPath(ztFolder, journal.stagedWorldName));
	}
	fsyncDirectory(ztFolder);
	removePlanetTransactionJournal(ztFolder, lock);
}

async function reconcilePlanetTransaction(
	ztFolder: string,
	readDatabaseStateId: () => Promise<string>,
	lock: HeldPlanetLock,
): Promise<PlanetRecoveryResult> {
	const journal = readPlanetTransactionJournal(ztFolder);
	if (!journal) return "none";

	let databaseWasCommitted = journal.phase === "database_committed";
	if (journal.phase === "database_commit_started") {
		assertPlanetLockOwnership(lock);
		const currentDatabaseStateId = await readDatabaseStateId();
		assertPlanetLockOwnership(lock);
		if (typeof currentDatabaseStateId !== "string") {
			throw new Error("Planet database state reader returned an invalid state ID.");
		}
		databaseWasCommitted = currentDatabaseStateId === journal.databaseStateId;
	}

	if (databaseWasCommitted) {
		completePlanetTransaction(ztFolder, journal, lock);
		return "completed";
	}
	rollbackPlanetTransaction(ztFolder, journal, lock);
	return "rolled_back";
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
	if (existing) {
		fsyncRegularFile(existing);
		fsyncDirectory(backupDirectory);
		return existing;
	}

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
	fsyncRegularFile(backupPath);
	fsyncDirectory(backupDirectory);
	fsyncDirectory(path.dirname(backupDirectory));
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
	// Removing first avoids following a local.conf symlink which appeared after
	// the snapshot was taken. A retained journal makes this step retryable.
	fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true });
	fs.writeFileSync(/* turbopackIgnore: true */ filePath, previous, {
		mode,
		flag: "wx",
	});
	fs.chmodSync(/* turbopackIgnore: true */ filePath, mode);
}

interface PlanetFileTransactionOptions {
	ztFolder: string;
	updatePorts: (ports: number[]) => Promise<unknown>;
	commitDatabase: () => Promise<unknown>;
	databaseStateId: string;
	readDatabaseStateId: () => Promise<string>;
}

export interface ActivatePreparedPlanetOptions extends PlanetFileTransactionOptions {
	stagedWorldDirectory: string;
	ports: number[];
	expectedSigningStateId: string;
}

function assertDatabaseStateId(databaseStateId: string): void {
	if (!databaseStateId || databaseStateId.length > 256) {
		throw new Error("The Planet database state ID is invalid.");
	}
}

function fsyncRegularFile(filePath: string): void {
	const fd = fs.openSync(/* turbopackIgnore: true */ filePath, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function fsyncOptionalRegularFile(filePath: string, label: string): void {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!stats) return;
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file.`);
	}
	fsyncRegularFile(filePath);
}

function fsyncDirectoryTree(directory: string): void {
	assertRealDirectory(directory, "The staged Planet folder");
	for (const entry of fs.readdirSync(/* turbopackIgnore: true */ directory, {
		withFileTypes: true,
	})) {
		const entryPath = path.join(/* turbopackIgnore: true */ directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error("The staged Planet folder must not contain symbolic links.");
		}
		if (entry.isDirectory()) fsyncDirectoryTree(entryPath);
		else if (entry.isFile()) fsyncRegularFile(entryPath);
		else throw new Error("The staged Planet folder contains an unsupported file type.");
	}
	fsyncDirectory(directory);
}

function openSigningKeyForRead(filePath: string, label: string): number | null {
	const observedStats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!observedStats) return null;
	if (
		!observedStats.isFile() ||
		observedStats.isSymbolicLink() ||
		observedStats.size === 0 ||
		observedStats.size > MAX_SIGNING_KEY_BYTES
	) {
		throw new Error(`${label} must be a non-empty regular file.`);
	}

	const fd = fs.openSync(
		/* turbopackIgnore: true */ filePath,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
	);
	try {
		const descriptorStats = fs.fstatSync(fd);
		if (
			!sameFile(observedStats, descriptorStats) ||
			!descriptorStats.isFile() ||
			descriptorStats.size === 0 ||
			descriptorStats.size > MAX_SIGNING_KEY_BYTES
		) {
			throw new Error(`${label} changed while it was being opened.`);
		}
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function readSigningKeyContents(filePath: string, label: string): Buffer | null {
	const fd = openSigningKeyForRead(filePath, label);
	if (fd === null) return null;
	try {
		const contents = fs.readFileSync(fd);
		const sourceStats = fs.fstatSync(fd);
		if (
			contents.length === 0 ||
			contents.length > MAX_SIGNING_KEY_BYTES ||
			contents.length !== sourceStats.size
		) {
			throw new Error(`${label} changed while it was being read.`);
		}
		return contents;
	} finally {
		fs.closeSync(fd);
	}
}

function writeSigningKeySnapshot(
	destinationPath: string,
	contents: Buffer,
	lock: HeldPlanetLock,
): void {
	let destinationFd: number | null = null;
	try {
		assertPlanetLockOwnership(lock);

		destinationFd = fs.openSync(
			/* turbopackIgnore: true */ destinationPath,
			fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				fs.constants.O_WRONLY |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		fs.writeFileSync(destinationFd, contents);
		fs.fsyncSync(destinationFd);
		assertPlanetLockOwnership(lock);
	} catch (error) {
		if (destinationFd !== null) {
			removeControlFileByDescriptor(destinationPath, destinationFd);
		}
		throw error;
	} finally {
		if (destinationFd !== null) fs.closeSync(destinationFd);
	}
}

function createActiveSigningStateId(ztFolder: string): string {
	const activeWorldDirectory = path.join(
		/* turbopackIgnore: true */ ztFolder,
		"zt-mkworld",
	);
	const hasActiveWorld = validateOptionalWorldDirectory(activeWorldDirectory);
	const hash = createHash("sha256").update("ztnet-planet-signing-state-v1\0");
	hash.update(hasActiveWorld ? "world\0" : "no-world\0");
	let activeKeyCount = 0;
	for (const keyName of PLANET_SIGNING_KEY_NAMES) {
		const contents = hasActiveWorld
			? readSigningKeyContents(
					path.join(/* turbopackIgnore: true */ activeWorldDirectory, keyName),
					`The active signing key ${keyName}`,
				)
			: null;
		hash.update(`${keyName}\0`);
		if (contents === null) {
			hash.update("missing\0");
		} else {
			activeKeyCount += 1;
			const size = Buffer.allocUnsafe(4);
			size.writeUInt32BE(contents.length);
			hash.update("present\0").update(size).update(contents);
		}
	}
	if (activeKeyCount !== 0 && activeKeyCount !== PLANET_SIGNING_KEY_NAMES.length) {
		throw new Error(
			"The active Planet folder must contain both signing keys or neither signing key.",
		);
	}
	return hash.digest("hex");
}

function persistJournalPhase(
	ztFolder: string,
	journal: PlanetTransactionJournal,
	phase: JournalPhase,
	lock: HeldPlanetLock,
): PlanetTransactionJournal {
	const updated = { ...journal, phase };
	writePlanetTransactionJournal(ztFolder, updated, lock, false);
	return updated;
}

async function withPlanetLifecycleLock<T>(
	ztFolder: string,
	readDatabaseStateId: () => Promise<string>,
	operation: (lock: HeldPlanetLock, recoveryResult: PlanetRecoveryResult) => Promise<T>,
): Promise<T> {
	assertRealDirectory(ztFolder, "The ZeroTier folder");
	const lockKey = fs.realpathSync(/* turbopackIgnore: true */ ztFolder);
	return withInProcessPlanetLock(lockKey, async () => {
		const lock = await acquirePlanetFileLock(ztFolder);
		try {
			assertPlanetLockOwnership(lock);
			const recoveryResult = await reconcilePlanetTransaction(
				ztFolder,
				readDatabaseStateId,
				lock,
			);
			assertPlanetLockOwnership(lock);
			return await operation(lock, recoveryResult);
		} finally {
			try {
				await releasePlanetFileLock(ztFolder, lock);
			} catch (releaseError) {
				// The lease will eventually make an orphaned lock reclaimable. Do not
				// replace the lifecycle operation's more useful result or error.
				console.error("Planet lifecycle lock release failed", releaseError);
			}
		}
	});
}

export type PlanetRecoveryResult = "completed" | "rolled_back" | "none";

export interface RecoverPlanetFileTransactionOptions {
	ztFolder: string;
	readDatabaseStateId: () => Promise<string>;
}

export interface SnapshotPlanetSigningKeysOptions {
	ztFolder: string;
	stagedWorldDirectory: string;
	readDatabaseStateId: () => Promise<string>;
}

export async function recoverPlanetFileTransaction({
	ztFolder,
	readDatabaseStateId,
}: RecoverPlanetFileTransactionOptions): Promise<PlanetRecoveryResult> {
	return withPlanetLifecycleLock(
		ztFolder,
		readDatabaseStateId,
		async (_lock, recoveryResult) => recoveryResult,
	);
}

/**
 * Copies any missing active signing keys into a prepared world directory while
 * serializing against Planet activation, reset, and startup recovery.
 */
export async function snapshotPlanetSigningKeys({
	ztFolder,
	stagedWorldDirectory,
	readDatabaseStateId,
}: SnapshotPlanetSigningKeysOptions): Promise<string> {
	return withPlanetLifecycleLock(ztFolder, readDatabaseStateId, async (lock) => {
		assertStagedWorldDirectory(ztFolder, stagedWorldDirectory);
		const activeWorldDirectory = path.join(
			/* turbopackIgnore: true */ ztFolder,
			"zt-mkworld",
		);
		const hasActiveWorld = validateOptionalWorldDirectory(activeWorldDirectory);
		const stagedKeyPresence: boolean[] = [];
		for (const keyName of PLANET_SIGNING_KEY_NAMES) {
			assertPlanetLockOwnership(lock);
			const stagedKeyPath = path.join(
				/* turbopackIgnore: true */ stagedWorldDirectory,
				keyName,
			);
			const stagedKeyFd = openSigningKeyForRead(
				stagedKeyPath,
				`The staged signing key ${keyName}`,
			);
			if (stagedKeyFd !== null) {
				try {
					fs.fsyncSync(stagedKeyFd);
				} finally {
					fs.closeSync(stagedKeyFd);
				}
				stagedKeyPresence.push(true);
			} else {
				stagedKeyPresence.push(false);
			}
		}
		const stagedKeyCount = stagedKeyPresence.filter(Boolean).length;
		if (stagedKeyCount !== 0 && stagedKeyCount !== PLANET_SIGNING_KEY_NAMES.length) {
			throw new Error(
				"The staged Planet folder must contain both signing keys or neither signing key.",
			);
		}

		const signingStateId = createActiveSigningStateId(ztFolder);
		if (stagedKeyCount === 0 && hasActiveWorld) {
			const activeKeys = PLANET_SIGNING_KEY_NAMES.map((keyName) =>
				readSigningKeyContents(
					path.join(/* turbopackIgnore: true */ activeWorldDirectory, keyName),
					`The active signing key ${keyName}`,
				),
			);
			const activeKeyCount = activeKeys.filter(
				(contents): contents is Buffer => contents !== null,
			).length;
			if (activeKeyCount !== 0 && activeKeyCount !== PLANET_SIGNING_KEY_NAMES.length) {
				throw new Error(
					"The active Planet folder must contain both signing keys or neither signing key.",
				);
			}

			for (const [index, activeKey] of activeKeys.entries()) {
				if (activeKey !== null) {
					writeSigningKeySnapshot(
						path.join(
							/* turbopackIgnore: true */ stagedWorldDirectory,
							PLANET_SIGNING_KEY_NAMES[index],
						),
						activeKey,
						lock,
					);
				}
			}
		}

		assertPlanetLockOwnership(lock);
		fsyncDirectory(stagedWorldDirectory);
		return signingStateId;
	});
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
	databaseStateId,
	readDatabaseStateId,
	expectedSigningStateId,
}: ActivatePreparedPlanetOptions): Promise<void> {
	assertDatabaseStateId(databaseStateId);
	await withPlanetLifecycleLock(ztFolder, readDatabaseStateId, async (lock) => {
		const stagedWorldName = assertStagedWorldDirectory(ztFolder, stagedWorldDirectory);
		if (createActiveSigningStateId(ztFolder) !== expectedSigningStateId) {
			throw new Error(
				"The active Planet signing keys changed while the new Planet was being generated.",
			);
		}
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
		let journal: PlanetTransactionJournal = {
			version: JOURNAL_VERSION,
			token: randomUUID(),
			operation: "activate",
			phase: "prepared",
			hadWorldDirectory,
			hadPlanet,
			stagedWorldName,
			pendingPlanetName: path.basename(pendingPlanet),
			previousPlanetName: path.basename(previousPlanet),
			previousWorldName: path.basename(previousWorld),
			previousLocalConfBase64: previousLocalConf?.toString("base64") ?? null,
			databaseStateId,
			createdAt: new Date().toISOString(),
		};
		try {
			writePlanetTransactionJournal(ztFolder, journal, lock, true);
			assertPlanetLockOwnership(lock);
			fs.copyFileSync(
				/* turbopackIgnore: true */ generatedPlanet,
				pendingPlanet,
				fs.constants.COPYFILE_EXCL,
			);
			fs.chmodSync(/* turbopackIgnore: true */ pendingPlanet, 0o600);
			assertRegularNonemptyFile(pendingPlanet, "The staged active Planet");
			fsyncRegularFile(pendingPlanet);
			fsyncDirectoryTree(stagedWorldDirectory);

			assertPlanetLockOwnership(lock);
			if (hadWorldDirectory) {
				fs.renameSync(/* turbopackIgnore: true */ worldDirectory, previousWorld);
				fsyncDirectory(ztFolder);
			}
			assertPlanetLockOwnership(lock);
			fs.renameSync(/* turbopackIgnore: true */ stagedWorldDirectory, worldDirectory);
			fsyncDirectory(ztFolder);

			assertPlanetLockOwnership(lock);
			if (hadPlanet) {
				fs.renameSync(/* turbopackIgnore: true */ planetPath, previousPlanet);
				fsyncDirectory(ztFolder);
			}
			assertPlanetLockOwnership(lock);
			fs.renameSync(/* turbopackIgnore: true */ pendingPlanet, planetPath);
			fsyncDirectory(ztFolder);
			journal = persistJournalPhase(ztFolder, journal, "files_installed", lock);

			assertPlanetLockOwnership(lock);
			await updatePorts(ports);
			assertPlanetLockOwnership(lock);
			fsyncOptionalRegularFile(localConfPath, "The updated local.conf");
			fsyncDirectory(ztFolder);
			journal = persistJournalPhase(ztFolder, journal, "database_commit_started", lock);

			assertPlanetLockOwnership(lock);
			await commitDatabase();
			assertPlanetLockOwnership(lock);
			journal = persistJournalPhase(ztFolder, journal, "database_committed", lock);
		} catch (error) {
			try {
				await reconcilePlanetTransaction(ztFolder, readDatabaseStateId, lock);
			} catch (rollbackError) {
				console.error("Planet activation reconciliation failed", rollbackError);
			}
			throw error;
		}

		try {
			completePlanetTransaction(ztFolder, journal, lock);
		} catch (cleanupError) {
			console.warn("Planet activation cleanup was incomplete", cleanupError);
		}
	});
}

/** Restores the latest original Planet while preserving its backup for reuse. */
export async function restoreOriginalPlanet({
	ztFolder,
	updatePorts,
	commitDatabase,
	databaseStateId,
	readDatabaseStateId,
}: PlanetFileTransactionOptions): Promise<void> {
	assertDatabaseStateId(databaseStateId);
	await withPlanetLifecycleLock(ztFolder, readDatabaseStateId, async (lock) => {
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
		let journal: PlanetTransactionJournal = {
			version: JOURNAL_VERSION,
			token: randomUUID(),
			operation: "restore",
			phase: "prepared",
			hadWorldDirectory,
			hadPlanet,
			stagedWorldName: null,
			pendingPlanetName: path.basename(pendingPlanet),
			previousPlanetName: path.basename(previousPlanet),
			previousWorldName: path.basename(previousWorld),
			previousLocalConfBase64: previousLocalConf?.toString("base64") ?? null,
			databaseStateId,
			createdAt: new Date().toISOString(),
		};
		try {
			writePlanetTransactionJournal(ztFolder, journal, lock, true);
			assertPlanetLockOwnership(lock);
			fs.copyFileSync(
				/* turbopackIgnore: true */ originalPlanet,
				pendingPlanet,
				fs.constants.COPYFILE_EXCL,
			);
			fs.chmodSync(/* turbopackIgnore: true */ pendingPlanet, 0o600);
			assertRegularNonemptyFile(pendingPlanet, "The staged original Planet");
			fsyncRegularFile(pendingPlanet);

			assertPlanetLockOwnership(lock);
			if (hadWorldDirectory) {
				fs.renameSync(/* turbopackIgnore: true */ worldDirectory, previousWorld);
				fsyncDirectory(ztFolder);
			}
			assertPlanetLockOwnership(lock);
			if (hadPlanet) {
				fs.renameSync(/* turbopackIgnore: true */ planetPath, previousPlanet);
				fsyncDirectory(ztFolder);
			}
			assertPlanetLockOwnership(lock);
			fs.renameSync(/* turbopackIgnore: true */ pendingPlanet, planetPath);
			fsyncDirectory(ztFolder);
			journal = persistJournalPhase(ztFolder, journal, "files_installed", lock);

			assertPlanetLockOwnership(lock);
			await updatePorts([9993]);
			assertPlanetLockOwnership(lock);
			fsyncOptionalRegularFile(localConfPath, "The updated local.conf");
			fsyncDirectory(ztFolder);
			journal = persistJournalPhase(ztFolder, journal, "database_commit_started", lock);

			assertPlanetLockOwnership(lock);
			await commitDatabase();
			assertPlanetLockOwnership(lock);
			journal = persistJournalPhase(ztFolder, journal, "database_committed", lock);
		} catch (error) {
			try {
				await reconcilePlanetTransaction(ztFolder, readDatabaseStateId, lock);
			} catch (rollbackError) {
				console.error("Planet reset reconciliation failed", rollbackError);
			}
			throw error;
		}

		try {
			completePlanetTransaction(ztFolder, journal, lock);
		} catch (cleanupError) {
			console.warn("Planet reset cleanup was incomplete", cleanupError);
		}
	});
}
