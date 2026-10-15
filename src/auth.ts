import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	mkdirSync,
	chmodSync,
	writeFileSync,
	readFileSync,
	renameSync,
	unlinkSync,
	existsSync,
	openSync,
	closeSync,
} from "node:fs";
export type Session = {
	idToken: string;
	refreshToken: string;
	apiKey: string;
	expiresAt: number;
};
export const webOrigin = "https://bookings.dineout.is";
export const apiOrigin = "https://api.dineout.is/api";
export function configDir() {
	return process.env.DINEOUT_CONFIG_DIR
		? resolve(process.env.DINEOUT_CONFIG_DIR)
		: join(homedir(), ".config", "dineout");
}
export function sessionPath() {
	return join(configDir(), "session.json");
}
export function saveSession(s: Session) {
	if (
		!s.idToken ||
		!s.refreshToken ||
		!s.apiKey ||
		!Number.isFinite(s.expiresAt)
	)
		throw Error("Invalid authentication session.");
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	chmodSync(configDir(), 0o700);
	const tmp = sessionPath() + `.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, sessionPath());
}
export function loadSession(): Session {
	try {
		const s = JSON.parse(readFileSync(sessionPath(), "utf8"));
		if (!s.idToken || !s.refreshToken || !s.apiKey) throw Error();
		return s;
	} catch {
		throw Error(
			"Not authenticated. Run dineout login start, then dineout login verify --stdin.",
		);
	}
}
export function logout() {
	if (existsSync(sessionPath())) unlinkSync(sessionPath());
	return {
		loggedOut: true,
		scope: "local-cli-session",
		note: "Browser cookies and server sessions are not revoked.",
	};
}
export function safeError(error: unknown) {
	return (error instanceof Error ? error.message : String(error))
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
			"[redacted token]",
		);
}
async function locked<T>(fn: () => Promise<T>) {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const path = join(configDir(), "session.lock");
	const start = Date.now();
	let fd: number;
	while (true) {
		try {
			fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, String(process.pid));
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				const pid = Number(readFileSync(path, "utf8"));
				if (pid > 0) {
					try {
						process.kill(pid, 0);
					} catch (dead) {
						if ((dead as NodeJS.ErrnoException).code === "ESRCH") {
							unlinkSync(path);
							continue;
						}
					}
				}
			} catch {}
			if (Date.now() - start > 10000)
				throw Error("Another Dineout process is using the session.");
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	try {
		return await fn();
	} finally {
		closeSync(fd!);
		unlinkSync(path);
	}
}
export async function refreshSession(
	force = false,
	transport: typeof fetch = fetch,
) {
	return locked(async () => {
		const s = loadSession();
		if (!force && s.expiresAt > Date.now() + 60000) return s;
		const r = await transport(
			"https://securetoken.googleapis.com/v1/token?key=" +
				encodeURIComponent(s.apiKey),
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: s.refreshToken,
				}),
				signal: AbortSignal.timeout(20000),
				redirect: "error",
			},
		);
		let data: any;
		try {
			data = await r.json();
		} catch {
			throw Error(`Firebase refresh returned invalid JSON (HTTP ${r.status}).`);
		}
		if (!r.ok || !data.id_token || !data.refresh_token)
			throw Error(
				`Session refresh failed (HTTP ${r.status}); complete browser login again.`,
			);
		const next = {
			...s,
			idToken: data.id_token,
			refreshToken: data.refresh_token,
			expiresAt: Date.now() + Number(data.expires_in) * 1000,
		};
		saveSession(next);
		return next;
	});
}
export async function me(transport: typeof fetch = fetch) {
	const s = await refreshSession(false, transport);
	const r = await transport(apiOrigin + "/web/usercustomer", {
		headers: {
			Authorization: `Bearer ${s.idToken}`,
			accept: "application/json",
		},
		signal: AbortSignal.timeout(20000),
		redirect: "error",
	});
	if (!r.ok)
		throw Error(`Authenticated customer read failed (HTTP ${r.status}).`);
	return r.json();
}
export async function authDoctor() {
	await refreshSession(true);
	const account = await me();
	return {
		authenticated: !!account,
		customerApi: !!account,
		loginMethod: "browser-assisted Firebase phone auth",
		bookingCreated: false,
	};
}
