import type { Server } from "socket.io";

type SocketServerRegistry = typeof globalThis & {
	__ztnetSocketServers?: Set<Server>;
};

const registry = globalThis as SocketServerRegistry;

export function registerSocketServer(io: Server): void {
	if (!registry.__ztnetSocketServers) registry.__ztnetSocketServers = new Set();
	registry.__ztnetSocketServers.add(io);
}

export function disconnectUserSockets(userId: string, io?: Server): number {
	const servers = io ? [io] : Array.from(registry.__ztnetSocketServers ?? []);
	let disconnected = 0;
	for (const server of servers) {
		for (const socket of server.sockets.sockets.values()) {
			if (socket.data.userId !== userId) continue;
			socket.disconnect(true);
			disconnected += 1;
		}
	}
	return disconnected;
}
