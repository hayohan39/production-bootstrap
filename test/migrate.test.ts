import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wantsNoTransaction } from "../scripts/migrate.mjs";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts", "migrate.mjs");

// 실제 Postgres 가 있을 때만 돈다. CI 는 postgres 서비스 컨테이너를 붙여
// TEST_DATABASE_URL 을 넣어 준다. 로컬에서 없으면 건너뛴다.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("migrate.mjs (실제 DB)", () => {
  let dir: string;
  const schema = `t_${Date.now()}`;
  const env = () => ({
    ...process.env,
    DATABASE_URL_UNPOOLED: "",
    // 테스트마다 별도 스키마를 써서 서로, 그리고 실제 마이그레이션과 섞이지 않게 한다.
    DATABASE_URL: `${url}${url!.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`,
  });
  const migrate = (...args: string[]) => run("node", [SCRIPT, ...args], { cwd: dir, env: env() });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "migrate-"));
    await mkdir(path.join(dir, "migrations"));
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.end();
  });

  afterAll(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("대기 중인 파일을 순서대로 적용하고, 두 번째 실행은 아무것도 하지 않는다", async () => {
    await writeFile(path.join(dir, "migrations", "001_a.sql"), "create table a (id int);");
    await writeFile(path.join(dir, "migrations", "002_b.sql"), "create table b (a_id int);");

    const first = await migrate();
    expect(first.stdout).toContain("2개 적용 완료");

    const second = await migrate();
    expect(second.stdout).toContain("최신 상태");
  });

  it("실패한 파일은 통째로 되돌린다", async () => {
    await writeFile(
      path.join(dir, "migrations", "003_bad.sql"),
      "create table c (id int); select * from no_such_table;",
    );
    await expect(migrate()).rejects.toMatchObject({ stderr: expect.stringContaining("003_bad.sql 실패") });
    await rm(path.join(dir, "migrations", "003_bad.sql"));
    // c 가 남아 있으면 같은 이름으로 다시 만들 수 없다.
    await writeFile(path.join(dir, "migrations", "003_c.sql"), "create table c (id int);");
    expect((await migrate()).stdout).toContain("1개 적용 완료");
  });

  it("migrate:no-transaction 파일은 트랜잭션 밖에서 실행한다 (CREATE INDEX CONCURRENTLY)", async () => {
    await writeFile(
      path.join(dir, "migrations", "004_idx.sql"),
      "-- add index\n-- migrate:no-transaction\ncreate index concurrently if not exists a_id_idx on a (id);\n",
    );
    const result = await migrate();
    expect(result.stdout).toContain("트랜잭션 없이");
    expect(result.stdout).toContain("1개 적용 완료");
  });

  it("잠금을 못 잡으면 lock_timeout 으로 빨리 실패한다", async () => {
    const { default: pg } = await import("pg");
    const holder = new pg.Client({ connectionString: env().DATABASE_URL });
    await holder.connect();
    await holder.query("begin");
    await holder.query("lock table b in access exclusive mode");
    try {
      await writeFile(path.join(dir, "migrations", "005_alter.sql"), "alter table b add column note text;");
      const started = Date.now();
      await expect(
        run("node", [SCRIPT], { cwd: dir, env: { ...env(), MIGRATION_LOCK_TIMEOUT: "300ms" } }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("lock_timeout") });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    expect((await migrate()).stdout).toContain("1개 적용 완료");
  });

  it("이미 적용된 파일이 바뀌면 거부한다", async () => {
    await writeFile(path.join(dir, "migrations", "001_a.sql"), "create table a (id bigint);");
    await expect(migrate()).rejects.toMatchObject({
      stderr: expect.stringContaining("이미 적용된 마이그레이션이 수정되었습니다"),
    });
  });
});

describe("wantsNoTransaction", () => {
  it("머리 주석의 지시어만 인정한다", () => {
    expect(wantsNoTransaction("-- idx\n-- migrate:no-transaction\ncreate index concurrently x on t (a);")).toBe(true);
    expect(wantsNoTransaction("create table t (a int);\n-- migrate:no-transaction\n")).toBe(false);
    expect(wantsNoTransaction("-- migrate:no-transaction-please\nselect 1;")).toBe(false);
  });
});
