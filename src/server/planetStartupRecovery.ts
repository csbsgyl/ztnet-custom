import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PLANET_JOURNAL_FILE_NAME, type PlanetRecoveryResult } from "./planetFiles";
import { runStartupTaskWithRetries } from "./startupRetry";

export const PLANET_RESTART_REQUIRED_FILE_NAME = ".ztnet-planet-restart-required";

export const DEFAULT_PLANET_RECOVERY_RETRY_DELAYS_MS = [
	250, 1_000, 2_000, 4_000,
] as const;
export const DEFAULT_PLANET_RESTART_RETRY_DELAYS_MS = [
	1_000, 2_000, 4_000, 8_000,
] as const;

const RESTART_MARKER_VERSION = 1;
const MAX_RESTART_MARKER_BYTES = 1_024;

export interface PlanetStartupState {
	journalPresent: boolean;
	restartRequired: boolean;
}

export interface PlanetStartupRecoveryDependencies {
	enabled: boolean;
	inspectState: () => Promise<PlanetStartupState>;
	markRestartRequired: () => Promise<void>;
	recover: () => Promise<PlanetRecoveryResult>;
	restart: () => Promise<unknown>;
	clearRestartRequired: () => Promise<void>;
	wait: (milliseconds: number) => Promise<void>;
	recoveryRetryDelaysMs?: readonly number[];
	restartRetryDelaysMs?: readonly number[];
	onRetry?: (
		operation: "recovery" | "restart",
		attempt: number,
		error: unknown,
		delayMs: number,
	) => void;
}

export type PlanetStartupRecoveryOutcome =
	| { status: "skipped"; recoveryResult: "none" }
	| { status: "none"; recoveryResult: "none" }
	| { status: "restarted"; recoveryResult: PlanetRecoveryResult };

