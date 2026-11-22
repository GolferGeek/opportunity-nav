import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaimRequest,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_USAGE_INTERVAL_SEC,
  ExternalWorkReport,
  JobEventsRequest,
  LeaseRenewRequest,
  NODE,
  NodeHeartbeat,
  UsageReport,
} from "@opnav/shared";
import type { Sql } from "./db.ts";
import { authenticate, createToken, type Principal, type Role } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { heartbeat, ingestExternal, ingestUsage, listMachines, machineForToken } from "./services/machines.ts";
import { answerQuestion, cancelJob, claim, createJob, getJob, NewJob, recordEvents, renewLease } from "./services/jobs.ts";
import { createNode, listTree, NewTreeNode, TreeNodePatch, updateNode } from "./services/tree.ts";
import { dashboard, happening } from "./services/views.ts";
import { runAction } from "./services/actions.ts";
import { agentCard, handleA2A } from "./a2a.ts";
import { handleMcp } from "./mcp.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AppOptions {
  sql: Sql;
  publicUrl: string;
  webDist?: string;
  logger?: boolean;
}

const uuid = z.string().uuid();

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { sql } = opts;
  const app = Fastify({ logger: opts.logger ? { redact: ["req.headers.authorization"] } : false, bodyLimit: 5 * 1024 * 1024 });
  app.decorateRequest("principal", null as unknown as Principal);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    const status = (err as any).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server." });
  });

  const guard = (roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(sql, req.headers.authorization);
    if (!p) return reply.status(401).send({ error: "Sign in again: this token is missing or revoked." });
    if (!roles.includes(p.role)) return reply.status(403).send({ error: `A ${p.role} token can't do this.` });
    req.principal = p;
  };
  const by = (req: FastifyRequest) => (req.principal.role === "ui" ? "you" : `${req.principal.role}:${req.principal.label}`);

  // ── Node helper API ────────────────────────────────────────────────
  await app.register(async (r) => {
    r.addHook("preHandler", guard(["node"]));
    const machine = async (req: FastifyRequest) => {
      const id = await machineForToken(sql, req.principal.tokenId);
      if (!id) throw new HttpError(409, "Send a heartbeat first.");
      return id;
    };
    r.post(NODE.heartbeat, async (req) => {
      const nodeId = await heartbeat(sql, req.principal.userId, req.principal.tokenId, NodeHeartbeat.parse(req.body));
      return {
        nodeId,
        serverTime: new Date().toISOString(),
        usageIntervalSec: DEFAULT_USAGE_INTERVAL_SEC,
        heartbeatIntervalSec: DEFAULT_HEARTBEAT_INTERVAL_SEC,
      };
    });
    r.post(NODE.usage, async (req) => ({ accepted: await ingestUsage(sql, req.principal.userId, await machine(req), UsageReport.parse(req.body)) }));
    r.post(NODE.claim, async (req) => ({ turns: await claim(sql, req.principal.userId, await machine(req), ClaimRequest.parse(req.body)) }));
    r.post("/api/node/jobs/:jobId/lease", async (req) => {
      const { jobId } = z.object({ jobId: uuid }).parse(req.params);
      return renewLease(sql, req.principal.userId, await machine(req), jobId, LeaseRenewRequest.parse(req.body).leaseId);
    });
    r.post("/api/node/jobs/:jobId/events", async (req) => {
      const { jobId } = z.object({ jobId: uuid }).parse(req.params);
      const b = JobEventsRequest.parse(req.body);
      return recordEvents(sql, req.principal.userId, await machine(req), jobId, b.leaseId, b.events);
    });
    r.post(NODE.external, async (req) => ({
      accepted: await ingestExternal(sql, req.principal.userId, await machine(req), ExternalWorkReport.parse(req.body)),
    }));
  });

  // ── UI API ─────────────────────────────────────────────────────────
  await app.register(async (r) => {
    r.addHook("preHandler", guard(["ui"]));
    const id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id;
    r.get("/api/me", async (req) => {
      const [u] = await sql`select id, name from users where id = ${req.principal.userId}`;
      return u;
    });
    r.get("/api/tree", async (req) => listTree(sql, req.principal.userId));
    r.post("/api/tree", async (req) => createNode(sql, req.principal.userId, NewTreeNode.parse(req.body)));
    r.patch("/api/tree/:id", async (req) => updateNode(sql, req.principal.userId, id(req), TreeNodePatch.parse(req.body)));
    r.get("/api/happening", async (req) => {
      const { scope } = z.object({ scope: uuid.optional() }).parse(req.query);
      return happening(sql, req.principal.userId, scope);
    });
    r.get("/api/dashboard", async (req) => dashboard(sql, req.principal.userId));
    r.post("/api/jobs", async (req) => createJob(sql, req.principal.userId, NewJob.parse(req.body), by(req)));
    r.get("/api/jobs/:id", async (req) => getJob(sql, req.principal.userId, id(req)));
    r.post("/api/jobs/:id/cancel", async (req) => cancelJob(sql, req.principal.userId, id(req)));
    r.post("/api/questions/:id/answer", async (req) => {
      const { answer } = z.object({ answer: z.string().trim().min(1) }).parse(req.body);
      return answerQuestion(sql, req.principal.userId, id(req), answer, by(req));
    });
    r.post("/api/questions/:id/dismiss", async (req) => {
      await sql`update questions set status = 'dismissed' where id = ${id(req)} and user_id = ${req.principal.userId} and status = 'open'`;
      return { dismissed: true };
    });
    r.post("/api/roadblocks/:id/clear", async (req) => runAction(sql, req.principal.userId, "clear_roadblock", { roadblockId: id(req) }, by(req)));
    r.get("/api/machines", async (req) => listMachines(sql, req.principal.userId));
    r.get("/api/tokens", async (req) =>
      sql`select id, role, label, created_at, last_used_at, revoked_at from api_tokens where user_id = ${req.principal.userId} order by created_at desc`);
    r.post("/api/tokens", async (req) => {
      const b = z.object({ role: z.enum(["node", "agent", "ui"]), label: z.string().trim().min(1).max(80) }).parse(req.body);
      const t = await createToken(sql, req.principal.userId, b.role, b.label);
      return { id: t.id, token: t.token, note: "Shown once. Copy it now." };
    });
    r.delete("/api/tokens/:id", async (req) => {
      await sql`update api_tokens set revoked_at = now() where id = ${id(req)} and user_id = ${req.principal.userId} and revoked_at is null`;
      return { revoked: true };
    });
    r.patch("/api/subscriptions/:id", async (req) => {
      const b = z.object({ monthlyCostUsd: z.number().nonnegative().nullable().optional(), hidden: z.boolean().optional(), label: z.string().max(80).nullable().optional() }).parse(req.body);
      const set: Record<string, unknown> = {};
      if (b.monthlyCostUsd !== undefined) set.monthly_cost_usd = b.monthlyCostUsd;
      if (b.hidden !== undefined) set.hidden = b.hidden;
      if (b.label !== undefined) set.label = b.label;
      if (!Object.keys(set).length) return { updated: false };
      await sql`update subscriptions set ${sql(set)} where id = ${id(req)} and user_id = ${req.principal.userId}`;
      return { updated: true };
    });
    /** Same actions agents get; the UI's command bar uses this. */
    r.post("/api/act", async (req) => {
      const b = z.object({ action: z.string(), input: z.unknown().optional() }).parse(req.body);
      return runAction(sql, req.principal.userId, b.action, b.input, by(req));
    });
  });

  // ── Agent doors: A2A first, MCP second ─────────────────────────────
  app.get("/.well-known/agent-card.json", async () => agentCard(opts.publicUrl));
  app.get("/.well-known/agent.json", async () => agentCard(opts.publicUrl)); // older A2A clients
  await app.register(async (r) => {
    r.addHook("preHandler", guard(["agent", "ui"]));
    r.post("/a2a", async (req) => handleA2A(sql, req.principal, req.body));
    r.post("/mcp", async (req, reply) => handleMcp(sql, req.principal, req, reply));
    r.get("/mcp", async (_req, reply) => reply.status(405).send({ error: "Use POST." }));
  });

  app.get("/healthz", async () => {
    await sql`select 1`;
    return { ok: true };
  });

  // ── The web UI ─────────────────────────────────────────────────────
  const webDist = opts.webDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/a2a") && !req.url.startsWith("/mcp"))
        return reply.sendFile("index.html");
      return reply.status(404).send({ error: "Not found." });
    });
  }

  return app;
}
