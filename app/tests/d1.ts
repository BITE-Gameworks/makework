// In-memory copy of the user server's database (all migrations, run on node:sqlite) in the D1 shape the workers use.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { compareText } from "../src/core/text";

const migrations = new URL("../../user-server/migrations/", import.meta.url);
const schema = readdirSync(migrations).sort(compareText).map((f) => readFileSync(new URL(f, migrations), "utf8")).join("\n");

export function userDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return {
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const statement of statements) await statement.run();
    },
    prepare(sql: string) {
      const statement = (values: unknown[]) => ({
        bind: (...next: unknown[]) => statement(next),
        first: async () => db.prepare(sql).get(...(values as never[])) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...(values as never[])) }),
        run: async () => db.prepare(sql).run(...(values as never[])),
      });
      return statement([]);
    },
  };
}
