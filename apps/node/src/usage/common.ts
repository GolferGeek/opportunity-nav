/* Usage collection methods adapted from Omarchy's Agents collectors (MIT). */
import type { ProviderId, UsageWindow } from "@opnav/shared";
import { number, parse, timestamp } from "../system.ts";
import type { System } from "../system.ts";

export interface Login {
  id?: string;
  token?: string;
  plan?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Reading {
  plan?: string;
  windows: UsageWindow[];
  unavailable?: string;
}

export interface Adapter {
  provider: ProviderId;
  commands: string[];
  detect(sys: System): Promise<Login | undefined>;
  read(ctx: UsageContext, login: Login): Promise<Reading>;
}

export interface UsageContext {
  sys: System;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export class AuthRequired extends Error {}

export function jwt(token?: string): Record<string, unknown> {
  const payload = token?.split(".")[1];
  return payload ? parse(Buffer.from(payload, "base64url").toString("utf8")) : {};
}

export function percent(id: string, label: string, kind: UsageWindow["kind"], value: unknown, reset?: unknown, model?: string): UsageWindow[] {
  const used = number(value);
  return used === undefined ? [] : [{
    id, label, kind, unit: "percent", used: Math.max(0, Math.min(100, used)), resetsAt: timestamp(reset), model,
  }];
}

export async function request(ctx: UsageContext, url: string, login: Login, body?: object, headers?: Record<string, string>): Promise<Record<string, unknown>> {
  if (!login.token || (login.expiresAt && Date.parse(login.expiresAt) <= Date.now())) throw new AuthRequired();
  const timeout = AbortSignal.timeout(12_000);
  const result = await ctx.fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
    redirect: "error",
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  });
  if (result.status === 401 || result.status === 403) throw new AuthRequired();
  if (!result.ok) throw new Error("Usage request failed");
  const payload: unknown = await result.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || "error" in payload) {
    throw new Error("Unexpected usage response");
  }
  return payload as Record<string, unknown>;
}
