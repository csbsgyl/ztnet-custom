import {
	runApiTokenStartupMigration,
	type ApiTokenStartupMigrationDependencies,
} from "~/instrumentation";

function dependencies(
	overrides: Partial<ApiTokenStartupMigrationDependencies> = {},
): ApiTokenStartupMigrationDependencies {
	return {
		enabled: true,
		migrate: jest.fn().mockResolvedValue(0),
		wait: jest.fn().mockResolvedValue(undefined),
		retryDelaysMs: [5, 10, 20, 40],
		...overrides,
	};
}

describe("required API token startup migration", () => {
	it("does not query the database outside production startup", async () => {
		const input = dependencies({ enabled: false });

		await expect(runApiTokenStartupMigration(input)).resolves.toEqual({
			status: "skipped",
			migrated: 0,
		});
		expect(input.migrate).not.toHaveBeenCalled();
		expect(input.wait).not.toHaveBeenCalled();
	});

	it("continues immediately when no legacy tokens exist", async () => {
		const input = dependencies();

		await expect(runApiTokenStartupMigration(input)).resolves.toEqual({
			status: "completed",
			migrated: 0,
		});
		expect(input.migrate).toHaveBeenCalledTimes(1);
		expect(input.wait).not.toHaveBeenCalled();
	});

	it("retries a transient database failure before completing", async () => {
		const input = dependencies({
			migrate: jest
				.fn()
				.mockRejectedValueOnce(new Error("database is starting"))
				.mockResolvedValueOnce(3),
		});

		await expect(runApiTokenStartupMigration(input)).resolves.toEqual({
			status: "completed",
			migrated: 3,
		});
		expect(input.migrate).toHaveBeenCalledTimes(2);
		expect(input.wait).toHaveBeenCalledWith(5);
	});

	it("fails closed after the configured finite attempt count", async () => {
		const input = dependencies({
			migrate: jest.fn().mockRejectedValue(new Error("database unavailable")),
		});

		await expect(runApiTokenStartupMigration(input)).rejects.toThrow(
			"API token digest startup migration failed after 5 attempts.",
		);
		expect(input.migrate).toHaveBeenCalledTimes(5);
		expect(input.wait).toHaveBeenCalledTimes(4);
	});
});
