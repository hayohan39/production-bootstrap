import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../scripts/risk/cli.mjs";
import { bandLevel, toAnchor } from "../scripts/risk/levels.mjs";
import { decodeData, previewCell, renderSummary } from "../scripts/risk/render.mjs";
import {
  area,
  categorize,
  classifyStatement,
  globToRegExp,
  isSource,
  parseUnifiedDiff,
  scanChanges,
  sourceRoots,
} from "../scripts/risk/scan.mjs";
import { applyPolicy, finalize, sectionFilled } from "../scripts/risk/score.mjs";

const config = JSON.parse(await readFile(path.resolve(".github/risk/config.json"), "utf8"));

type FileInput = { path: string; status?: string; added?: string[]; removed?: string[]; oldPath?: string };

function scan(
  files: FileInput[],
  opts: { base?: Record<string, string>; head?: Record<string, string>; refs?: string[]; config?: object } = {},
) {
  return scanChanges({
    files: files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath ?? f.path,
      status: f.status ?? "M",
      added: (f.added ?? []).map((text, i) => ({ line: i + 1, text })),
      removed: (f.removed ?? []).map((text) => ({ text })),
      binary: false,
    })),
    readBase: (p: string) => opts.base?.[p] ?? null,
    readHead: (p: string) => opts.head?.[p] ?? null,
    baseReferences: (word: string) => (opts.refs ?? []).includes(word),
    config: opts.config ?? config,
  });
}

const ids = (result: { signals: { id: string }[] }) => result.signals.map((s) => s.id);

describe("levels", () => {
  it("총점 구간", () => {
    expect([0, 20, 21, 40, 41, 60, 61, 80, 81, 100].map(bandLevel)).toEqual([
      "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "VERY_HIGH", "VERY_HIGH", "CRITICAL", "CRITICAL",
    ]);
  });
  it("기준값으로 올림한다", () => {
    expect([0, 3, 5, 12, 16, 25, -1, "x"].map(toAnchor)).toEqual([0, 5, 5, 15, 20, 20, 0, 0]);
  });
});

describe("경로 분류", () => {
  it("glob", () => {
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("src/**/*auth*").test("src/lib/auth.ts")).toBe(true);
    expect(globToRegExp("src/**/*auth*").test("src/app/author/page.tsx")).toBe(false);
    expect(globToRegExp("src/sentry.*.ts").test("src/sentry.server.config.ts")).toBe(true);
  });
  it("범주", () => {
    expect([...categorize(".github/workflows/ci.yml", config)]).toEqual(["infra"]);
    expect(categorize(".github/workflows/pr-review.yml", config).has("riskSystem")).toBe(true);
    expect(categorize("src/app/api/todos/route.ts", config).has("api")).toBe(true);
    expect(categorize("src/lib/db.ts", config).has("sharedCore")).toBe(true);
  });
});

describe("parseUnifiedDiff", () => {
  it("추가/삭제 줄과 줄 번호, 상태를 읽는다", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,1 +10,2 @@",
      "-old",
      "+new1",
      "+new2",
      "diff --git a/migrations/1.sql b/migrations/1.sql",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/migrations/1.sql",
      "@@ -0,0 +1 @@",
      "+create table t (id int);",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: "src/a.ts", status: "M", added: [{ line: 10, text: "new1" }, { line: 11, text: "new2" }] });
    expect(files[1]).toMatchObject({ path: "migrations/1.sql", status: "A" });
    expect(files[2]).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts", status: "R" });
  });
});

