import type { NextApiRequest, NextApiResponse } from "next";
import { Server } from "socket.io";
import { Role } from "@prisma/client";
import { auth } from "~/lib/auth";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "~/server/db";
import { checkNetworkAccess } from "~/utils/networkAccess";
import { syncManager, networkRoom } from "~/server/sync/syncManager";
import type { UserContext } from "~/types/ctx";
import { canAccessProtectedResources } from "~/utils/accountAccess";
import { disconnectUserSockets, registerSocketServer } from "~/server/socketRegistry";

export { disconnectUserSockets } from "~/server/socketRegistry";

interface SocketIoExtension {
	socket: {
		server: {
			io: Server;
		};
	};
}

export type NextApiResponseWithSocketIo = NextApiResponse & SocketIoExtension;

const protectedAccountSelect = {
	id: true,
	role: true,
	isActive: true,
	suspensionReason: true,
	expiresAt: true,
} as const;

async function userCanUseSockets(userId: string): Promise<boolean> {
	try {
		const account = await prisma.user.findUnique({
			where: { id: userId },
			select: protectedAccountSelect,
		});
		return account !== null && canAccessProtectedResources(account);
	} catch {
		return false;
	}
}

const SocketHandler = async (req: NextApiRequest, res: NextApiResponseWithSocketIo) => {
	const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
	if (!session || !(await userCanUseSockets(session.user.id))) {
		res.status(401).json({ message: "Authorization Error" });
		return;
	}

	if (!res.socket.server.io) {
		// biome-ignore lint/suspicious/noConsoleLog: <explanation>
		console.log("Socket is initializing");

		//@ts-expect-error assinging to a property that doesn't exist
		const io = new Server(res.socket.server, {
			addTrailingSlash: false,
		});
		res.socket.server.io = io;
		registerSocketServer(io);

		// Require a valid session for EVERY socket: reject unauthenticated
		// connections outright (no unauthenticated client may hold a socket at all),
		// then enforce per-network access again at subscribe time (defense in depth).
		io.use(async (socket, next) => {
			try {
				const s = await auth.api.getSession({
					headers: fromNodeHeaders(socket.handshake.headers),
				});
				if (!s) return next(new Error("unauthorized"));
				if (!(await userCanUseSockets(s.user.id))) {
					return next(new Error("unauthorized"));
				}
				socket.data.userId = s.user.id;
				next();
			} catch {
				next(new Error("unauthorized"));
			}
		});

		// Subscription-driven live member sync: while a client is viewing a network,
		// the SyncManager reconciles it every ~10s and pushes a "changed" event.
		io.on("connection", (socket) => {
			const subscribed = new Set<string>();
			const userId = socket.data.userId as string | undefined;
			const ctx = {
				session: { user: { id: userId } },
				prisma,
			} as unknown as UserContext;

			socket.on("subscribe:network", async ({ nwid }: { nwid?: string }) => {
				if (!nwid || !userId) return;
				if (!(await userCanUseSockets(userId))) {
					socket.disconnect(true);
					return;
				}
				if (subscribed.has(nwid)) return;
				try {
					await checkNetworkAccess(ctx, nwid, Role.READ_ONLY);
				} catch {
					return; // no access → ignore silently
				}
				subscribed.add(nwid);
				socket.join(networkRoom(nwid));
				syncManager.acquire(io, ctx, nwid);
			});

			socket.on("unsubscribe:network", ({ nwid }: { nwid?: string }) => {
				if (!nwid || !subscribed.delete(nwid)) return;
				socket.leave(networkRoom(nwid));
				syncManager.release(nwid);
			});

			socket.on("disconnect", () => {
				for (const nwid of subscribed) syncManager.release(nwid);
				subscribed.clear();
			});
		});
	} else {
		registerSocketServer(res.socket.server.io);
	}
	res.end();
};

export const config = {
	api: {
		bodyParser: false,
	},
};

export default SocketHandler;
