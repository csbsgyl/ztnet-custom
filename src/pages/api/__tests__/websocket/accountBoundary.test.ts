jest.mock("socket.io", () => ({ Server: jest.fn() }));
jest.mock("~/lib/auth", () => ({
	auth: { api: { getSession: jest.fn() } },
}));
jest.mock("better-auth/node", () => ({ fromNodeHeaders: jest.fn((headers) => headers) }));
jest.mock("~/server/db", () => ({
	prisma: { user: { findUnique: jest.fn() } },
}));
jest.mock("~/utils/networkAccess", () => ({ checkNetworkAccess: jest.fn() }));
jest.mock("~/server/sync/syncManager", () => ({
	networkRoom: jest.fn((nwid: string) => `network:${nwid}`),
	syncManager: { acquire: jest.fn(), release: jest.fn() },
}));

import type { NextApiRequest } from "next";
import { Server } from "socket.io";
import { auth } from "~/lib/auth";
import SocketHandler, {
	disconnectUserSockets,
	type NextApiResponseWithSocketIo,
} from "~/pages/api/websocket";
import { prisma } from "~/server/db";
import { syncManager } from "~/server/sync/syncManager";
import { checkNetworkAccess } from "~/utils/networkAccess";

type EventHandler = (payload?: { nwid?: string }) => void | Promise<void>;

interface MockSocket {
	handshake: { headers: Record<string, string> };
	data: Record<string, unknown>;
	on: jest.Mock;
	join: jest.Mock;
	leave: jest.Mock;
	disconnect: jest.Mock;
}

function createSocket() {
	const listeners = new Map<string, EventHandler>();
	const socket: MockSocket = {
		handshake: { headers: {} },
		data: {},
		on: jest.fn((event: string, handler: EventHandler) => {
			listeners.set(event, handler);
		}),
		join: jest.fn(),
		leave: jest.fn(),
		disconnect: jest.fn(),
	};
	return { socket, listeners };
}

function createIoHarness() {
	let middleware:
		| ((socket: MockSocket, next: (error?: Error) => void) => Promise<void>)
		| undefined;
	let connectionHandler: ((socket: MockSocket) => void) | undefined;
	const io = {
		use: jest.fn(
			(handler: (socket: MockSocket, next: (error?: Error) => void) => Promise<void>) => {
				middleware = handler;
				return io;
			},
		),
		on: jest.fn((event: string, handler: (socket: MockSocket) => void) => {
			if (event === "connection") connectionHandler = handler;
			return io;
		}),
		sockets: { sockets: new Map<string, MockSocket>() },
	};

	return {
		io,
		middleware: () => {
			if (!middleware) throw new Error("Socket middleware was not registered");
			return middleware;
		},
		connectionHandler: () => {
			if (!connectionHandler) throw new Error("Connection handler was not registered");
			return connectionHandler;
		},
	};
}

function createResponse() {
	const server = { io: undefined as unknown };
	const response = {
		socket: { server },
		status: jest.fn(),
		json: jest.fn(),
		end: jest.fn(),
	} as unknown as NextApiResponseWithSocketIo;
	(response.status as jest.Mock).mockReturnValue(response);
	(response.json as jest.Mock).mockReturnValue(response);
	return { response, server };
}

const getSession = auth.api.getSession as unknown as jest.Mock;
const userLookup = prisma.user.findUnique as jest.Mock;
const serverConstructor = Server as unknown as jest.Mock;
const networkAccess = checkNetworkAccess as jest.Mock;
const activeAccount = {
	id: "user-1",
	role: "USER",
	isActive: true,
	suspensionReason: "NONE",
	expiresAt: null,
};

async function initializeSocketServer() {
	const harness = createIoHarness();
	serverConstructor.mockImplementation(() => harness.io);
	getSession.mockResolvedValue({ user: { id: "user-1" } });
	userLookup.mockResolvedValue(activeAccount);
	const { response } = createResponse();

	await SocketHandler({ headers: {} } as NextApiRequest, response);

	return { harness, response };
}

