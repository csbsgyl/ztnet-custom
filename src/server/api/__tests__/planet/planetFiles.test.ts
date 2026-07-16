import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	activatePreparedPlanet,
	ensureOriginalPlanetBackup,
	getLatestOriginalPlanetBackup,
	listOriginalPlanetBackups,
	readOptionalRegularFile,
	restoreOriginalPlanet,
	restoreFileSnapshot,
} from "~/server/planetFiles";

describe("Planet lifecycle files", () => {
	let temporaryDirectory: string;
	let backupDirectory: string;
	let planetPath: string;

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
		const stagedDirectory = path.join(temporaryDirectory, ".staged-world");
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
			activatePreparedPlanet({
				ztFolder: temporaryDirectory,
				stagedWorldDirectory: stagedDirectory,
				ports: [9993, 29993],
				updatePorts,
				commitDatabase,
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
		const stagedDirectory = path.join(temporaryDirectory, ".staged-world");
		fs.mkdirSync(worldDirectory);
		fs.writeFileSync(path.join(worldDirectory, "old-key"), "old-world");
		fs.mkdirSync(stagedDirectory);
		fs.writeFileSync(path.join(stagedDirectory, "planet.custom"), "custom-planet");
		const commitDatabase = jest.fn(async () => undefined);

		await activatePreparedPlanet({
			ztFolder: temporaryDirectory,
			stagedWorldDirectory: stagedDirectory,
			ports: [29993],
			updatePorts: async () => undefined,
			commitDatabase,
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
		});

		expect(fs.readFileSync(planetPath, "utf8")).toBe("official-planet");
		expect(fs.existsSync(worldDirectory)).toBe(false);
		expect(fs.existsSync(backup)).toBe(true);
		expect(commitDatabase).toHaveBeenCalledTimes(1);
	});
});
