import type { FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Sql } from "./db.ts";
import type { Principal } from "./auth.ts";
import { actions, runAction } from "./services/actions.ts";

/** MCP over streamable HTTP, stateless: one server per request, same actions as A2A. */
export async function handleMcp(sql: Sql, who: Principal, req: FastifyRequest, reply: FastifyReply) {
  const server = new McpServer({ name: "opportunity-nav", version: "0.1.0" });
  for (const [name, a] of Object.entries(actions)) {
    server.registerTool(name, { description: a.description, inputSchema: (a.input as any).shape }, async (input: unknown) => {
      try {
        const result = await runAction(sql, who.userId, name, input, `agent:${who.label}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
      }
    });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  reply.hijack();
  reply.raw.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req.raw, reply.raw, req.body);
}
