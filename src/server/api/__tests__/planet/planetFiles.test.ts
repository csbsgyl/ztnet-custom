import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	activatePreparedPlanet,
	type ActivatePreparedPlanetOptions,
	createPlanetDatabaseStateId,
	ensureOriginalPlanetBackup,
	getLatestOriginalPlanetBackup,
	listOriginalPlanetBackups,
	PLANET_JOURNAL_FILE_NAME,
	PLANET_LOCK_FILE_NAME,
	readOptionalRegularFile,
	recoverPlanetFileTransaction,
	restoreOriginalPlanet,
	restoreFileSnapshot,
	snapshotPlanetSigningKeys,
} from "~/server/planetFiles";

function mockCurrentProcessStartId(startId: string): jest.SpyInstance {
	const originalReadFileSync = fs.readFileSync;
	return jest.spyOn(fs, "readFileSync").mockImplementation(((
		filePath: fs.PathOrFileDescriptor,
		...args: unknown[]
	) => {
		if (filePath === `/proc/${process.pid}/stat`) {
			const fields = ["S", ...Array(18).fill("0"), startId];
			return `${process.pid} (node) ${fields.join(" ")}`;
		}
		return Reflect.apply(originalReadFileSync, fs, [filePath, ...args]);
	}) as typeof fs.readFileSync);
}