describe("SQL 분류", () => {
  const kinds = (sql: string, newTables = new Set<string>()) => classifyStatement(sql, newTables).map((x: { kind: string }) => x.kind);
  it("추가형", () => {
    expect(kinds("create table if not exists todos (id bigint primary key)")).toEqual(["additive"]);
    expect(kinds("alter table users add column nickname text")).toEqual(["additive"]);
    expect(kinds("create index concurrently if not exists i on users (email)")).toEqual(["additive"]);
    expect(kinds("create index i on todos (owner)", new Set(["todos"]))).toEqual(["additive"]);
    expect(kinds("alter table users add constraint c check (x > 0) not valid")).toEqual(["additive"]);
  });
  it("잠금·재작성", () => {
    expect(kinds("create index i on users (email)")).toEqual(["locking"]);
    expect(kinds("alter table users add column plan text not null")).toEqual(["locking"]);
    expect(kinds("alter table users add column created_at timestamptz default now()")).toEqual(["locking"]);
    expect(kinds("alter table users alter column email set not null")).toEqual(["locking"]);
  });
  it("호환성 깨짐·파괴", () => {
    expect(kinds("alter table users rename column email to mail")).toEqual(["breaking"]);
    expect(kinds("alter table users alter column age type bigint")).toEqual(["breaking"]);
    expect(kinds("alter table users drop column email, add column x text")).toEqual(["destructive", "additive"]);
    expect(kinds("drop table if exists sessions")).toEqual(["destructive"]);
    expect(kinds("truncate audit_log")).toEqual(["destructive"]);
    expect(kinds("delete from users")).toEqual(["destructive"]);
    expect(kinds("update users set plan = 'free'")).toEqual(["destructive"]);
    expect(kinds("update users set plan = 'free' where plan is null")).toEqual(["data"]);
  });
  it("이 PR 이 만든 테이블·컬럼에 대한 UPDATE 는 파괴적이지 않다", () => {
    expect(kinds("update todos set owner_id = 1", new Set(["todos"]))).toEqual(["additive"]);
    const cols = new Set(["users.plan_v2"]);
    expect(classifyStatement("update users set plan_v2 = plan", new Set(), cols)).toMatchObject([
      { kind: "data", detail: expect.stringContaining("백필") },
    ]);
    expect(classifyStatement("update users set plan = 'x', plan_v2 = plan", new Set(), cols)[0].kind).toBe("destructive");
  });
  it("권한·트랜잭션·미분류", () => {
    expect(kinds("grant select on users to analyst")).toEqual(["permission"]);
    expect(kinds("alter table users enable row level security")).toEqual(["permission"]);
    expect(kinds("commit")).toEqual(["tx-control"]);
    expect(kinds("do $$ begin perform 1; end $$")).toEqual(["unclassified"]);
  });
});

describe("sourceRoots (앱 소스 위치)", () => {
  // 루트에 app/·lib/ 을 두는 프로젝트(src/ 없음)
  const rootLayout = { ...config, sourceRoots: ["app/", "lib/", "components/", "proxy.ts"] };

  it("기본은 src/ — 설정이 없거나 비어 있어도", () => {
    expect(isSource("src/lib/db.ts", config)).toBe(true);
    expect(isSource("app/page.tsx", config)).toBe(false);
    expect(isSource("src/lib/db.ts", {})).toBe(true);
  });

  it("접두사는 디렉터리, 슬래시가 없으면 그 파일만", () => {
    expect(isSource("app/api/x/route.ts", rootLayout)).toBe(true);
    expect(isSource("proxy.ts", rootLayout)).toBe(true);
    expect(isSource("proxy.tsx", rootLayout)).toBe(false);
    expect(isSource("scripts/migrate.mjs", rootLayout)).toBe(false);
  });

  it("슬래시 없는 디렉터리 이름도 디렉터리로, 잘못된 형식은 바로 알린다", () => {
    expect(sourceRoots({ sourceRoots: ["app", "lib/", "proxy.ts"] })).toEqual(["app/", "lib/", "proxy.ts"]);
    expect(isSource("app/page.tsx", { sourceRoots: ["app"] })).toBe(true);
    expect(isSource("application.ts", { sourceRoots: ["app"] })).toBe(false);
    expect(() => sourceRoots({ sourceRoots: "src/" })).toThrow(/배열/);
  });

  it("영역 이름은 src/ 유무와 상관없이 같은 규칙", () => {
    expect(area("src/app/api/todos/route.ts")).toBe("src/app/api");
    expect(area("src/app/(admin)/page.tsx")).toBe("src/app(root)");
    expect(area("src/lib/db.ts")).toBe("src/lib/db");
    expect(area("app/api/todos/route.ts")).toBe("app/api");
    expect(area("app/(admin)/_actions/usages.ts")).toBe("app/_actions");
    expect(area("lib/leave/summary.ts")).toBe("lib/leave");
    expect(area("lib/db/index.ts")).toBe("lib/db");
    expect(area("proxy.ts")).toBe("proxy");
  });

  it("설정한 위치의 새 환경변수·런타임 변경만 센다", () => {
    const files = [{ path: "lib/mail.ts", added: ["const key = process.env.MAIL_API_KEY;"] }];
    expect(ids(scan(files, { config: rootLayout }))).toEqual(expect.arrayContaining(["config.new-env", "scope.areas"]));
    expect(ids(scan(files))).not.toContain("config.new-env");
  });
});

