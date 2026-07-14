import { betterAuth } from "better-auth";
import { getRequestTrustedOrigins } from "~/server/authTrustedOrigins";

describe("reverse-proxy authentication origins", () => {
	it("accepts a direct request origin", () => {
		const request = new Request("http://192.0.2.10:3000/api/auth/sign-in/email");

		expect(getRequestTrustedOrigins(request)).toEqual(["http://192.0.2.10:3000"]);
	});

	it("resolves the public HTTPS origin from standard proxy headers", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				origin: "https://bgp.csbsgyl.com",
				"x-forwarded-host": "bgp.csbsgyl.com",
				"x-forwarded-proto": "https",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["https://bgp.csbsgyl.com"]);
	});

	it("uses a preserved Host header with the forwarded HTTPS protocol", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				host: "bgp.csbsgyl.com",
				"x-forwarded-proto": "https",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["https://bgp.csbsgyl.com"]);
	});

	it("does not copy a cross-site browser Origin into the trusted list", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				origin: "https://attacker.example",
				"x-forwarded-host": "bgp.csbsgyl.com",
				"x-forwarded-proto": "https",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["https://bgp.csbsgyl.com"]);
	});

	it("preserves a public port forwarded by the proxy", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				"x-forwarded-host": "ztnet.example.com:8443",
				"x-forwarded-proto": "https",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["https://ztnet.example.com:8443"]);
	});

	it("does not trust an ambiguous forwarded host list", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				"x-forwarded-host": "attacker.example, bgp.csbsgyl.com",
				"x-forwarded-proto": "https",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["https://ztnet:3000"]);
	});

	it("does not use an invalid forwarded protocol", () => {
		const request = new Request("http://ztnet:3000/api/auth/sign-in/email", {
			headers: {
				"x-forwarded-host": "bgp.csbsgyl.com",
				"x-forwarded-proto": "javascript",
			},
		});

		expect(getRequestTrustedOrigins(request)).toEqual(["http://bgp.csbsgyl.com"]);
	});

	it("returns no dynamic origin without a request", () => {
		expect(getRequestTrustedOrigins()).toEqual([]);
	});
});

describe("Better Auth origin middleware", () => {
	const testAuth = betterAuth({
		baseURL: "http://192.0.2.10:3000",
		secret: "test-secret-with-at-least-thirty-two-characters",
		trustedOrigins: getRequestTrustedOrigins,
		emailAndPassword: { enabled: true },
		advanced: { disableOriginCheck: false },
		logger: { disabled: true },
	});

	const signInRequest = (origin: string) =>
		testAuth.handler(
			new Request("http://ztnet:3000/api/auth/sign-in/email", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: "session=placeholder",
					origin,
					"x-forwarded-host": "bgp.csbsgyl.com",
					"x-forwarded-proto": "https",
				},
				body: JSON.stringify({
					email: "missing@example.com",
					password: "Missing123!",
				}),
			}),
		);

	it("allows the same origin represented by the reverse proxy", async () => {
		const response = await signInRequest("https://bgp.csbsgyl.com");
		const body = await response.json();

		expect(response.status).not.toBe(403);
		expect(body).not.toMatchObject({ code: "INVALID_ORIGIN" });
	});

	it("still rejects a cross-site origin", async () => {
		const response = await signInRequest("https://attacker.example");
		const body = await response.json();

		expect(response.status).toBe(403);
		expect(body).toMatchObject({ code: "INVALID_ORIGIN" });
	});
});
