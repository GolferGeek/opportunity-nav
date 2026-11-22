import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

export type Role = "ui" | "node" | "agent";
export interface Principal {
  tokenId: string;
  userId: string;
  role: Role;
  label: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Tokens look like `opn_<role>_<43 url-safe chars>` so they're easy to spot and revoke. */
export function newToken(role: Role): string {
  return `opn_${role}_${randomBytes(32).toString("base64url")}`;
}

export async function createToken(db: Db, userId: string, role: Role, label: string): Promise<{ id: string; token: string }> {
  const token = newToken(role);
  const [row] = await db<{ id: string }[]>`
    insert into api_tokens (user_id, role, label, token_hash) values (${userId}, ${role}, ${label}, ${hashToken(token)}) returning id`;
  return { id: row!.id, token };
}

export async function authenticate(db: Db, header: string | undefined): Promise<Principal | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return null;
  const [row] = await db<{ id: string; user_id: string; role: Role; label: string }[]>`
    update api_tokens set last_used_at = now()
    where token_hash = ${hashToken(m[1]!)} and revoked_at is null
    returning id, user_id, role, label`;
  return row ? { tokenId: row.id, userId: row.user_id, role: row.role, label: row.label } : null;
}
