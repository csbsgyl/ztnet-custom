declare module "tar-stream" {
	import type { Readable, Writable } from "node:stream";

	interface Headers {
		name: string;
		size: number;
		type: "file" | "directory" | "symlink" | "link" | string;
	}

	interface ExtractStream extends Writable {
		on(
			event: "entry",
			listener: (header: Headers, stream: Readable, next: () => void) => void,
		): this;
	}

	interface PackHeaders {
		name: string;
		size?: number;
		type?: "file" | "directory" | "symlink" | "link" | string;
		linkname?: string;
		mode?: number;
	}

	interface PackStream extends Readable {
		entry(
			headers: PackHeaders,
			data?: string | Buffer,
			callback?: (error?: Error) => void,
		): void;
		finalize(): void;
	}

	export function extract(): ExtractStream;
	export function pack(): PackStream;
}
