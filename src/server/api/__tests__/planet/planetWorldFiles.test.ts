import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPlanetWorldDownloadEntries } from "~/server/planetWorldFiles";

describe("Planet world download files", () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ztnet-world-files-"));
		fs.writeFileSync(
			path.join(temporaryDirectory, "mkworld.config.json"),
			'{"rootNodes":[]}',
		);
	});

	afterEach(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("returns only the fixed allowlist and excludes unrelated secrets", () => {
		fs.writeFileSync(path.join(temporaryDirectory, "current.c25519"), "current-key");
		fs.writeFileSync(path.join(temporaryDirectory, "planet.custom"), "planet-data");
		fs.writeFileSync(path.join(temporaryDirectory, "identity.secret"), "must-not-leak");
		fs.writeFileSync(path.join(temporaryDirectory, ".env"), "TOKEN=must-not-leak");

		const entries = readPlanetWorldDownloadEntries(temporaryDirectory);

		expect(entries.map((entry) => entry.name)).toEqual([
			"mkworld.config.json",
			"current.c25519",
			"planet.custom",
		]);
		expect(Buffer.concat(entries.map((entry) => entry.data)).toString()).not.toContain(
			"must-not-leak",
		);
	});

	it("requires the configuration file", () => {
		fs.rmSync(path.join(temporaryDirectory, "mkworld.config.json"));
		expect(() => readPlanetWorldDownloadEntries(temporaryDirectory)).toThrow(
			/mkworld\.config\.json was not found/i,
		);
	});

	const symlinkTest = process.platform === "win32" ? it.skip : it;

	symlinkTest("rejects allowlisted symbolic links", () => {
		const target = path.join(temporaryDirectory, "outside-key");
		fs.writeFileSync(target, "secret");
		fs.symlinkSync(target, path.join(temporaryDirectory, "current.c25519"));

		expect(() => readPlanetWorldDownloadEntries(temporaryDirectory)).toThrow(
			/regular file/i,
		);
	});

	symlinkTest("rejects a symbolic-link configuration directory", () => {
		const link = `${temporaryDirectory}-link`;
		fs.symlinkSync(temporaryDirectory, link, "dir");
		try {
			expect(() => readPlanetWorldDownloadEntries(link)).toThrow(/folder was not found/i);
		} finally {
			fs.rmSync(link, { force: true });
		}
	});
});
