// Applies migrations/*.sql in filename order, once each. Usage: DATABASE_URL=... npm run migrate
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool, withTransaction, type Db } from "./db.js";

const DIR = join(import.meta.dirname, "..", "migrations");

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const { rows } = await db.query<{ name: string }>(`select name from schema_migrations`);
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = await readFile(join(DIR, name), "utf8");
    await withTransaction(db, async (tx) => {
      await tx.query(sql);
      await tx.query(`insert into schema_migrations (name) values ($1)`, [name]);
    });
    applied.push(name);
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool();
  migrate(db)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date"))
    .finally(() => db.end());
}
