import { checkDatabase } from "@/lib/check-database";
import { summarize } from "@/lib/health";
import { project } from "@/lib/project";

export const dynamic = "force-dynamic";

// 새 프로젝트의 첫 화면. 배포와 DB 연결이 살아 있는지 한눈에 보여준다.
// 실제 기능을 만들기 시작하면 이 페이지를 통째로 바꾸면 된다.
export default async function Home() {
  const health = summarize(await checkDatabase());
  const db = health.database;

  return (
    <main>
      <h1>{project.name}</h1>
      <p className="muted">{project.description}</p>

      <h2>상태</h2>
      <ul>
        <li>
          환경: <code>{health.environment}</code>
          {health.commit ? (
            <>
              {" "}
              · 커밋 <code>{health.commit}</code>
            </>
          ) : null}
        </li>
        <li>
          데이터베이스:{" "}
          {db.state === "ok" ? (
            <span className="ok">
              연결됨 ({db.latencyMs}ms, 마이그레이션 {db.migrations}개)
            </span>
          ) : db.state === "not-configured" ? (
            <span className="warn">DATABASE_URL 없음</span>
          ) : (
            <span className="warn">오류 — {db.message}</span>
          )}
        </li>
      </ul>
      <p className="muted">
        <a href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
