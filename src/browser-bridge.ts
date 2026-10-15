import { existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
export async function browserAction(
	action: string,
	options: Record<string, unknown>,
) {
	const base =
		process.env.DINEOUT_SOURCE_DIR ??
		(Bun.main.endsWith(".ts")
			? dirname(dirname(Bun.main))
			: dirname(realpathSync(process.execPath)));
	const file = join(base, "dist", "login-helper.mjs");
	if (!existsSync(file))
		throw Error(
			"Login helper missing; run bun run build in the source checkout.",
		);
	const child = Bun.spawn(
		[
			process.env.DINEOUT_NODE ?? "node",
			file,
			action,
			String(options.cdp ?? "http://127.0.0.1:9335"),
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	child.stdin.write(JSON.stringify(options));
	child.stdin.end();
	const [out, err, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) {
		let message = "Browser login failed";
		try {
			message = JSON.parse(err).error ?? message;
		} catch {}
		throw Error(message);
	}
	return JSON.parse(out);
}