describe("Planet lifecycle files", () => {
	let temporaryDirectory: string;
	let backupDirectory: string;
	let planetPath: string;

	const databaseStateOptions = (
		databaseStateId = "desired-state",
		currentDatabaseStateId = "previous-state",
	) => ({
		databaseStateId,
		readDatabaseStateId: async () => currentDatabaseStateId,
	});

	const activateWithSigningSnapshot = async (
		options: Omit<ActivatePreparedPlanetOptions, "expectedSigningStateId">,
	): Promise<void> => {
		const expectedSigningStateId = await snapshotPlanetSigningKeys({
			ztFolder: options.ztFolder,
			stagedWorldDirectory: options.stagedWorldDirectory,
			readDatabaseStateId: options.readDatabaseStateId,
		});
		return activatePreparedPlanet({ ...options, expectedSigningStateId });
	};

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ztnet-planet-files-"));
		backupDirectory = path.join(temporaryDirectory, "planet_backup");
		planetPath = path.join(temporaryDirectory, "planet");
		fs.writeFileSync(planetPath, "official-planet");
	});

	afterEach(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("creates one immutable original backup and reuses it", () => {
		const first = ensureOriginalPlanetBackup(backupDirectory, planetPath);
		fs.writeFileSync(planetPath, "custom-planet");
		const second = ensureOriginalPlanetBackup(backupDirectory, planetPath);

		expect(second).toBe(first);
		expect(fs.readFileSync(first, "utf8")).toBe("official-planet");
		expect(listOriginalPlanetBackups(backupDirectory)).toEqual([first]);
	});

	it("fsyncs a newly created original backup and its directories", () => {
		const fsync = jest.spyOn(fs, "fsyncSync");
		try {
			ensureOriginalPlanetBackup(backupDirectory, planetPath);
			expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			fsync.mockRestore();
		}
	});

	it("creates the same database state ID regardless of root node order", () => {
		const first = createPlanetDatabaseStateId({
			customPlanetUsed: true,
			planet: {
				plID: BigInt(7),
				plBirth: BigInt(9),
				plRecommend: false,
				origin: "LOCAL_GENERATED",
				downloadSha256: "abc",
				rootNodes: [
					{ identity: "node-b", comments: "B", endpoints: ["2.2.2.2/9993"] },
					{ identity: "node-a", comments: "", endpoints: ["1.1.1.1/9993"] },
				],
			},
		});
		const reordered = createPlanetDatabaseStateId({
			customPlanetUsed: true,
			planet: {
				plID: "7",
				plBirth: "9",
				plRecommend: false,
				origin: "LOCAL_GENERATED",
				downloadSha256: "abc",
				rootNodes: [
					{ identity: "node-a", comments: null, endpoints: ["1.1.1.1/9993"] },
					{ identity: "node-b", comments: "B", endpoints: ["2.2.2.2/9993"] },
				],
			},
		});

		expect(reordered).toBe(first);
	});

	it("selects the lexically latest valid backup and ignores unrelated files", () => {
		fs.mkdirSync(backupDirectory);
		const older = path.join(backupDirectory, "planet.bak.2026_01_01");
		const newer = path.join(backupDirectory, "planet.bak.2026_07_16");
		fs.writeFileSync(newer, "newer");
		fs.writeFileSync(older, "older");
		fs.writeFileSync(path.join(backupDirectory, "notes.txt"), "ignored");

		expect(getLatestOriginalPlanetBackup(backupDirectory)).toBe(newer);
	});

	it("rejects empty backups", () => {
		fs.mkdirSync(backupDirectory);
		fs.writeFileSync(path.join(backupDirectory, "planet.bak.empty"), "");
		expect(() => listOriginalPlanetBackups(backupDirectory)).toThrow(/non-empty/i);
	});

	const symlinkTest = process.platform === "win32" ? it.skip : it;

	symlinkTest("rejects symbolic-link backup entries", () => {
		fs.mkdirSync(backupDirectory);
		const target = path.join(temporaryDirectory, "target");
		fs.writeFileSync(target, "target");
		fs.symlinkSync(target, path.join(backupDirectory, "planet.bak.link"));
		expect(() => listOriginalPlanetBackups(backupDirectory)).toThrow(/regular file/i);
	});

	symlinkTest("rejects a symbolic-link backup directory", () => {
		const realDirectory = path.join(temporaryDirectory, "real-backups");
		fs.mkdirSync(realDirectory);
		fs.symlinkSync(realDirectory, backupDirectory, "dir");

		expect(() => listOriginalPlanetBackups(backupDirectory)).toThrow(/real directory/i);
	});

	it("snapshots and restores optional regular files", () => {
		const snapshot = readOptionalRegularFile(planetPath, "Planet");
		fs.writeFileSync(planetPath, "replacement");
		restoreFileSnapshot(planetPath, snapshot);
		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");

		const newFile = path.join(temporaryDirectory, "new-file");
		fs.writeFileSync(newFile, "temporary");
		restoreFileSnapshot(newFile, null);
		expect(fs.existsSync(newFile)).toBe(false);
	});

	it("rolls back an activation when the database commit fails", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(temporaryDirectory, ".zt-mkworld-generate-test");
		const localConf = path.join(temporaryDirectory, "local.conf");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "old-key"), "old-world");
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "custom-planet");
		fs.writeFileSync(localConf, "old-local-conf");
		const updatePorts = jest.fn(async () => {
			fs.writeFileSync(localConf, "new-local-conf");
		});
		const commitDatabase = jest.fn(async () => {
			throw new Error("database unavailable");
		});

		await expect(
			activateWithSigningSnapshot({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				ports: [9993, 29993],
				updatePorts,
				commitDatabase,
				...databaseStateOptions(),
			}),
		).rejects.toThrow("database unavailable");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.readFileSync(localConf, "utf8")).toBe("old-local-conf");
		expect(fs.readFileSync(path.join(worldDirectory, "old-key"), "utf8")).toBe(
			"old-world",
		);
		expect(commitDatabase).toHaveBeenCalledTimes(1);
	});

	it("commits a prepared Planet and leaves no previous live files", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(temporaryDirectory, ".zt-mkworld-generate-test");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "old-key"), "old-world");
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "custom-planet");
		const commitDatabase = jest.fn(async () => undefined);

		await activateWithSigningSnapshot({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: stagedDirectory,
			ports: [29993],
			updatePorts: async () => undefined,
			commitDatabase,
			...databaseStateOptions(),
		});

		expect(fs.readFileSync(planetPath, "utf8")).toBe("custom-planet");
		expect(fs.existsSync(stagedDirectory)).toBe(false);
		expect(fs.existsSync(path.join(worldDirectory, "old-key"))).toBe(false);
		expect(fs.readFileSync(getLatestOriginalPlanetBackup(backupDirectory), "utf8")).toBe(
			"official-planet",
		);
		expect(commitDatabase).toHaveBeenCalledTimes(1);
	});

	it("preflights an original backup before changing reset state", async () => {
		const updatePorts = jest.fn(async () => undefined);
		const commitDatabase = jest.fn(async () => undefined);

		await expect(
			restoreOriginalPlanet({
				ztFolder: temporaryDirectory,
				updatePorts,
				commitDatabase,
				...databaseStateOptions(),
			}),
		).rejects.toThrow("No original Planet backup is available.");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(updatePorts).not.toHaveBeenCalled();
		expect(commitDatabase).not.toHaveBeenCalled();
	});

	it("rolls back an original reset when its database transaction fails", async () => {
		ensureOriginalPlanetBackup(backupDirectory, planetPath);
		fs.writeFileSync(planetPath, "custom-planet");
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const localConf = path.join(temporaryDirectory, "local.conf");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "current-key"), "private-world");
		fs.writeFileSync(localConf, "custom-local-conf");

		await expect(
			restoreOriginalPlanet({
				ztFolder: temporaryDirectory,
				updatePorts: async () => fs.writeFileSync(localConf, "default-local-conf"),
				commitDatabase: async () => {
					throw new Error("database unavailable");
				},
				...databaseStateOptions(),
			}),
		).rejects.toThrow("database unavailable");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("custom-planet");
		expect(fs.readFileSync(localConf, "utf8")).toBe("custom-local-conf");
		expect(fs.readFileSync(path.join(worldDirectory, "current-key"), "utf8")).toBe(
			"private-world",
		);
	});

	it("restores the original Planet, removes the custom world, and retains backup", async () => {
		const backup = ensureOriginalPlanetBackup(backupDirectory, planetPath);
		fs.writeFileSync(planetPath, "custom-planet");
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "planet.custom"), "custom-planet");
		const commitDatabase = jest.fn(async () => undefined);

		await restoreOriginalPlanet({
			ztFolder: temporaryDirectory,
			updatePorts: async () => undefined,
			commitDatabase,
			...databaseStateOptions(),
		});

		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.existsSync(worldDirectory)).toBe(false);
		expect(fs.existsSync(backup)).toBe(true);
		expect(commitDatabase).toHaveBeenCalledTimes(1);
	});

	it("serializes activation and reset through the same lifecycle lock", async () => {
		const stagedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-generate-activation",
		);
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "custom-planet");
		const events: string[] = [];
		let releaseActivation!: () => void;
		let markActivationEntered!: () => void;
		const activationBlocked = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		const activationEntered = new Promise<void>((resolve) => {
			markActivationEntered = resolve;
		});

		const activation = activateWithSigningSnapshot({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: stagedDirectory,
			ports: [29993],
			updatePorts: async () => {
				events.push("activate:update");
				markActivationEntered();
				await activationBlocked;
			},
			commitDatabase: async () => {
				events.push("activate:commit");
			},
			...databaseStateOptions("activated-state"),
		});
		await activationEntered;

		const reset = restoreOriginalPlanet({
			ztFolder: temporaryDirectory,
			updatePorts: async () => {
				events.push("reset:update");
			},
			commitDatabase: async () => {
				events.push("reset:commit");
			},
			...databaseStateOptions("reset-state"),
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(events).toEqual(["activate:update"]);

		releaseActivation();
		await Promise.all([activation, reset]);

		expect(events).toEqual([
			"activate:update",
			"activate:commit",
			"reset:update",
			"reset:commit",
		]);
		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.existsSync(path.join(temporaryDirectory, "zt-mkworld"))).toBe(false);
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_LOCK_FILE_NAME))).toBe(
			false,
		);
	});

	function arrangeInterruptedActivation(databaseStateId: string) {
		const previousPlanetName = "planet.previous-interrupted";
		const previousWorldName = "zt-mkworld.previous-interrupted";
		const previousPlanet = path.join(temporaryDirectory, previousPlanetName);
		const previousWorld = path.join(temporaryDirectory, previousWorldName);
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const localConf = path.join(temporaryDirectory, "local.conf");

		fs.renameSync(planetPath, previousPlanet);
		fs.writeFileSync(planetPath, "interrupted-new-planet");
		fs.mkdirSync(previousWorld);
		fs.writeFileSync(path.join(previousWorld, "old-key"), "old-world");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "new-key"), "new-world");
		fs.writeFileSync(localConf, "new-local-conf");
		fs.writeFileSync(
			path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME),
			JSON.stringify({
				version: 1,
				token: "interrupted-token",
				operation: "activate",
				phase: "database_commit_started",
				hadWorldDirectory: true,
				hadPlanet: true,
				stagedWorldName: ".zt-mkworld-generate-interrupted",
				pendingPlanetName: "planet.pending-interrupted",
				previousPlanetName,
				previousWorldName,
				previousLocalConfBase64: Buffer.from("old-local-conf").toString("base64"),
				databaseStateId,
				createdAt: new Date().toISOString(),
			}),
		);
		return { localConf, previousPlanet, previousWorld, worldDirectory };
	}

	it("rolls back an interrupted transaction when the database has the old state", async () => {
		const artifacts = arrangeInterruptedActivation("interrupted-target");
		const updatePorts = jest.fn(async () => undefined);
		const commitDatabase = jest.fn(async () => undefined);

		await expect(
			restoreOriginalPlanet({
				ztFolder: temporaryDirectory,
				updatePorts,
				commitDatabase,
				...databaseStateOptions("next-target", "previous-state"),
			}),
		).rejects.toThrow("No original Planet backup is available.");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.readFileSync(artifacts.localConf, "utf8")).toBe("old-local-conf");
		expect(fs.readFileSync(path.join(artifacts.worldDirectory, "old-key"), "utf8")).toBe(
			"old-world",
		);
		expect(fs.existsSync(artifacts.previousPlanet)).toBe(false);
		expect(fs.existsSync(artifacts.previousWorld)).toBe(false);
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME))).toBe(
			false,
		);
		expect(updatePorts).not.toHaveBeenCalled();
		expect(commitDatabase).not.toHaveBeenCalled();
	});

	it("finishes an interrupted transaction when the database has its target state", async () => {
		const artifacts = arrangeInterruptedActivation("interrupted-target");

		await expect(
			recoverPlanetFileTransaction({
				ztFolder: temporaryDirectory,
				readDatabaseStateId: async () => "interrupted-target",
			}),
		).resolves.toBe("completed");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("interrupted-new-planet");
		expect(fs.readFileSync(artifacts.localConf, "utf8")).toBe("new-local-conf");
		expect(fs.readFileSync(path.join(artifacts.worldDirectory, "new-key"), "utf8")).toBe(
			"new-world",
		);
		expect(fs.existsSync(artifacts.previousPlanet)).toBe(false);
		expect(fs.existsSync(artifacts.previousWorld)).toBe(false);
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME))).toBe(
			false,
		);
	});

	it("retains an interrupted journal when database reconciliation fails", async () => {
		arrangeInterruptedActivation("interrupted-target");

		await expect(
			recoverPlanetFileTransaction({
				ztFolder: temporaryDirectory,
				readDatabaseStateId: async () => {
					throw new Error("database unavailable");
				},
			}),
		).rejects.toThrow("database unavailable");

		expect(fs.readFileSync(planetPath, "utf8")).toBe("interrupted-new-planet");
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_LOCK_FILE_NAME))).toBe(
			false,
		);
	});

	it("snapshots a complete active key pair or preserves a complete imported pair", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-import-signing-keys",
		);
		const importedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-import-preserved-keys",
		);
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "current.c25519"), "active-current");
		fs.writeFileSync(path.join(worldDirectory, "previous.c25519"), "active-previous");
		fs.mkdirSync(stagedDirectory);
		fs.mkdirSync(importedDirectory);
		fs.writeFileSync(path.join(importedDirectory, "current.c25519"), "imported-current");
		fs.writeFileSync(
			path.join(importedDirectory, "previous.c25519"),
			"imported-previous",
		);

		const fsync = jest.spyOn(fs, "fsyncSync");
		try {
			await snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				readDatabaseStateId: async () => "current-state",
			});
			expect(fs.readFileSync(path.join(stagedDirectory, "current.c25519"), "utf8")).toBe(
				"active-current",
			);
			expect(fs.readFileSync(path.join(stagedDirectory, "previous.c25519"), "utf8")).toBe(
				"active-previous",
			);

			await snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: importedDirectory,
				readDatabaseStateId: async () => "current-state",
			});
			expect(
				fs.readFileSync(path.join(importedDirectory, "current.c25519"), "utf8"),
			).toBe("imported-current");
			expect(
				fs.readFileSync(path.join(importedDirectory, "previous.c25519"), "utf8"),
			).toBe("imported-previous");
			expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(6);
		} finally {
			fsync.mockRestore();
		}
	});

	it("rejects partial staged and active signing key pairs", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-import-partial-staged-keys",
		);
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "current.c25519"), "active-current");
		fs.writeFileSync(path.join(worldDirectory, "previous.c25519"), "active-previous");
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "current.c25519"), "imported-current");

		await expect(
			snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				readDatabaseStateId: async () => "current-state",
			}),
		).rejects.toThrow(/both signing keys/i);

		fs.rmSync(stagedDirectory, { recursive: true });
		fs.mkdirSync(stagedDirectory);
		fs.rmSync(path.join(worldDirectory, "previous.c25519"));
		await expect(
			snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				readDatabaseStateId: async () => "current-state",
			}),
		).rejects.toThrow(/both signing keys/i);
	});

	symlinkTest("rejects symbolic-link signing keys", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(temporaryDirectory, ".zt-mkworld-generate-symlink");
		const target = path.join(temporaryDirectory, "signing-target");
		fs.mkdirSync(worldDirectory);
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(target, "secret");
		fs.symlinkSync(target, path.join(worldDirectory, "current.c25519"));

		await expect(
			snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				readDatabaseStateId: async () => "current-state",
			}),
		).rejects.toThrow(/regular file/i);

		fs.rmSync(path.join(worldDirectory, "current.c25519"));
		fs.writeFileSync(path.join(worldDirectory, "current.c25519"), "active-current");
		fs.symlinkSync(target, path.join(stagedDirectory, "previous.c25519"));
		await expect(
			snapshotPlanetSigningKeys({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				readDatabaseStateId: async () => "current-state",
			}),
		).rejects.toThrow(/regular file/i);
	});

	it("waits for activation before snapshotting the committed signing keys", async () => {
		const activationDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-generate-new-signing-keys",
		);
		const snapshotDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-import-waiting-snapshot",
		);
		fs.mkdirSync(activationDirectory);
		fs.writeFileSync(path.join(activationDirectory, "planet.custom"), "new-planet");
		fs.writeFileSync(path.join(activationDirectory, "current.c25519"), "new-current");
		fs.writeFileSync(path.join(activationDirectory, "previous.c25519"), "new-previous");
		fs.mkdirSync(snapshotDirectory);
		let releaseActivation!: () => void;
		let markActivationEntered!: () => void;
		const activationBlocked = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		const activationEntered = new Promise<void>((resolve) => {
			markActivationEntered = resolve;
		});
		const activation = activateWithSigningSnapshot({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: activationDirectory,
			ports: [9993],
			updatePorts: async () => {
				markActivationEntered();
				await activationBlocked;
			},
			commitDatabase: async () => undefined,
			...databaseStateOptions(),
		});
		await activationEntered;

		const snapshot = snapshotPlanetSigningKeys({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: snapshotDirectory,
			readDatabaseStateId: async () => "desired-state",
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(fs.existsSync(path.join(snapshotDirectory, "current.c25519"))).toBe(false);

		releaseActivation();
		await Promise.all([activation, snapshot]);
		expect(fs.readFileSync(path.join(snapshotDirectory, "current.c25519"), "utf8")).toBe(
			"new-current",
		);
		expect(fs.readFileSync(path.join(snapshotDirectory, "previous.c25519"), "utf8")).toBe(
			"new-previous",
		);
	});

	it("rejects activation when active signing keys changed after the snapshot", async () => {
		const worldDirectory = path.join(temporaryDirectory, "zt-mkworld");
		const stagedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-generate-stale-signing-keys",
		);
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "current.c25519"), "old-current");
		fs.writeFileSync(path.join(worldDirectory, "previous.c25519"), "old-previous");
		fs.mkdirSync(stagedDirectory);
		const expectedSigningStateId = await snapshotPlanetSigningKeys({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: stagedDirectory,
			readDatabaseStateId: async () => "previous-state",
		});
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "stale-planet");
		fs.writeFileSync(path.join(worldDirectory, "current.c25519"), "new-current");
		const updatePorts = jest.fn(async () => undefined);
		const commitDatabase = jest.fn(async () => undefined);

		await expect(
			activatePreparedPlanet({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				expectedSigningStateId,
				ports: [9993],
				updatePorts,
				commitDatabase,
				...databaseStateOptions(),
			}),
		).rejects.toThrow(/signing keys changed/i);
		expect(updatePorts).not.toHaveBeenCalled();
		expect(commitDatabase).not.toHaveBeenCalled();
		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.existsSync(path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME))).toBe(
			false,
		);
	});

	it("reclaims a stale cross-process lock before activating", async () => {
		const lockPath = path.join(temporaryDirectory, PLANET_LOCK_FILE_NAME);
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				version: 1,
				token: "stale-token",
				pid: process.pid,
				hostname: `${os.hostname()}-other-host`,
				processStartId: null,
				createdAt: new Date(0).toISOString(),
			}),
		);
		const oldTimestamp = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
		const stagedDirectory = path.join(
			temporaryDirectory,
			".zt-mkworld-generate-after-stale-lock",
		);
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "custom-planet");

		await activateWithSigningSnapshot({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: stagedDirectory,
			ports: [29993],
			updatePorts: async () => undefined,
			commitDatabase: async () => undefined,
			...databaseStateOptions(),
		});

		expect(fs.readFileSync(planetPath, "utf8")).toBe("custom-planet");
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it.each([PLANET_LOCK_FILE_NAME, ".ztnet-planet.lock-gate"])(
		"immediately reclaims a fresh %s owned by a dead local process",
		async (controlFileName) => {
			const controlFilePath = path.join(temporaryDirectory, controlFileName);
			const deadPid = 2_147_483_647;
			try {
				process.kill(deadPid, 0);
				throw new Error(`Test PID ${deadPid} unexpectedly exists.`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			fs.writeFileSync(
				controlFilePath,
				JSON.stringify({
					version: 1,
					token: "dead-owner",
					pid: deadPid,
					hostname: os.hostname(),
					processStartId: "dead-start-id",
					createdAt: new Date().toISOString(),
				}),
			);

			await expect(
				recoverPlanetFileTransaction({
					ztFolder: temporaryDirectory,
					readDatabaseStateId: async () => "current-state",
				}),
			).resolves.toBe("none");
			expect(fs.existsSync(controlFilePath)).toBe(false);
		},
	);

	it.each([PLANET_LOCK_FILE_NAME, ".ztnet-planet.lock-gate"])(
		"immediately reclaims a fresh %s after PID reuse is detected",
		async (controlFileName) => {
			const readFile = mockCurrentProcessStartId("current-start-id");
			const controlFilePath = path.join(temporaryDirectory, controlFileName);
			try {
				fs.writeFileSync(
					controlFilePath,
					JSON.stringify({
						version: 1,
						token: "reused-pid-owner",
						pid: process.pid,
						hostname: os.hostname(),
						processStartId: "previous-start-id",
						createdAt: new Date().toISOString(),
					}),
				);

				await expect(
					recoverPlanetFileTransaction({
						ztFolder: temporaryDirectory,
						readDatabaseStateId: async () => "current-state",
					}),
				).resolves.toBe("none");
				expect(fs.existsSync(controlFilePath)).toBe(false);
			} finally {
				readFile.mockRestore();
			}
		},
	);

	it("never reclaims a confirmed live owner solely by age", async () => {
		const readFile = mockCurrentProcessStartId("live-start-id");
		const lockPath = path.join(temporaryDirectory, PLANET_LOCK_FILE_NAME);
		try {
			fs.writeFileSync(
				lockPath,
				JSON.stringify({
					version: 1,
					token: "live-owner",
					pid: process.pid,
					hostname: os.hostname(),
					processStartId: "live-start-id",
					createdAt: new Date(0).toISOString(),
				}),
			);
			const oldTimestamp = new Date(Date.now() - 10 * 60_000);
			fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
			let completed = false;
			const recovery = recoverPlanetFileTransaction({
				ztFolder: temporaryDirectory,
				readDatabaseStateId: async () => "current-state",
			}).then((result) => {
				completed = true;
				return result;
			});
			await new Promise((resolve) => setTimeout(resolve, 125));
			expect(completed).toBe(false);
			expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("live-owner");

			fs.unlinkSync(lockPath);
			await expect(recovery).resolves.toBe("none");
		} finally {
			readFile.mockRestore();
		}
	});

	it.each([
		["remote", `${os.hostname()}-remote`, null],
		["unknown local", os.hostname(), null],
	] as const)(
		"reclaims a %s owner only after its lease becomes stale",
		async (_label, hostname, ownerStartId) => {
			const lockPath = path.join(temporaryDirectory, PLANET_LOCK_FILE_NAME);
			fs.writeFileSync(
				lockPath,
				JSON.stringify({
					version: 1,
					token: "unknown-owner",
					pid: process.pid,
					hostname,
					processStartId: ownerStartId,
					createdAt: new Date().toISOString(),
				}),
			);
			let completed = false;
			const recovery = recoverPlanetFileTransaction({
				ztFolder: temporaryDirectory,
				readDatabaseStateId: async () => "current-state",
			}).then((result) => {
				completed = true;
				return result;
			});
			await new Promise((resolve) => setTimeout(resolve, 125));
			expect(completed).toBe(false);

			const oldTimestamp = new Date(Date.now() - 10 * 60_000);
			fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
			await expect(recovery).resolves.toBe("none");
		},
	);
});