function fsyncDirectory(directory: string): void {
	const fd = fs.openSync(/* turbopackIgnore: true */ directory, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function markerPath(ztFolder: string): string {
	return path.join(
		/* turbopackIgnore: true */ ztFolder,
		PLANET_RESTART_REQUIRED_FILE_NAME,
	);
}

function assertRestartMarker(filePath: string): fs.Stats {
	const stats = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (
		!stats?.isFile() ||
		stats.isSymbolicLink() ||
		stats.size === 0 ||
		stats.size > MAX_RESTART_MARKER_BYTES
	) {
		throw new Error("The Planet restart-required marker is invalid.");
	}

	let marker: unknown;
	try {
		marker = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"));
	} catch {
		throw new Error("The Planet restart-required marker is invalid.");
	}
	if (
		!marker ||
		typeof marker !== "object" ||
		Array.isArray(marker) ||
		(marker as { version?: unknown }).version !== RESTART_MARKER_VERSION
	) {
		throw new Error("The Planet restart-required marker is invalid.");
	}
	return stats;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function fsyncRegularFile(filePath: string): void {
	const fd = fs.openSync(/* turbopackIgnore: true */ filePath, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export async function inspectPlanetStartupState(
	ztFolder: string,
): Promise<PlanetStartupState> {
	const journalStats = fs.lstatSync(
		path.join(/* turbopackIgnore: true */ ztFolder, PLANET_JOURNAL_FILE_NAME),
		{ throwIfNoEntry: false },
	);
	const restartMarkerPath = markerPath(ztFolder);
	const restartMarkerStats = fs.lstatSync(/* turbopackIgnore: true */ restartMarkerPath, {
		throwIfNoEntry: false,
	});
	if (restartMarkerStats) assertRestartMarker(restartMarkerPath);

	return {
		// Recovery owns validation of a present journal. Treating every directory
		// entry as present ensures malformed or substituted journals fail closed.
		journalPresent: Boolean(journalStats),
		restartRequired: Boolean(restartMarkerStats),
	};
}

export async function markPlanetRestartRequired(ztFolder: string): Promise<void> {
	const filePath = markerPath(ztFolder);
	const existing = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (existing) {
		assertRestartMarker(filePath);
		fsyncRegularFile(filePath);
		fsyncDirectory(ztFolder);
		return;
	}

	const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(
			/* turbopackIgnore: true */ temporaryPath,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
			0o600,
		);
		fs.writeFileSync(fd, `${JSON.stringify({ version: RESTART_MARKER_VERSION })}\n`);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;

		try {
			// link(2) publishes the fully fsynced marker without replacing a marker
			// another process may have created concurrently.
			fs.linkSync(/* turbopackIgnore: true */ temporaryPath, filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			assertRestartMarker(filePath);
		}
		fs.unlinkSync(/* turbopackIgnore: true */ temporaryPath);
		fsyncDirectory(ztFolder);
	} catch (error) {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(/* turbopackIgnore: true */ temporaryPath, { force: true });
		throw error;
	}
}

export async function clearPlanetRestartRequired(ztFolder: string): Promise<void> {
	const filePath = markerPath(ztFolder);
	const observed = fs.lstatSync(/* turbopackIgnore: true */ filePath, {
		throwIfNoEntry: false,
	});
	if (!observed) return;
	assertRestartMarker(filePath);

	const quarantinePath = `${filePath}.clear-${randomUUID()}`;
	try {
		fs.renameSync(/* turbopackIgnore: true */ filePath, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const quarantined = fs.lstatSync(/* turbopackIgnore: true */ quarantinePath, {
		throwIfNoEntry: false,
	});
	if (!quarantined || !sameFile(observed, quarantined)) {
		if (quarantined) {
			try {
				// A newer marker may have appeared after the initial observation. Put
				// that inode back without overwriting an even newer marker.
				fs.linkSync(/* turbopackIgnore: true */ quarantinePath, filePath);
				fs.unlinkSync(/* turbopackIgnore: true */ quarantinePath);
				fsyncDirectory(ztFolder);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				assertRestartMarker(filePath);
				fs.unlinkSync(/* turbopackIgnore: true */ quarantinePath);
				fsyncDirectory(ztFolder);
			}
		}
		throw new Error("The Planet restart-required marker changed while being cleared.");
	}
	fs.unlinkSync(/* turbopackIgnore: true */ quarantinePath);
	fsyncDirectory(ztFolder);
}

export function waitForPlanetStartupRetry(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runPlanetStartupRecovery({
	enabled,
	inspectState,
	markRestartRequired,
	recover,
	restart,
	clearRestartRequired,
	wait,
	recoveryRetryDelaysMs = DEFAULT_PLANET_RECOVERY_RETRY_DELAYS_MS,
	restartRetryDelaysMs = DEFAULT_PLANET_RESTART_RETRY_DELAYS_MS,
	onRetry,
}: PlanetStartupRecoveryDependencies): Promise<PlanetStartupRecoveryOutcome> {
	if (!enabled) return { status: "skipped", recoveryResult: "none" };

	const state = await inspectState();
	if (!state.journalPresent && !state.restartRequired) {
		return { status: "none", recoveryResult: "none" };
	}

	let recoveryResult: PlanetRecoveryResult = "none";
	if (state.journalPresent) {
		// This marker is durable before recovery can remove the journal. A crash
		// after file reconciliation therefore cannot lose the required restart.
		await markRestartRequired();
		recoveryResult = await runStartupTaskWithRetries({
			operationName: "Planet startup recovery",
			operation: recover,
			retryDelaysMs: recoveryRetryDelaysMs,
			wait,
			onRetry: (attempt, error, delayMs) =>
				onRetry?.("recovery", attempt, error, delayMs),
		});
	}

	await runStartupTaskWithRetries({
		operationName: "Planet startup restart",
		operation: restart,
		retryDelaysMs: restartRetryDelaysMs,
		wait,
		onRetry: (attempt, error, delayMs) => onRetry?.("restart", attempt, error, delayMs),
	});
	await clearRestartRequired();
	return { status: "restarted", recoveryResult };
}