describe("scanChanges", () => {
  it("문서만 바뀌면 런타임 영향 없음, floor 0", () => {
    const result = scan([{ path: "README.md", added: ["hi"] }, { path: "docs/runbook.md", added: ["x"] }]);
    expect(result.runtimeChanged).toBe(false);
    expect(result.floorTotal).toBe(0);
    expect(result.preliminaryLevel).toBe("LOW");
  });

  it("비밀값은 CRITICAL 이고 값은 결과에 남지 않는다", () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const result = scan([{ path: "src/lib/aws.ts", status: "A", added: [`const k = "${key}";`] }]);
    expect(result.overrideLevel).toBe("CRITICAL");
    expect(result.floors.security).toBe(20);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("추가형 마이그레이션은 Migration 10 이고 등급을 강제로 올리지 않는다", () => {
    const sql = "create table todos (id bigint primary key, title text not null);\ncreate index todos_title on todos (title);";
    const result = scan([{ path: "migrations/20260101_add_todos.sql", status: "A", added: sql.split("\n") }], {
      head: { "migrations/20260101_add_todos.sql": sql },
    });
    expect(result.floors.migration).toBe(10);
    expect(result.overrideLevel).toBe("LOW");
    expect(ids(result)).toContain("migration.additive");
  });

  it("expand 단계: 컬럼 추가 + 백필은 HIGH (파괴적 아님)", () => {
    const sql = "alter table users add column plan_v2 text;\nupdate users set plan_v2 = plan;";
    const result = scan([{ path: "migrations/4.sql", status: "A", added: sql.split("\n") }], { head: { "migrations/4.sql": sql } });
    expect(ids(result)).toEqual(expect.arrayContaining(["migration.additive", "migration.data"]));
    expect(ids(result)).not.toContain("migration.destructive");
    expect(result.overrideLevel).toBe("HIGH");
  });

  it("현재 코드가 쓰는 컬럼을 지우면 CRITICAL", () => {
    const sql = "alter table users drop column email;";
    const result = scan([{ path: "migrations/2_drop.sql", status: "A", added: [sql] }], {
      head: { "migrations/2_drop.sql": sql },
      refs: ["email"],
    });
    expect(ids(result)).toEqual(expect.arrayContaining(["migration.destructive", "migration.referenced"]));
    expect(result.overrideLevel).toBe("CRITICAL");
  });

  it("코드가 더 이상 쓰지 않는 컬럼 삭제는 VERY HIGH (contract 단계)", () => {
    const sql = "alter table users drop column legacy_flag;";
    const result = scan([{ path: "migrations/3.sql", status: "A", added: [sql] }], { head: { "migrations/3.sql": sql } });
    expect(result.overrideLevel).toBe("VERY_HIGH");
  });

  it("이미 있는 마이그레이션을 고치면 VERY HIGH", () => {
    const result = scan([{ path: "migrations/1.sql", status: "M", added: ["x"] }]);
    expect(ids(result)).toContain("migration.edited");
    expect(result.overrideLevel).toBe("VERY_HIGH");
  });

  it("쓰기 API 추가, 핸들러 삭제, 새 환경변수, 테스트 없음", () => {
    const result = scan([
      {
        path: "src/app/api/todos/route.ts",
        added: ["export async function POST(req: Request) {", "  const key = process.env.STRIPE_SECRET_KEY;"],
        removed: ["export async function DELETE() {"],
      },
    ]);
    expect(ids(result)).toEqual(
      expect.arrayContaining(["security.write-endpoint", "compat.endpoint-removed", "config.new-env", "testing.untested", "scope.areas"]),
    );
    expect(result.floors).toMatchObject({ security: 10, compatibility: 15, testing: 10, migration: 10 });
    expect(result.overrideLevel).toBe("HIGH");
  });

  it("SQL 문자열 조합은 HIGH", () => {
    const result = scan([{ path: "src/lib/todos.ts", added: ["  return query(`select * from todos where id = ${id}`);"] }]);
    expect(ids(result)).toContain("security.sql-interpolation");
    expect(result.overrideLevel).toBe("HIGH");
  });

  it("워크플로·리스크 규칙 변경", () => {
    const infra = scan([{ path: ".github/workflows/deploy.yml", added: ["x"] }]);
    expect(infra.overrideLevel).toBe("HIGH");
    expect(infra.floors.scope).toBe(20);
    const self = scan([{ path: "scripts/risk/scan.mjs", added: ["x"] }]);
    expect(self.overrideLevel).toBe("VERY_HIGH");
  });

  it("의존성 추가와 메이저 업그레이드", () => {
    const result = scan([{ path: "package.json", added: ["x"] }], {
      base: { "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }) },
      head: { "package.json": JSON.stringify({ dependencies: { next: "^16.1.0", zod: "^4.0.0" } }) },
    });
    expect(ids(result)).toEqual(expect.arrayContaining(["deps.added", "deps.major"]));
    const patch = scan([{ path: "package.json", added: ["x"] }], {
      base: { "package.json": JSON.stringify({ dependencies: { pg: "^8.23.0" } }) },
      head: { "package.json": JSON.stringify({ dependencies: { pg: "^8.23.1" } }) },
    });
    expect(ids(patch)).toContain("deps.updated");
    expect(patch.floors.security).toBe(5);
    expect(result.floors).toMatchObject({ security: 5, compatibility: 10 });
  });

  it("테스트를 지우거나 skip 하면 Testing 이 오른다", () => {
    const result = scan([
      { path: "test/a.test.ts", removed: ['it("a", () => {})', 'it("b", () => {})'], added: ['it.skip("a", () => {})'] },
    ]);
    expect(ids(result)).toEqual(expect.arrayContaining(["testing.tests-removed", "testing.suppression"]));
    expect(result.floors.testing).toBe(15);
  });
});

const baseScan = () =>
  scan([{ path: "src/app/api/todos/route.ts", added: ["export async function POST() {}"] }]);

const review = (scores: Partial<Record<string, number>>, extra: Record<string, unknown> = {}) => ({
  summary: "할 일 추가 API",
  verdict: "approve",
  findings: [],
  risk: {
    factors: Object.fromEntries(
      ["security", "scope", "compatibility", "testing", "migration"].map((f) => [
        f,
        { score: scores[f] ?? 0, evidence: `${f} 근거`, confidence: "verified" },
      ]),
    ),
    overrides: [],
    drivers: [],
    affected: [],
    mitigations: [],
    unknowns: [],
    ...extra,
  },
});

describe("finalize", () => {
  it("AI 점수가 floor 보다 낮으면 floor 를 쓴다", () => {
    const a = finalize({ scan: baseScan(), review: review({ security: 0, scope: 5 }), sha: "s1" });
    expect(a.factors.security).toMatchObject({ score: 10, llm: 0, floor: 10 });
    expect(a.factors.security.notes[0]).toContain("최저치");
  });

  it("확인 불가(unknown)는 최소 10", () => {
    const r = review({ compatibility: 0 });
    (r.risk.factors as Record<string, { confidence: string }>).compatibility.confidence = "unknown";
    const a = finalize({ scan: baseScan(), review: r, sha: "s1" });
    expect(a.factors.compatibility.score).toBe(10);
  });

  it("근거 없는 AI override 는 버리고, 근거 있는 것은 올린다", () => {
    const r = review({}, {
      overrides: [
        { level: "CRITICAL", condition: "인가 우회", evidence: "" },
        { level: "VERY_HIGH", condition: "보안 경계", evidence: "src/app/api/todos/route.ts:1 인증 없음" },
      ],
    });
    const a = finalize({ scan: baseScan(), review: r, sha: "s1" });
    expect(a.level).toBe("VERY_HIGH");
  });

  it("AI 평가가 없으면 런타임 변경은 최소 MEDIUM", () => {
    const a = finalize({ scan: scan([{ path: "src/lib/x.ts", added: ["a"] }]), review: null, sha: "s1" });
    expect(a.llmAssessed).toBe(false);
    expect(a.level).toBe("MEDIUM");
  });
});

describe("applyPolicy", () => {
  const assessment = (level: string, extra: Record<string, unknown> = {}) => ({
    ...finalize({ scan: baseScan(), review: review({ security: 10 }), sha: "abc" }),
    level,
    ...extra,
  });
  const body = (rollback = "", verify = "") =>
    `## 무엇을\n할 일\n\n## 롤백 계획\n<!-- 안내 -->\n${rollback}\n\n## 배포 후 확인\n${verify}\n`;

  it("섹션이 채워졌는지", () => {
    expect(sectionFilled(body("앱 롤백(rollback.yml)만으로 복구, 스키마 변경 없음"), "롤백 계획")).toBe(true);
    expect(sectionFilled(body("없음"), "롤백 계획")).toBe(false);
    expect(sectionFilled(body(""), "롤백 계획")).toBe(false);
  });

  it("MEDIUM 은 조건 없음", () => {
    expect(applyPolicy(assessment("MEDIUM"), { prBody: "", ciOk: true }).state).toBe("success");
  });

  it("HIGH 는 롤백 계획이 필요", () => {
    const a = assessment("HIGH");
    expect(applyPolicy(a, { prBody: body(), ciOk: true }).state).toBe("failure");
    expect(applyPolicy(a, { prBody: body("이전 배포로 promote, DB 변경 없음"), ciOk: true }).state).toBe("success");
  });

  it("CRITICAL 도 롤백 계획·배포 후 확인만 본다(사람의 수락은 merge 버튼이다)", () => {
    const a = assessment("CRITICAL");
    const filled = body("expand/contract 2단계, 실패 시 pre-deploy 스냅샷 복구", "/api/health 와 가입 흐름 수동 확인");
    expect(applyPolicy(a, { prBody: body(), ciOk: true }).state).toBe("failure");
    const checks = applyPolicy(a, { prBody: filled, ciOk: true });
    expect(checks.state).toBe("success");
    expect(checks.requirements.map((r) => r.id)).toEqual(["rollback", "verify"]);
  });

  it("파괴적 마이그레이션 + 롤백 계획 없음 → CRITICAL", () => {
    const sql = "drop table legacy;";
    const s = scan([{ path: "migrations/9.sql", status: "A", added: [sql] }], { head: { "migrations/9.sql": sql } });
    const a = finalize({ scan: s, review: review({ migration: 20 }), sha: "abc" });
    const checks = applyPolicy(a, { prBody: body(), ciOk: true });
    expect(checks.level).toBe("CRITICAL");
    expect(checks.reasons[0]).toContain("롤백 계획");
  });

  it("CI 실패면 확인 사항으로 남긴다", () => {
    expect(applyPolicy(assessment("LOW"), { prBody: "", ciOk: false }).state).toBe("failure");
  });
});

describe("previewCell", () => {
  it("Vercel 봇처럼 상태·링크·시각을 한 칸에", () => {
    expect(
      previewCell({
        preview: "success",
        deploy: "success",
        previewUrl: "https://a.vercel.app",
        inspectUrl: "https://vercel.com/me/a/dpl",
        migrate: "success",
        smoke: "success",
        previewAt: "2026-10-06T03:06:00Z",
      }),
    ).toBe("✅ Ready · [Preview](https://a.vercel.app) · [Inspect](https://vercel.com/me/a/dpl) · 마이그레이션 ✅ · 스모크 ✅ · 10/6 12:06 KST");
    expect(previewCell({ preview: "skipped" })).toBe("⏭️");
  });
});

describe("renderSummary", () => {
  it("결론이 첫 줄에 있고 데이터가 왕복된다", () => {
    const a = finalize({ scan: baseScan(), review: review({ security: 10, scope: 10, testing: 10, migration: 5 }), sha: "abcdef1234" });
    const checks = applyPolicy(a, { prBody: "", ciOk: true });
    const ci = { test: "success", preview: "success", previewUrl: "https://x-y.vercel.app", ok: true };
    const text = renderSummary({ assessment: a, checks, ci, previous: { sha: "000", total: 30, level: "MEDIUM" } });
    const lines = text.split("\n");
    expect(lines[0]).toBe("<!-- pr-summary -->");
    expect(lines[1]).toContain(`Risk ${a.total}/100`);
    expect(lines[2]).toContain("이전 커밋 30");
    expect(decodeData(text).assessment.total).toBe(a.total);
  });
});

describe("runScan (실제 git)", () => {
  let dir: string;
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "risk-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await mkdir(path.join(dir, "src/lib"), { recursive: true });
    await mkdir(path.join(dir, "migrations"));
    await mkdir(path.join(dir, ".github/risk"), { recursive: true });
    await writeFile(path.join(dir, ".github/risk/config.json"), JSON.stringify(config));
    await writeFile(path.join(dir, "src/lib/users.ts"), 'export const q = "select email from users where id = $1";\n');
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    await writeFile(path.join(dir, "migrations/20260101_drop_email.sql"), "alter table users drop column email;\n");
    git("add", "-A");
    git("commit", "-qm", "drop email");
  });

  afterAll(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("main 의 코드가 쓰는 컬럼 삭제를 CRITICAL 로 잡고 파일을 남긴다", async () => {
    process.chdir(dir);
    const { scan: result } = runScan({ base: "main", head: "feature", out: path.join(dir, ".review") });
    process.chdir(cwd);
    expect(result.overrideLevel).toBe("CRITICAL");
    const facts = await readFile(path.join(dir, ".review/facts.md"), "utf8");
    expect(facts).toContain("migration.referenced");
    expect(await readFile(path.join(dir, ".review/pr.diff"), "utf8")).toContain("drop column email");
  });
});
