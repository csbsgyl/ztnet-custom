import type { NextApiRequest, NextApiResponse } from "next";
import createUserHandler from "~/pages/api/v1/user";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { prisma } from "~/server/db";
import { AuthorizationType } from "~/types/apiTypes";
import {
	API_TOKEN_SECRET,
	decryptAndVerifyToken,
	encrypt,
	generateInstanceSecret,
	hashApiToken,
} from "~/utils/encryption";

jest.mock("~/server/api/root", () => ({
	appRouter: { createCaller: jest.fn() },
}));

jest.mock("~/utils/rateLimit", () => ({
	__esModule: true,
	default: () => ({ check: jest.fn().mockResolvedValue(undefined) }),
	RATE_LIMIT_CONFIG: {
		API_WINDOW_MS: 60 * 1000,
		API_MAX_REQUESTS: 50,
	},
}));

jest.mock("~/server/api/trpc", () => ({
	createTRPCContext: jest.fn(),
}));

jest.mock("~/server/db", () => ({
	prisma: {
		$executeRaw: jest.fn(),
		$transaction: jest.fn(),
		user: {
			count: jest.fn(),
			findUnique: jest.fn(),
		},
		aPIToken: {
			findUnique: jest.fn(),
			update: jest.fn(),
		},
	},
}));

const createCaller = appRouter.createCaller as jest.Mock;
const createContext = createTRPCContext as jest.Mock;

const registeredUser = {
	id: "new-user-id",
	name: "ZTNET User",
	email: "user@example.com",
	role: "USER",
	expiresAt: null,
	memberOfOrgs: [],
};

function response(): NextApiResponse {
	return {
		status: jest.fn().mockReturnThis(),
		json: jest.fn().mockReturnThis(),
		end: jest.fn(),
		setHeader: jest.fn(),
	} as unknown as NextApiResponse;
}

function request(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
	return {
		method: "POST",
		headers: {},
		query: {},
		body: {
			email: "user@example.com",
			password: "StrongPass123!",
			name: "ZTNET User",
		},
		...overrides,
	} as unknown as NextApiRequest;
}

function validApiKey(client: typeof prisma = prisma): string {
	const apiKey = encrypt(
		JSON.stringify({
			userId: "admin-id",
			tokenId: "token-id",
			apiAuthorizationType: [AuthorizationType.PERSONAL],
		}),
		generateInstanceSecret(API_TOKEN_SECRET),
	);
	(client.aPIToken.findUnique as jest.Mock).mockResolvedValue({
		token: hashApiToken(apiKey),
		isActive: true,
		expiresAt: new Date(Date.now() + 60_000),
	});
	(client.user.findUnique as jest.Mock).mockResolvedValue({
		id: "admin-id",
		role: "ADMIN",
		isActive: true,
		suspensionReason: "NONE",
		expiresAt: null,
	});
	return apiKey;
}

describe("createUserHandler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(prisma.$executeRaw as jest.Mock).mockResolvedValue(0);
		(prisma.$transaction as jest.Mock).mockImplementation(
			async (operation: (transaction: typeof prisma) => unknown) => operation(prisma),
		);
		(prisma.user.count as jest.Mock).mockResolvedValue(0);
		createContext.mockResolvedValue({
			session: null,
			wss: null,
			prisma,
		});
		createCaller.mockReturnValue({
			auth: {
				register: jest.fn().mockResolvedValue({ user: registeredUser }),
				addApiToken: jest.fn().mockResolvedValue({ token: "one-time-bearer" }),
			},
		});
	});

	it("rejects mismatched API authorization types", async () => {
		const apiKey = encrypt(
			JSON.stringify({
				userId: "admin-id",
				tokenId: "token-id",
				apiAuthorizationType: [AuthorizationType.ORGANIZATION],
			}),
			generateInstanceSecret(API_TOKEN_SECRET),
		);

		await expect(
			decryptAndVerifyToken({
				apiKey,
				requireAdmin: false,
				apiAuthorizationType: AuthorizationType.PERSONAL,
			}),
		).rejects.toThrow("Invalid Authorization Type");
	});

	it("creates the first user without an API token after acquiring the registration lock", async () => {
		const req = request();
		const res = response();

		await createUserHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			user: registeredUser,
			apiToken: undefined,
		});
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
		expect(prisma.aPIToken.findUnique).not.toHaveBeenCalled();
		expect((prisma.$executeRaw as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
			(prisma.user.count as jest.Mock).mock.invocationCallOrder[0],
		);
	});

	it("authenticates an existing-user request inside the locked transaction", async () => {
		const transactionPrisma = {
			...prisma,
			$executeRaw: jest.fn().mockResolvedValue(0),
			user: {
				...prisma.user,
				count: jest.fn().mockResolvedValue(10),
				findUnique: jest.fn(),
			},
			aPIToken: {
				...prisma.aPIToken,
				findUnique: jest.fn(),
				update: jest.fn(),
			},
		} as unknown as typeof prisma;
		(prisma.$transaction as jest.Mock).mockImplementation(
			async (operation: (transaction: typeof prisma) => unknown) =>
				operation(transactionPrisma),
		);
		const apiKey = validApiKey(transactionPrisma);
		const req = request({ headers: { "x-ztnet-auth": apiKey } });
		const res = response();

		await createUserHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(transactionPrisma.aPIToken.findUnique).toHaveBeenCalledTimes(1);
		expect(transactionPrisma.user.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "admin-id" } }),
		);
		expect(prisma.aPIToken.findUnique).not.toHaveBeenCalled();
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
		expect(
			(transactionPrisma.$executeRaw as jest.Mock).mock.invocationCallOrder[0],
		).toBeLessThan(
			(transactionPrisma.user.count as jest.Mock).mock.invocationCallOrder[0],
		);
	});

	it("returns 401 before registration when an existing-user API token is invalid", async () => {
		(prisma.user.count as jest.Mock).mockResolvedValue(1);
		const req = request({ headers: { "x-ztnet-auth": "invalid-api-key" } });
		const res = response();

		await createUserHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.json).toHaveBeenCalledWith({ error: "Invalid token" });
		expect(createCaller).not.toHaveBeenCalled();
	});

	it("keeps expiresAt forbidden for the first administrator", async () => {
		const req = request({
			body: {
				email: "user@example.com",
				password: "StrongPass123!",
				name: "ZTNET User",
				expiresAt: "2027-01-01T00:00:00.000Z",
			},
		});
		const res = response();

		await createUserHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: "Cannot add expiresAt for Admin user!",
		});
	});

	it("returns a generated API token to the caller", async () => {
		const req = request({
			body: {
				email: "user@example.com",
				password: "StrongPass123!",
				name: "ZTNET User",
				generateApiToken: true,
			},
		});
		const res = response();

		await createUserHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			user: registeredUser,
			apiToken: "one-time-bearer",
		});
	});

	it("allows only POST", async () => {
		for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
			const res = response();
			await createUserHandler(request({ method }), res);
			expect(res.status).toHaveBeenCalledWith(405);
			expect(res.json).toHaveBeenCalledWith({ error: "Method Not Allowed" });
		}
	});
});
