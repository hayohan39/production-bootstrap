import { hasDatabase, query } from "@/lib/db";
import { redact, type DatabaseStatus } from "@/lib/health";

export async function checkDatabase(): Promise<DatabaseStatus> {
  if (!hasDatabase()) return { state: "not-configured" };

  const started = Date.now();
  try {
    await query("select 1");
    const latencyMs = Date.now() - started;
    // 마이그레이션을 한 번도 안 돌렸으면 schema_migrations 가 없다. 그것도 정상이다.
    // 존재 확인과 count 를 한 쿼리(CASE)로 합치면 안 된다: 테이블이 없으면 Postgres 가
    // 실행되지 않을 분기의 하위 쿼리까지 계획 단계에서 해석하다가 에러를 낸다.
    const [exists] = await query<{ ok: boolean }>(
      "select to_regclass('schema_migrations') is not null as ok",
    );
    let migrations = 0;
    if (exists?.ok) {
      const [row] = await query<{ count: string }>("select count(*)::text as count from schema_migrations");
      migrations = Number(row?.count ?? 0);
    }
    return { state: "ok", latencyMs, migrations };
  } catch (error) {
    return { state: "error", message: redact(error instanceof Error ? error.message : String(error)) };
  }
}
