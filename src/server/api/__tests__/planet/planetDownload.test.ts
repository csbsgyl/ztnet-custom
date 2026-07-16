jest.mock("node:fs", () => ({
	promises: { readFile: jest.fn() },
}));
jest.mock("~/lib/auth", () => ({
	auth: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({
	fromNodeHeaders: jest.fn((headers) => headers),
}));
jest.mock("~/server/db", () => ({
	prisma: {
		user: { findUnique: jest.fn() },
		globalOptions: { findUnique: jest.fn() },
	},
}));
jest.mock("~/utils/ztApi", () => ({
	ZT_FOLDER: "/var/lib/zerotier-one",
}));

import { promises as fs } from "node:fs";
import type { NextApiRequest, NextApiResponse } from "next";
import { auth } from "~/lib/auth";
import planetDownload from "~/pages/api/planet";
import { prisma } from "~/server/db";

const mockPrisma = prisma as unknown as {
	user: { findUnique: jest.Mock };
	globalOptions: { findUnique: jest.Mock };
};
const getSession = auth.api.getSession as unknown as jest.Mock;
const readFile = fs.readFile as jest.Mock;

const activeAccount = {
	id: "user-1",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

function createRequest(method = "GET") {
	return { method, headers: { cookie: "session=test" } } as NextApiRequest;
}

function createResponse() {
	const setHeader = jest.fn();
	const status = jest.fn();
	const send = jest.fn();
	const response = { setHeader, status, send };
	status.mockReturnValue(response);
	send.mockReturnValue(response);
	return {
		response: response as unknown as NextApiResponse,
		mocks: { setHeader, status, send },
	};
}

describe("Planet download API", () => {
	beforeEach(() => {
		getSession.mockResolvedValue({ user: { id: "user-1" } });
		mockPrisma.user.findUnique.mockResolvedValue(activeAccount);
		mockPrisma.globalOptions.findUnique.mockResolvedValue({ customPlanetUsed: true });
		readFile.mockResolvedValue(Buffer.from([0x7f, 0x50, 0x4c, 0x41, 0x4e, 0x45, 0x54]));
	});

	it("rejects methods other than GET", async () => {
		const { response, mocks } = createResponse();

		await planetDownload(createRequest("POST"), response);

		expect(mocks.setHeader).toHaveBeenCalledWith("Allow", "GET");
		expect(mocks.status).toHaveBeenCalledWith(405);
		expect(getSession).not.toHaveBeenCalled();
	});

	it("requires an authenticated session", async () => {
		getSession.mockResolvedValue(null);
		const { response, mocks } = createResponse();

		await planetDownload(createRequest(), response);

		expect(mocks.status).toHaveBeenCalledWith(401);
		expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("rejects an inactive or expired account", async () => {
		mockPrisma.user.findUnique.mockResolvedValue({ ...activeAccount, isActive: false });
		const { response, mocks } = createResponse();

		await planetDownload(createRequest(), response);

		expect(mocks.status).toHaveBeenCalledWith(403);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns 404 while a custom Planet is not enabled", async () => {
		mockPrisma.globalOptions.findUnique.mockResolvedValue({ customPlanetUsed: false });
		const { response, mocks } = createResponse();

		await planetDownload(createRequest(), response);

		expect(mocks.status).toHaveBeenCalledWith(404);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns 404 when the active file does not exist", async () => {
		readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		const { response, mocks } = createResponse();

		await planetDownload(createRequest(), response);

		expect(mocks.status).toHaveBeenCalledWith(404);
	});

	it("returns the active binary file with the exact planet filename", async () => {
		const planet = Buffer.from([0x01, 0x00, 0xff, 0x7a]);
		readFile.mockResolvedValue(planet);
		const { response, mocks } = createResponse();

		await planetDownload(createRequest(), response);

		expect(readFile).toHaveBeenCalledWith(
			expect.stringMatching(/[\\/]var[\\/]lib[\\/]zerotier-one[\\/]planet$/),
		);
		expect(mocks.setHeader).toHaveBeenCalledWith(
			"Content-Disposition",
			'attachment; filename="planet"',
		);
		expect(mocks.setHeader).toHaveBeenCalledWith(
			"Content-Type",
			"application/octet-stream",
		);
		expect(mocks.setHeader).toHaveBeenCalledWith("Content-Length", "4");
		expect(mocks.setHeader).toHaveBeenCalledWith(
			"Cache-Control",
			"private, no-store, max-age=0",
		);
		expect(mocks.status).toHaveBeenCalledWith(200);
		expect(mocks.send).toHaveBeenCalledWith(planet);
	});
});
