import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	clearPlanetRestartRequired,
	inspectPlanetStartupState,
	markPlanetRestartRequired,
	PLANET_RESTART_REQUIRED_FILE_NAME,
	runPlanetStartupRecovery,
	type PlanetStartupRecoveryDependencies,
} from "~/server/planetStartupRecovery";
import { PLANET_JOURNAL_FILE_NAME } from "~/server/planetFiles";

function dependencies(
	overrides: Partial<PlanetStartupRecoveryDependencies> = {},
): PlanetStartupRecoveryDependencies {
	return {
		enabled: true,
		inspectState: jest.fn().mockResolvedValue({
			journalPresent: true,
			restartRequired: false,
		}),
		markRestartRequired: jest.fn().mockResolvedValue(undefined),
		recover: jest.fn().mockResolvedValue("completed"),
		restart: jest.fn().mockResolvedValue(undefined),
		clearRestartRequired: jest.fn().mockResolvedValue(undefined),
		wait: jest.fn().mockResolvedValue(undefined),
		recoveryRetryDelaysMs: [5, 10],
		restartRetryDelaysMs: [20, 40],
		...overrides,
	};
}

describe("Planet startup recovery", () => {
	it("does nothing when startup recovery is disabled", async () => {
		const input = dependencies({ enabled: false });

		await expect(runPlanetStartupRecovery(input)).resolves.toEqual({
			status: "skipped",
			recoveryResult: "none",
		});

		expect(input.inspectState).not.toHaveBeenCalled();
		expect(input.recover).not.toHaveBeenCalled();
		expect(input.restart).not.toHaveBeenCalled();
	});

	it("does not load recovery dependencies when no durable state exists", async () => {
		const input = dependencies({
			inspectState: jest.fn().mockResolvedValue({
				journalPresent: false,
				restartRequired: false,
			}),
		});

		await expect(runPlanetStartupRecovery(input)).resolves.toEqual({
			status: "none",
			recoveryResult: "none",
		});
		expect(input.markRestartRequired).not.toHaveBeenCalled();
		expect(input.recover).not.toHaveBeenCalled();
		expect(input.restart).not.toHaveBeenCalled();
	});

	it("marks before recovery, retries recovery, then restarts and clears", async () => {
		const events: string[] = [];
		const input = dependencies({
			markRestartRequired: jest.fn(async () => {
				events.push("mark");
			}),
			recover: jest
				.fn()
				.mockImplementationOnce(async () => {
					events.push("recover-1");
					throw new Error("database is starting");
				})
				.mockImplementationOnce(async () => {
					events.push("recover-2");
					return "rolled_back";
				}),
			wait: jest.fn(async (milliseconds: number) => {
				events.push(`wait-${milliseconds}`);
			}),
			restart: jest.fn(async () => {
				events.push("restart");
			}),
			clearRestartRequired: jest.fn(async () => {
				events.push("clear");
			}),
		});

		await expect(runPlanetStartupRecovery(input)).resolves.toEqual({
			status: "restarted",
			recoveryResult: "rolled_back",
		});
		expect(events).toEqual([
			"mark",
			"recover-1",
			"wait-5",
			"recover-2",
			"restart",
			"clear",
		]);
	});

	it("retries restart when the helper becomes reachable later", async () => {
		const input = dependencies({
			restart: jest
				.fn()
				.mockRejectedValueOnce(new Error("helper unavailable"))
				.mockResolvedValueOnce(undefined),
		});

		await expect(runPlanetStartupRecovery(input)).resolves.toMatchObject({
			status: "restarted",
		});
		expect(input.restart).toHaveBeenCalledTimes(2);
		expect(input.wait).toHaveBeenCalledWith(20);
		expect(input.clearRestartRequired).toHaveBeenCalledTimes(1);
	});

	it("restarts from a marker without querying recovery state", async () => {
		const input = dependencies({
			inspectState: jest.fn().mockResolvedValue({
				journalPresent: false,
				restartRequired: true,
			}),
		});

		await expect(runPlanetStartupRecovery(input)).resolves.toEqual({
			status: "restarted",
			recoveryResult: "none",
		});
		expect(input.markRestartRequired).not.toHaveBeenCalled();
		expect(input.recover).not.toHaveBeenCalled();
		expect(input.restart).toHaveBeenCalledTimes(1);
		expect(input.clearRestartRequired).toHaveBeenCalledTimes(1);
	});

	it("fails closed after finite recovery attempts and retains restart state", async () => {
		const input = dependencies({
			recover: jest.fn().mockRejectedValue(new Error("database unavailable")),
		});

		await expect(runPlanetStartupRecovery(input)).rejects.toThrow(
			"Planet startup recovery failed after 3 attempts.",
		);
		expect(input.recover).toHaveBeenCalledTimes(3);
		expect(input.wait).toHaveBeenNthCalledWith(1, 5);
		expect(input.wait).toHaveBeenNthCalledWith(2, 10);
		expect(input.restart).not.toHaveBeenCalled();
		expect(input.clearRestartRequired).not.toHaveBeenCalled();
	});

	it("fails closed after finite restart attempts and does not clear the marker", async () => {
		const input = dependencies({
			restart: jest.fn().mockRejectedValue(new Error("helper unavailable")),
		});

		await expect(runPlanetStartupRecovery(input)).rejects.toThrow(
			"Planet startup restart failed after 3 attempts.",
		);
		expect(input.restart).toHaveBeenCalledTimes(3);
		expect(input.clearRestartRequired).not.toHaveBeenCalled();
	});
});

describe("Planet startup recovery files", () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ztnet-planet-startup-"));
	});

	afterEach(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("persists and clears the restart marker around a real journal", async () => {
		fs.writeFileSync(path.join(temporaryDirectory, PLANET_JOURNAL_FILE_NAME), "{}");

		await expect(inspectPlanetStartupState(temporaryDirectory)).resolves.toEqual({
			journalPresent: true,
			restartRequired: false,
		});
		await markPlanetRestartRequired(temporaryDirectory);
		await expect(inspectPlanetStartupState(temporaryDirectory)).resolves.toEqual({
			journalPresent: true,
			restartRequired: true,
		});
		await clearPlanetRestartRequired(temporaryDirectory);
		expect(
			fs.existsSync(path.join(temporaryDirectory, PLANET_RESTART_REQUIRED_FILE_NAME)),
		).toBe(false);
	});

	it("rejects an invalid restart marker instead of silently clearing it", async () => {
		fs.symlinkSync(
			path.join(temporaryDirectory, "target"),
			path.join(temporaryDirectory, PLANET_RESTART_REQUIRED_FILE_NAME),
		);

		await expect(inspectPlanetStartupState(temporaryDirectory)).rejects.toThrow(
			"restart-required marker is invalid",
		);
	});
});
