import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 실제 Postgres 가 있을 때만 돈다 (CI 는 서비스 컨테이너로 TEST_DATABASE_URL 을 준다).
// 빈 DB(마이그레이션 전)에서 헬스체크가 깨지지 않는지가 핵심이다.
const url = process.env.TEST_DATABASE_URL;
const schema = `hc_${Date.now()}`;

describe.skipIf(!url)("checkDatabase (실제 DB)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await admin.end();
    process.env.DATABASE_URL = `${url}${url!.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
  });

  afterAll(async () => {
    const { getPool } = await import("@/lib/db");
    await getPool().end();
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  it("마이그레이션 전(빈 DB)에도 ok, 마이그레이션 0개", async () => {
    const { checkDatabase } = await import("@/lib/check-database");
    expect(await checkDatabase()).toMatchObject({ state: "ok", migrations: 0 });
  });

  it("schema_migrations 가 있으면 개수를 센다", async () => {
    const { query } = await import("@/lib/db");
    await query("create table schema_migrations (id text primary key)");
    await query("insert into schema_migrations values ('a'), ('b')");
    const { checkDatabase } = await import("@/lib/check-database");
    expect(await checkDatabase()).toMatchObject({ state: "ok", migrations: 2 });
  });
});
