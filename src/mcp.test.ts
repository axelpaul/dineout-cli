import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
async function connect(writes = false) {
	const c = new Client({ name: "fixture-client", version: "1" });
	await c.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [
				resolve("src/index.ts"),
				"mcp",
				...(writes ? ["--allow-writes"] : []),
			],
			stderr: "pipe",
		}),
	);
	return c;
}
test("read-only MCP handshake exposes reads but no write tools", async () => {
	const c = await connect();
	try {
		const { tools } = await c.listTools();
		expect(tools).toHaveLength(13);
		expect(
			tools.every(
				(t) =>
					!["dineout_reserve", "dineout_cancel", "dineout_complete"].includes(
						t.name,
					),
			),
		).toBe(true);
		const invalid = await c.callTool({
			name: "dineout_availability",
			arguments: { restaurantId: 1, dateTime: "bad", guests: 2 },
		});
		expect(invalid.isError).toBe(true);
	} finally {
		await c.close();
	}
}, 10000);
test("write-enabled MCP exposes four explicit tools and reserve defaults to dry-run", async () => {
	const c = await connect(true);
	try {
		const { tools } = await c.listTools();
		expect(tools).toHaveLength(17);
		const r = await c.callTool({
			name: "dineout_reserve",
			arguments: { restaurantId: 1, dateTime: "2099-01-01T19:00", guests: 2 },
		});
		expect(r.isError).not.toBe(true);
		const data = JSON.parse((r.content as { text: string }[])[0]!.text);
		expect(data.dryRun).toBe(true);
		expect(data.bookingConfirmed).toBe(false);
	} finally {
		await c.close();
	}
}, 10000);
