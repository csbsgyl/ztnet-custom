jest.mock("~/lib/authSession", () => ({ getServerAuthSession: jest.fn() }));
jest.mock("~/server/db", () => ({
	prisma: { user: { findUnique: jest.fn() } },
}));

import type { GetServerSidePropsContext } from "next";
import { withAuth } from "~/components/auth/withAuth";
import { getServerAuthSession } from "~/lib/authSession";
import { prisma } from "~/server/db";

const getSession = getServerAuthSession as jest.Mock;
const userLookup = prisma.user.findUnique as jest.Mock;
const context = {
	req: { headers: {} },
	res: {},
	locale: "en",
} as GetServerSidePropsContext;

const activeAccount = {
	id: "user-1",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

describe("withAuth account boundary", () => {
	const gssp = jest.fn().mockResolvedValue({ props: { page: "protected" } });

	beforeEach(() => {
		getSession.mockResolvedValue({
			expires: "2099-01-01T00:00:00.000Z",
			user: { id: "user-1", role: "USER", name: "Session Name" },
		});
	});

	it("redirects an unauthenticated request before loading account data", async () => {
		getSession.mockResolvedValue(null);

		await expect(withAuth(gssp)(context)).resolves.toEqual({
			redirect: { statusCode: 302, destination: "/auth/login" },
		});
		expect(userLookup).not.toHaveBeenCalled();
		expect(gssp).not.toHaveBeenCalled();
	});

	it.each([
		["isActive=false", { isActive: false }],
		["subscription expiration marker", { suspensionReason: "SUBSCRIPTION_EXPIRED" }],
		["elapsed expiresAt", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
	])("does not render a non-admin page with %s", async (_name, overrides) => {
		userLookup.mockResolvedValue({ ...activeAccount, ...overrides });

		await expect(withAuth(gssp)(context)).resolves.toEqual({ notFound: true });
		expect(gssp).not.toHaveBeenCalled();
	});

	it("uses the fresh account record and allows an administrator", async () => {
		userLookup.mockResolvedValue({
			...activeAccount,
			role: "ADMIN",
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
			expiresAt: new Date("2020-01-01T00:00:00.000Z"),
		});

		await expect(withAuth(gssp)(context)).resolves.toEqual({
			props: {
				page: "protected",
				user: expect.objectContaining({ id: "user-1", role: "ADMIN" }),
			},
		});
		expect(gssp).toHaveBeenCalledTimes(1);
	});
});
