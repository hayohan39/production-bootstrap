import { attachDatabasePool } from "@vercel/functions";
import { Pool, type QueryResultRow } from "pg";
import { optionalEnv, requireEnv } from "@/lib/env";

// Neon 의 pooled 연결 문자열(호스트에 -pooler)을 쓰는 것을 전제로 한다.
// 배포 환경에서는 Vercel 환경변수 DATABASE_URL 이 그 값을 갖고 있다.
//
// 같은 인스턴스에서 여러 요청이 Pool 을 공유하도록 모듈 스코프에 둔다.
// attachDatabasePool 은 Vercel Fluid compute 가 인스턴스를 멈추기 전에
// 유휴 연결을 정리하게 해 준다(로컬에서는 아무 일도 하지 않는다).
let pool: Pool | undefined;

export function hasDatabase(): boolean {
  return Boolean(optionalEnv("DATABASE_URL"));
}

export function getPool(): Pool {
  if (!pool) {
    // 느린 쿼리 하나가 함수 실행 시간을 다 쓰지 않도록 클라이언트 쪽 시간 제한을 건다.
    // (statement_timeout 은 시작 파라미터로 보내지므로 PgBouncer 풀링 연결에서 거부될 수 있다.)
    pool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
    });
    attachDatabasePool(pool);
  }
  return pool;
}

/**
 * 파라미터 바인딩 쿼리. 문자열 조합으로 SQL 을 만들지 말고 항상 $1, $2 를 쓴다.
 *
 *   const rows = await query<{ id: number }>("select id from items where owner = $1", [owner]);
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}
