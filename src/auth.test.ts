import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	saveSession,
	loadSession,
	sessionPath,
	refreshSession,
	me,
	safeError,
} from "./auth.ts";
let dir: string, old: string | undefined;
beforeEach(() => {
	old = process.env.DINEOUT_CONFIG_DIR;
	dir = mkdtempSync(join(tmpdir(), "dineout-test-"));
	process.env.DINEOUT_CONFIG_DIR = dir;
});
afterEach(() => {
	if (old === undefined) delete process.env.DINEOUT_CONFIG_DIR;
	else process.env.DINEOUT_CONFIG_DIR = old;
	rmSync(dir, { recursive: true, force: true });
});
const session = () => ({
	idToken: "fixture-id-token",
	refreshToken: "fixture-refresh",
	apiKey: "fixture-public-config",
	expiresAt: 0,
});
test("refresh rotates private session and uses Google refresh endpoint only", async () => {
	saveSession(session());
	let calls = 0;
	const transport = (async (url: any, init: any) => {
		calls++;
		expect(String(url)).toStartWith(
			"https://securetoken.googleapis.com/v1/token?key=",
		);
		expect(init.body.get("grant_type")).toBe("refresh_token");
		return Response.json({
			id_token: "fixture-new-token",
			refresh_token: "fixture-rotated",
			expires_in: "3600",
		});
	}) as unknown as typeof fetch;
	const s = await refreshSession(true, transport);
	expect(s.refreshToken).toBe("fixture-rotated");
	expect(loadSession().idToken).toBe("fixture-new-token");
	expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
	expect(calls).toBe(1);
});
test("failed refresh preserves credentials and is not retried", async () => {
	saveSession(session());
	let calls = 0;
	const transport = (async () => {
		calls++;
		return Response.json(
			{ error: { message: "TOKEN_EXPIRED" } },
			{ status: 400 },
		);
	}) as unknown as typeof fetch;
	await expect(refreshSession(true, transport)).rejects.toThrow(
		"Session refresh failed",
	);
	expect(loadSession().refreshToken).toBe("fixture-refresh");
	expect(calls).toBe(1);
});
test("account read uses exact read-only production endpoint and bearer", async () => {
	saveSession({ ...session(), expiresAt: Date.now() + 3600000 });
	const transport = (async (url: any, init: any) => {
		expect(url).toBe("https://api.dineout.is/api/web/usercustomer");
		expect(init.method).toBeUndefined();
		expect(init.headers.Authorization).toBe("Bearer fixture-id-token");
		return Response.json({ id: "fixture-customer" });
	}) as unknown as typeof fetch;
	expect(await me(transport)).toEqual({ id: "fixture-customer" });
});
test("missing session is explicit and invalid session cannot be saved", () => {
	expect(() => loadSession()).toThrow("Not authenticated");
	expect(() => saveSession({ ...session(), refreshToken: "" })).toThrow(
		"Invalid authentication",
	);
});
test("error output removes bearer secrets", () => {
	expect(safeError(Error("Bearer example-secret"))).not.toContain(
		"example-secret",
	);
});
