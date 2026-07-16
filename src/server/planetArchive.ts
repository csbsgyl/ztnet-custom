import unzipper from "unzipper";
import { z } from "zod";
import type { WorldConfig } from "~/types/worldConfig";

const MAX_WORLD_ENTRIES = 8;
const MAX_WORLD_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_WORLD_CONFIG_BYTES = 1024 * 1024;
const MAX_WORLD_KEY_BYTES = 1024 * 1024;
const ALLOWED_WORLD_FILES = new Set([
	"mkworld.config.json",
	"current.c25519",
	"previous.c25519",
	"planet.custom",
]);

export const planetEndpointSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.refine((value) => {
		return value.split(",").every((endpoint) => {
			const port = Number(endpoint.trim().split("/").at(-1));
			return Number.isInteger(port) && port >= 1 && port <= 65535;
		});
	}, "Each endpoint must end with /<port>.");

const importedWorldSchema = z.object({
	plID: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
	plBirth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
	plRecommend: z.boolean().default(true),
	rootNodes: z
		.array(
			z.object({
				comments: z.string().trim().max(512).optional(),
				identity: z.string().trim().min(1).max(2048),
				endpoints: z.array(planetEndpointSchema).min(1).max(32),
			}),
		)
		.min(1)
		.max(64),
});

export interface ParsedPlanetArchive {
	config: WorldConfig;
	keyFiles: Map<string, Buffer>;
	ports: number[];
}

export async function parsePlanetArchive(filePath: string): Promise<ParsedPlanetArchive> {
	const directory = await unzipper.Open.file(/* turbopackIgnore: true */ filePath);
	const files = directory.files.filter((entry) => entry.type === "File");
	if (files.length === 0 || files.length > MAX_WORLD_ENTRIES) {
		throw new Error("The Planet archive contains an invalid number of files.");
	}

	const seen = new Set<string>();
	let totalSize = 0;
	for (const file of directory.files) {
		if (file.type !== "File") {
			throw new Error("The Planet archive must contain only flat files.");
		}
		if (
			!ALLOWED_WORLD_FILES.has(file.path) ||
			file.path.includes("/") ||
			file.path.includes("\\") ||
			seen.has(file.path)
		) {
			throw new Error("The Planet archive contains an unexpected or duplicate file.");
		}
		if (!Number.isSafeInteger(file.uncompressedSize) || file.uncompressedSize < 0) {
			throw new Error("The Planet archive contains an invalid file size.");
		}
		totalSize += file.uncompressedSize;
		if (!Number.isSafeInteger(totalSize) || totalSize > MAX_WORLD_UNCOMPRESSED_BYTES) {
			throw new Error("The Planet archive expands beyond the allowed size.");
		}
		seen.add(file.path);
	}

	const configEntry = files.find((file) => file.path === "mkworld.config.json");
	if (!configEntry || configEntry.uncompressedSize > MAX_WORLD_CONFIG_BYTES) {
		throw new Error("The Planet archive is missing a valid mkworld.config.json file.");
	}

	let rawConfig: unknown;
	try {
		rawConfig = JSON.parse((await configEntry.buffer()).toString("utf8"));
	} catch {
		throw new Error("mkworld.config.json is not valid JSON.");
	}
	const parsed = importedWorldSchema.parse(rawConfig);
	if (!parsed.plRecommend && (parsed.plID === 0 || parsed.plBirth === 0)) {
		throw new Error("A custom Planet ID and birth time are required.");
	}

	const config: WorldConfig = {
		rootNodes: parsed.rootNodes.map((node) => ({
			comments: node.comments || "ztnet.network",
			identity: node.identity,
			endpoints: node.endpoints,
		})),
		signing: ["previous.c25519", "current.c25519"],
		output: "planet.custom",
		plID: parsed.plID,
		plBirth: parsed.plBirth,
		plRecommend: parsed.plRecommend,
	};

	const keyFiles = new Map<string, Buffer>();
	for (const name of ["current.c25519", "previous.c25519"] as const) {
		const entry = files.find((file) => file.path === name);
		if (!entry) continue;
		if (entry.uncompressedSize === 0 || entry.uncompressedSize > MAX_WORLD_KEY_BYTES) {
			throw new Error(`The ${name} signing key is invalid.`);
		}
		keyFiles.set(name, await entry.buffer());
	}

	const ports = [
		...new Set(
			config.rootNodes[0].endpoints[0]
				.split(",")
				.map((endpoint) => Number(endpoint.trim().split("/").at(-1))),
		),
	].slice(0, 2);

	return { config, keyFiles, ports };
}