describe("WebSocket account boundary", () => {
	it.each([
		["isActive=false", { isActive: false }],
		["subscription expiration marker", { suspensionReason: "SUBSCRIPTION_EXPIRED" }],
		["elapsed expiresAt", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
	])(
		"rejects the bootstrap request for a non-admin with %s",
		async (_name, overrides) => {
			getSession.mockResolvedValue({ user: { id: "user-1" } });
			userLookup.mockResolvedValue({ ...activeAccount, ...overrides });
			const { response } = createResponse();

			await SocketHandler({ headers: {} } as NextApiRequest, response);

			expect(response.status).toHaveBeenCalledWith(401);
			expect(serverConstructor).not.toHaveBeenCalled();
		},
	);

	it("rejects a handshake when the account changed after bootstrap", async () => {
		const { harness } = await initializeSocketServer();
		userLookup.mockResolvedValue({ ...activeAccount, isActive: false });
		const { socket } = createSocket();
		const next = jest.fn();

		await harness.middleware()(socket, next);

		expect(next).toHaveBeenCalledWith(expect.any(Error));
		expect(socket.data.userId).toBeUndefined();
	});

	it("disconnects an established socket when account access is lost", async () => {
		const { harness } = await initializeSocketServer();
		const { socket, listeners } = createSocket();
		const next = jest.fn();
		await harness.middleware()(socket, next);
		harness.connectionHandler()(socket);
		userLookup.mockResolvedValue({
			...activeAccount,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
		});

		await listeners.get("subscribe:network")?.({ nwid: "network-1" });

		expect(socket.disconnect).toHaveBeenCalledWith(true);
		expect(networkAccess).not.toHaveBeenCalled();
		expect(syncManager.acquire).not.toHaveBeenCalled();
	});

	it("retains the per-network permission check for active accounts", async () => {
		const { harness } = await initializeSocketServer();
		const { socket, listeners } = createSocket();
		await harness.middleware()(socket, jest.fn());
		harness.connectionHandler()(socket);
		networkAccess.mockRejectedValue(new Error("forbidden"));

		await listeners.get("subscribe:network")?.({ nwid: "network-1" });

		expect(networkAccess).toHaveBeenCalledTimes(1);
		expect(socket.join).not.toHaveBeenCalled();
		expect(socket.disconnect).not.toHaveBeenCalled();
		expect(syncManager.acquire).not.toHaveBeenCalled();
	});

	it("disconnectUserSockets disconnects only sockets owned by the user", async () => {
		const { harness } = await initializeSocketServer();
		const first = createSocket().socket;
		const second = createSocket().socket;
		const other = createSocket().socket;
		first.data.userId = "disconnect-target";
		second.data.userId = "disconnect-target";
		other.data.userId = "other-user";
		harness.io.sockets.sockets.set("first", first);
		harness.io.sockets.sockets.set("second", second);
		harness.io.sockets.sockets.set("other", other);

		expect(disconnectUserSockets("disconnect-target")).toBe(2);
		expect(first.disconnect).toHaveBeenCalledWith(true);
		expect(second.disconnect).toHaveBeenCalledWith(true);
		expect(other.disconnect).not.toHaveBeenCalled();
	});

	it("allows an administrator through bootstrap even when suspension fields are set", async () => {
		getSession.mockResolvedValue({ user: { id: "admin-1" } });
		userLookup.mockResolvedValue({
			...activeAccount,
			id: "admin-1",
			role: "ADMIN",
			isActive: false,
			suspensionReason: "SUBSCRIPTION_EXPIRED",
			expiresAt: new Date("2020-01-01T00:00:00.000Z"),
		});
		const harness = createIoHarness();
		serverConstructor.mockImplementation(() => harness.io);
		const { response } = createResponse();

		await SocketHandler({ headers: {} } as NextApiRequest, response);

		expect(response.status).not.toHaveBeenCalled();
		expect(response.end).toHaveBeenCalledTimes(1);
	});
});
