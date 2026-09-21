import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
const forkMigrationWhen = 1788916859449;
const upstreamUiWhen = 1788908496395;
const upstreamLastWhen = 1789925496816;

it.each(["fork", "upstream", "fresh"] as const)(
  "upgrades %s history without changing shipped identities or losing data",
  (baseline) => {
    const db = createConnection(":memory:");
    try {
      db.$client.pragma("foreign_keys = OFF");
      db.$client.exec(
        "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
      );
      db.$client.exec(
        "CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY)",
      );
      const baselineMigrations = migrations.filter((migration) =>
        baseline === "fork"
          ? migration.folderMillis <= forkMigrationWhen &&
            migration.folderMillis !== upstreamUiWhen
          : baseline === "upstream"
            ? migration.folderMillis <= upstreamLastWhen &&
              migration.folderMillis !== forkMigrationWhen
            : false,
      );
      for (const migration of baselineMigrations) {
        for (const statement of migration.sql) db.$client.exec(statement);
        db.$client
          .prepare(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
          )
          .run(migration.hash, migration.folderMillis);
      }
      if (baseline !== "fresh") {
        db.$client.exec(
          "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('retained-project', 'Retained', 1, 2)",
        );
      }
      if (baseline === "fork") {
        db.$client.exec(`
          INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host', 'Retained host', 'persistent', 1, 2);
          INSERT INTO environments (id, project_id, host_id, path, status, created_at, updated_at) VALUES ('environment', 'retained-project', 'host', '/shared', 'ready', 1, 2);
          INSERT INTO threads (id, project_id, environment_id, provider_id, latest_attention_at, created_at, updated_at) VALUES ('thread', 'retained-project', 'environment', 'codex', 1, 1, 2);
          INSERT INTO work_admissions (id, thread_id, host_id, reason, command_json, status, reservation_token, reservation_generation, created_at, updated_at) VALUES ('admission', 'thread', 'host', 'interactive', '{}', 'running', 'token', 7, 1, 2);
          INSERT INTO unmanaged_workspace_mutation_leases (host_id, canonical_path, thread_id, environment_id, request_id, generation, acquired_at, updated_at) VALUES ('host', '/shared', 'thread', 'environment', 'request', 7, 1, 2);
          INSERT INTO environment_path_canonicalizations (environment_id, canonical_path, path, confirmed_at) VALUES ('environment', '/shared', '/shared', 1);
        `);
        db.$client.exec(
          "UPDATE projects SET protect_unmanaged_workspace = 1 WHERE id = 'retained-project'",
        );
        db.$client.exec(
          "INSERT INTO unmanaged_workspace_mutation_lease_events (host_id, canonical_path, thread_id, environment_id, request_id, type, created_at) VALUES ('host', '/shared', 'thread', 'environment', 'request', 'released', 3)",
        );
      }
      if (baseline === "upstream") {
        db.$client.exec(
          "INSERT INTO ui_preferences (key, value_json, revision, updated_at) VALUES ('retained-preference', '{}', 4, 5)",
        );
      }
      migrate(db);
      migrate(db);
      for (const migration of migrations) {
        expect(
          db.$client
            .prepare(
              "SELECT hash FROM __drizzle_migrations WHERE created_at = ?",
            )
            .all(migration.folderMillis),
        ).toEqual([{ hash: migration.hash }]);
      }
      expect(
        db.$client
          .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
          .get(),
      ).toEqual({ count: migrations.length });
      if (baseline !== "fresh") {
        expect(
          db.$client
            .prepare(
              "SELECT name, protect_unmanaged_workspace FROM projects WHERE id = 'retained-project'",
            )
            .get(),
        ).toEqual({
          name: "Retained",
          protect_unmanaged_workspace: baseline === "fork" ? 1 : 0,
        });
      }
      if (baseline === "fork") {
        expect(
          db.$client
            .prepare(
              "SELECT status, reservation_token, reservation_generation FROM work_admissions WHERE id = 'admission'",
            )
            .get(),
        ).toEqual({
          status: "running",
          reservation_token: "token",
          reservation_generation: 7,
        });
        expect(
          db.$client
            .prepare(
              "SELECT generation FROM unmanaged_workspace_mutation_leases WHERE request_id = 'request'",
            )
            .get(),
        ).toEqual({ generation: 7 });
        expect(
          db.$client
            .prepare(
              "SELECT canonical_path FROM environment_path_canonicalizations WHERE environment_id = 'environment'",
            )
            .get(),
        ).toEqual({ canonical_path: "/shared" });
        expect(
          db.$client
            .prepare(
              "SELECT request_id FROM unmanaged_workspace_mutation_lease_events",
            )
            .all(),
        ).toEqual([{ request_id: "request" }]);
      }
      if (baseline === "upstream") {
        expect(
          db.$client
            .prepare(
              "SELECT revision FROM ui_preferences WHERE key = 'retained-preference'",
            )
            .get(),
        ).toEqual({ revision: 4 });
      }
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.$client.close();
    }
  },
);

it.each([1788898395603, forkMigrationWhen])(
  "rejects a tampered branch history at %s before filling its missing migration",
  (when) => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client.exec("DROP TABLE ui_preferences");
      db.$client
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?")
        .run(upstreamUiWhen);
      db.$client
        .prepare(
          "UPDATE __drizzle_migrations SET hash = 'tampered' WHERE created_at = ?",
        )
        .run(when);
      expect(() => migrate(db)).toThrow(/Mismatched applied migration hashes/);
      expect(
        db.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ui_preferences'",
          )
          .all(),
      ).toEqual([]);
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.$client.close();
    }
  },
);
