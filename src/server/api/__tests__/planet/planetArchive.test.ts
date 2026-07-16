import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import { parsePlanetArchive } from "~/server/planetArchive";

interface ZipEntry {
	name: string;
	data?: string | Buffer;
	directory?: boolean;
}

async function writeZip(filePath: string, entries: ZipEntry[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(filePath);
		const archive = archiver("zip", { zlib: { level: 1 } });
		output.once("close", resolve);
		output.once("error", reject);
		archive.once("error", reject);
		archive.pipe(output);
		for (const entry of entries) {
			if (entry.directory)
				archive.append("", {
					name: entry.name.endsWith("/") ? entry.name : `${entry.name}/`,
				});
			else archive.append(entry.data || "", { name: entry.name });
		}
		void archive.finalize();
	});
}

function config(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		plID: 123,
		plBirth: 456,
		plRecommend: false,
		rootNodes: [
			{
				comments: "Primary root",
				identity: "abcdef:identity",
				endpoints: ["203.0.113.10/9993,203.0.113.10/29993"],
			},
		],
		...overrides,
	});
}

describe("Planet import archive", () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ztnet-planet-test-"));
	});

	afterEach(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("parses a valid flat archive and ignores the supplied generated Planet", async () => {
		const archivePath = path.join(temporaryDirectory, "world.zip");
		await writeZip(archivePath, [
			{ name: "mkworld.config.json", data: config() },
			{ name: "current.c25519", data: "current-key" },
			{ name: "previous.c25519", data: "previous-key" },
			{ name: "planet.custom", data: "untrusted-generated-file" },
		]);

		const result = await parsePlanetArchive(archivePath);

		expect(result.config).toMatchObject({
			plID: 123,
			plBirth: 456,
			plRecommend: false,
			output: "planet.custom",
			signing: ["previous.c25519", "current.c25519"],
		});
		expect(result.ports).toEqual([9993, 29993]);
		expect(result.keyFiles.get("current.c25519")?.toString()).toBe("current-key");
		expect(result.keyFiles.has("planet.custom")).toBe(false);
	});

	it.each([
		["nested path", [{ name: "nested/mkworld.config.json", data: config() }]],
		[
			"directory entry",
			[
				{ name: "nested", directory: true },
				{ name: "mkworld.config.json", data: config() },
			],
		],
		[
			"duplicate file",
			[
				{ name: "mkworld.config.json", data: config() },
				{ name: "mkworld.config.json", data: config() },
			],
		],
		[
			"unknown file",
			[
				{ name: "mkworld.config.json", data: config() },
				{ name: "identity.secret", data: "secret" },
			],
		],
	] as Array<[string, ZipEntry[]]>)("rejects a ZIP with %s", async (_name, entries) => {
		const archivePath = path.join(temporaryDirectory, "invalid.zip");
		await writeZip(archivePath, entries);

		await expect(parsePlanetArchive(archivePath)).rejects.toThrow();
	});

	it("rejects an invalid endpoint port", async () => {
		const archivePath = path.join(temporaryDirectory, "invalid-port.zip");
		await writeZip(archivePath, [
			{
				name: "mkworld.config.json",
				data: config({
					rootNodes: [{ identity: "abc", endpoints: ["203.0.113.10/not-a-port"] }],
				}),
			},
		]);

		await expect(parsePlanetArchive(archivePath)).rejects.toThrow();
	});

	it("rejects a ZIP bomb by advertised uncompressed size", async () => {
		const archivePath = path.join(temporaryDirectory, "oversized.zip");
		await writeZip(archivePath, [
			{ name: "mkworld.config.json", data: config() },
			{ name: "planet.custom", data: Buffer.alloc(20 * 1024 * 1024, 0) },
		]);

		await expect(parsePlanetArchive(archivePath)).rejects.toThrow(
			/expands beyond the allowed size/i,
		);
	});
});
