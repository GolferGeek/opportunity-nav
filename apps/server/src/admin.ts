/**
 * Server admin, run on the server machine:
 *   opnav-admin setup --name "Matt"         first user + a UI sign-in link
 *   opnav-admin token --role node --label "Mac Studio" [--user <id>]
 *   opnav-admin signin [--user <id>]        a new UI sign-in link
 *   opnav-admin merge-usage --from <id> --into <id>   fold a duplicate subscription card into another
 *   opnav-admin machines                    each machine: local and cloud jobs running of its slots, taking new jobs, helper
 *   opnav-admin jobs-off --machine <name>   stop a machine taking new jobs; it finishes what it has
 *   opnav-admin jobs-on --machine <name>    let it take new jobs again
 * Tokens are printed once, to this terminal only.
 */
import { parseArgs } from "node:util";
import { connect, migrate } from "./db.ts";
import { createToken, type Role } from "./auth.ts";
import { listMachines, mergeSubscriptions, setTakingJobs } from "./services/machines.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" }, role: { type: "string" }, label: { type: "string" }, user: { type: "string" },
    from: { type: "string" }, into: { type: "string" }, machine: { type: "string" } },
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
    case "merge-usage": {
      if (!values.from || !values.into) throw new Error("Pass --from <subscription id> --into <subscription id>.");
      const uid = await userId();
      await sql.begin((tx) => mergeSubscriptions(tx, uid, values.from!, values.into!));
      console.log("Merged. The old card is hidden; its reports now go to the other card.");
      break;
    }
    case "machines":
      for (const m of await listMachines(sql, await userId())) {
        if (m.revoked) continue;
        console.log(`${m.name}\t${m.online ? "online" : "offline"}\tlocal ${m.runningLocal} of ${m.capacity}\tcloud ${m.cloudCapacity == null ? "shares local" : `${m.runningCloud} of ${m.cloudCapacity}`}\t${m.takingJobs ? "taking jobs" : "not taking new jobs"}\thelper ${m.helperVersion}`);
      }
      break;
    case "jobs-on":
    case "jobs-off": {
      if (!values.machine) throw new Error("Pass --machine <name>.");
      const on = positionals[0] === "jobs-on";
      const changed = await setTakingJobs(sql, await userId(), { name: values.machine }, on);
      if (!changed.length) throw new Error(`No machine named ${values.machine}.`);
      console.log(`${changed.map((m) => m.name).join(", ")}: ${on ? "taking new jobs" : "not taking new jobs; it finishes the ones it has"}.`);
      break;
    }
    default:
      console.log("Usage: opnav-admin setup --name <name> | signin | token --role node|agent --label <label> | merge-usage --from <id> --into <id> | machines | jobs-off --machine <name> | jobs-on --machine <name>");
  }
} finally {
  await sql.end();
}
