/**
 * Server admin, run on the server machine:
 *   opnav-admin setup --name "Matt"         first user + a UI sign-in link
 *   opnav-admin token --role node --label "Mac Studio" [--user <id>]
 *   opnav-admin signin [--user <id>]        a new UI sign-in link
 * Tokens are printed once, to this terminal only.
 */
import { parseArgs } from "node:util";
import { connect, migrate } from "./db.ts";
import { createToken, type Role } from "./auth.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, role: { type: "string" }, label: { type: "string" }, user: { type: "string" } },
});
const sql = connect(process.env.DATABASE_URL ?? "postgres://localhost:5432/opportunity_nav");
await migrate(sql);
const publicUrl = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4317}`).replace(/\/+$/, "");

async function userId(): Promise<string> {
  if (values.user) return values.user;
  const users = await sql<{ id: string }[]>`select id from users order by created_at limit 2`;
  if (users.length !== 1) throw new Error(users.length ? "More than one user; pass --user <id>." : "No user yet; run setup first.");
  return users[0]!.id;
}
const signinLink = async (uid: string) => {
  const t = await createToken(sql, uid, "ui", `Sign-in ${new Date().toISOString().slice(0, 16)}`);
  return `${publicUrl}/#signin=${t.token}`;
};

try {
  switch (positionals[0]) {
    case "setup": {
      const [u] = await sql<{ id: string }[]>`insert into users (name) values (${values.name ?? "Me"}) returning id`;
      console.log(`Created user ${u!.id}.\nOpen this once to sign in:\n${await signinLink(u!.id)}`);
      break;
    }
    case "signin":
      console.log(await signinLink(await userId()));
      break;
    case "token": {
      const role = (values.role ?? "node") as Role;
      if (!["ui", "node", "agent"].includes(role)) throw new Error("--role is ui, node or agent.");
      const t = await createToken(sql, await userId(), role, values.label ?? role);
      console.log(t.token);
      break;
    }
    default:
      console.log("Usage: opnav-admin setup --name <name> | signin | token --role node|agent --label <label>");
  }
} finally {
  await sql.end();
}
