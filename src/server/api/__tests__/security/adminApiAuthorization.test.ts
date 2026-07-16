jest.mock("~/lib/auth", () => ({
	auth: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({
	fromNodeHeaders: jest.fn((headers) => headers),
}));
jest.mock("~/server/db", () => ({
	prisma: { user: { findUnique: jest.fn() } },
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { auth } from "~/lib/auth";
import { requireAdministrator } from "~/server/api/auth/adminApi";
import { prisma } from "~/server/db";

const getSession = auth.api.getSession as unknown as jest.Mock;
const findUser = prisma.user.findUnique as unknown as jest.Mock;

function createResponse() {
	const status = jest.fn();
	const json = jest.fn();
	const response = { status, json };
	status.mockReturnValue(response);
	json.mockReturnValue(response);
	return { response: response as unknown as NextApiResponse, status, json };
}

describe("administrator Pages API authorization", () => {
	const request = { headers: { cookie: "session=test" } } as NextApiRequest;

	beforeEach(() => {
		getSession.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
		findUser.mockResolvedValue({
			role: "ADMIN",
			isActive: true,
			suspensionReason: "NONE",
			expiresAt: null,
		});
	});

	it("returns 401 without a session", async () => {
		getSession.mockResolvedValue(null);
		const { response, status } = createResponse();

		await expect(requireAdministrator(request, response)).resolves.toBe(false);
		expect(status).toHaveBeenCalledWith(401);
		expect(findUser).not.toHaveBeenCalled();
	});

	it("rejects a normal user", async () => {
		getSession.mockResolvedValue({ user: { id: "user-1", role: "USER" } });
		findUser.mockResolvedValue({
			role: "USER",
			isActive: true,
			suspensionReason: "NONE",
			expiresAt: null,
		});
		const { response, status } = createResponse();

		await expect(requireAdministrator(request, response)).resolves.toBe(false);
		expect(status).toHaveBeenCalledWith(403);
	});

	it("rejects a stale administrator session after database demotion", async () => {
		findUser.mockResolvedValue({
			role: "USER",
			isActive: true,
			suspensionReason: "NONE",
			expiresAt: null,
		});
		const { response, status } = createResponse();

		await expect(requireAdministrator(request, response)).resolves.toBe(false);
		expect(status).toHaveBeenCalledWith(403);
	});

	it("allows a current administrator", async () => {
		const { response, status } = createResponse();

		await expect(requireAdministrator(request, response)).resolves.toBe(true);
		expect(status).not.toHaveBeenCalled();
	});
});
