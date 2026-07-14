jest.mock("~/lib/authSession", () => ({ getServerAuthSession: jest.fn() }));
jest.mock("~/server/db", () => ({ prisma: {} }));

import type { Session } from "~/lib/authTypes";
import {
	adminRoleProtectedRoute,
	createTRPCRouter,
	protectedProcedure,
} from "~/server/api/trpc";

const router = createTRPCRouter({
	protectedProbe: protectedProcedure.query(({ ctx }) => ({
		id: ctx.session.user.id,
		role: ctx.session.user.role,
	})),
	adminProbe: adminRoleProtectedRoute.query(({ ctx }) => ctx.session.user.role),
});

const activeAccount = {
	id: "user-1",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

function session(role = "USER"): Session {
	return {
		expires: "2099-01-01T00:00:00.000Z",
		user: { id: "user-1", role } as Session["user"],
	};
}

function callerFor(account: typeof activeAccount | null, sessionRole = "USER") {
	return router.createCaller({
		session: session(sessionRole),
		prisma: {
			user: { findUnique: jest.fn().mockResolvedValue(account) },
		},
		wss: null,
		res: null,
		req: null,
	} as never);
}

describe("protected tRPC account boundary", () => {
	it.each([
		["isActive=false", { isActive: false }],
		["subscription expiration marker", { suspensionReason: "SUBSCRIPTION_EXPIRED" }],
		["elapsed expiresAt", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
	])("rejects a non-admin with %s", async (_name, overrides) => {
		const caller = callerFor({ ...activeAccount, ...overrides });

		await expect(caller.protectedProbe()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("uses current database state instead of a stale administrator session", async () => {
		const caller = callerFor({ ...activeAccount, isActive: false }, "ADMIN");

		await expect(caller.protectedProbe()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(caller.adminProbe()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps the existing session role guard on administrator procedures", async () => {
		const caller = callerFor({ ...activeAccount, role: "ADMIN" }, "USER");

		await expect(caller.adminProbe()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a session whose account no longer exists", async () => {
		await expect(callerFor(null).protectedProbe()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("allows an administrator regardless of suspension fields", async () => {
		const adminAccount = {
			...activeAccount,
			role: "ADMIN",
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
			expiresAt: new Date("2020-01-01T00:00:00.000Z"),
		};

		await expect(callerFor(adminAccount).protectedProbe()).resolves.toEqual({
			id: "user-1",
			role: "ADMIN",
		});
		await expect(callerFor(adminAccount, "ADMIN").adminProbe()).resolves.toBe("ADMIN");
	});
});
