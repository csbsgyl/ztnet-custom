import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import {
	createBackupArchive,
	extractBackupArchive,
	getBackupFileName,
	resolveBackupFile,
} from "~/server/backupFiles";

interface ArchiveEntry {
	name: string;
	type?: "file" | "directory" | "symlink";
	data?: string;
	linkname?: string;
}

async function writeArchive(filePath: string, entries: ArchiveEntry[]): Promise<void> {
	const archive = pack();
	const completed = pipeline(archive, createGzip(), fs.createWriteStream(filePath));
	for (const entry of entries) {
		const data = Buffer.from(entry.data || "", "utf8");
		archive.entry(
			{
				name: entry.name,
				type: entry.type || "file",
				size: entry.type && entry.type !== "file" ? 0 : data.length,
				linkname: entry.linkname,
			},
			data,
		);
	}
	archive.finalize();
	await completed;
}

describe("backup archive security", () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ztnet-backup-test-"));
	});

	afterEach(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("creates and restores its own database and ZeroTier archive", async () => {
		const source = path.join(temporaryDirectory, "source");
		const archive = path.join(temporaryDirectory, "backup.tar.gz");
		const restored = path.join(temporaryDirectory, "restored");
		fs.mkdirSync(path.join(source, "zerotier", "networks.d"), { recursive: true });
		fs.writeFileSync(
			path.join(source, "backup_metadata.json"),
			JSON.stringify({ version: "test" }),
		);
		fs.writeFileSync(path.join(source, "database_dump.sql"), "SELECT 1;\n");
		fs.writeFileSync(path.join(source, "zerotier", "identity.secret"), "secret");
		fs.writeFileSync(path.join(source, "zerotier", "networks.d", "network.conf"), "{}");

		await createBackupArchive(source, archive);
		await extractBackupArchive(archive, restored);

		expect(fs.readFileSync(path.join(restored, "database_dump.sql"), "utf8")).toBe(
			"SELECT 1;\n",
		);
		expect(
			fs.readFileSync(path.join(restored, "zerotier", "identity.secret"), "utf8"),
		).toBe("secret");
		expect(fs.statSync(path.join(restored, "backup_metadata.json")).isFile()).toBe(true);
	});

	it.each([
		"../backup",
		"backup/name",
		"backup\\name",
		"backup name",
		"backup;touch-pwned",
	])("rejects an unsafe backup base name: %s", (name) => {
		expect(() => getBackupFileName(name, "fallback")).toThrow();
	});

	it.each(["../backup.tar.gz", "backup.tgz", "/backup.tar.gz", "backup;.tar.gz"])(
		"rejects an unsafe backup filename: %s",
		(fileName) => {
			expect(() => resolveBackupFile(fileName)).toThrow();
		},
	);

	it.each([
		[
			"path traversal",
			[
				{ name: "../outside", data: "owned" },
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "database_dump.sql", data: "SELECT 1;" },
			],
		],
		[
			"absolute path",
			[
				{ name: "/outside", data: "owned" },
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "database_dump.sql", data: "SELECT 1;" },
			],
		],
		[
			"symbolic link",
			[
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "database_dump.sql", data: "SELECT 1;" },
				{ name: "zerotier", type: "directory" },
				{ name: "zerotier/link", type: "symlink", linkname: "/etc/passwd" },
			],
		],
		[
			"duplicate path",
			[
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "database_dump.sql", data: "SELECT 1;" },
			],
		],
		[
			"unknown top-level file",
			[
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "database_dump.sql", data: "SELECT 1;" },
				{ name: "unexpected.txt", data: "owned" },
			],
		],
		[
			"missing ZeroTier root directory entry",
			[
				{ name: "backup_metadata.json", data: "{}" },
				{ name: "zerotier/identity.secret", data: "secret" },
			],
		],
	] as Array<[string, ArchiveEntry[]]>)(
		"rejects an archive with %s",
		async (_name, entries) => {
			const archive = path.join(temporaryDirectory, "malicious.tar.gz");
			const restored = path.join(temporaryDirectory, "restored");
			await writeArchive(archive, entries);

			await expect(extractBackupArchive(archive, restored)).rejects.toThrow();
			expect(fs.existsSync(path.join(temporaryDirectory, "outside"))).toBe(false);
		},
	);
});
