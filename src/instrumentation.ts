import { runStartupTaskWithRetries } from "./server/startupRetry";

const API_TOKEN_MIGRATION_RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000] as const;

export interface ApiTokenStartupMigrationDependencies {
	enabled: boolean;
	migrate: () => Promise<number>;
	wait: (milliseconds: number) => Promise<void>;
	retryDelaysMs?: readonly number[];
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function runApiTokenStartupMigration({
	enabled,
	migrate,
	wait,
	retryDelaysMs = API_TOKEN_MIGRATION_RETRY_DELAYS_MS,
	onRetry,
}: ApiTokenStartupMigrationDependencies): Promise<
	{ status: "skipped"; migrated: 0 } | { status: "completed"; migrated: number }
> {
	if (!enabled) return { status: "skipped", migrated: 0 };
	const migrated = await runStartupTaskWithRetries({
		operationName: "API token digest startup migration",
		operation: migrate,
		retryDelaysMs,
		wait,
		onRetry,
	});
	return { status: "completed", migrated };
}

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const [startupRecoveryModule, ztPathsModule] = await Promise.all([
			import("./server/planetStartupRecovery"),
			import("./utils/ztPaths"),
		]);
		try {
			await startupRecoveryModule.runPlanetStartupRecovery({
				enabled: process.env.NODE_ENV === "production",
				inspectState: () =>
					startupRecoveryModule.inspectPlanetStartupState(ztPathsModule.ZT_FOLDER),
				markRestartRequired: () =>
					startupRecoveryModule.markPlanetRestartRequired(ztPathsModule.ZT_FOLDER),
				recover: async () => {
					const [planetFilesModule, databaseModule] = await Promise.all([
						import("./server/planetFiles"),
						import("./server/db"),
					]);
					return planetFilesModule.recoverPlanetFileTransaction({
						ztFolder: ztPathsModule.ZT_FOLDER,
						readDatabaseStateId: async () => {
							const options = await databaseModule.prisma.globalOptions.findUnique({
								where: { id: 1 },
								select: planetFilesModule.PLANET_DATABASE_STATE_SELECT,
							});
							if (!options) {
								throw new Error("Global Planet options do not exist.");
							}
							return planetFilesModule.createPlanetDatabaseStateId(options);
						},
					});
				},
				restart: async () => {
					const { restartZeroTier } = await import("./server/zeroTierRestart");
					const result = await restartZeroTier();
					if (!result.restarted) {
						throw new Error("A ZeroTier restart is still in progress.");
					}
				},
				clearRestartRequired: () =>
					startupRecoveryModule.clearPlanetRestartRequired(ztPathsModule.ZT_FOLDER),
				wait: startupRecoveryModule.waitForPlanetStartupRetry,
				onRetry: (operation, attempt, error, delayMs) => {
					console.warn(
						`Planet startup ${operation} attempt ${attempt} failed; retrying in ${delayMs}ms`,
						error,
					);
				},
			});
		} catch (error) {
			console.error(
				"Planet lifecycle startup recovery failed; startup is stopping with durable recovery state retained",
				error,
			);
			throw error;
		}

		await runApiTokenStartupMigration({
			enabled: process.env.NODE_ENV === "production",
			migrate: async () => {
				const { migrateLegacyApiTokenDigests } = await import("./utils/encryption");
				return migrateLegacyApiTokenDigests();
			},
			wait: startupRecoveryModule.waitForPlanetStartupRetry,
			onRetry: (attempt, error, delayMs) => {
				console.warn(
					`API token digest startup migration attempt ${attempt} failed; retrying in ${delayMs}ms`,
					error,
				);
			},
		});

		const cronTasksModule = await import("./cronTasks");
		if (cronTasksModule.CheckExpiredUsers) {
			cronTasksModule.CheckExpiredUsers();
		}

		// update lastseen for all members
		if (cronTasksModule.updatePeers) {
			cronTasksModule.updatePeers();
		}
	}
}
