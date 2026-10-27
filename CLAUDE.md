@AGENTS.md

<!-- template-only:start -->
> **여기는 템플릿 리포지토리(production-bootstrap)다.** 아래 내용은 이 템플릿으로 만든
> 프로젝트용이다. 템플릿 자체를 고칠 때는 `docs/bootstrap/MAINTAINING.md` 를 먼저 읽는다.
> 새 프로젝트를 만들어 달라는 요청이면 `new-project` 스킬을 따른다.
<!-- template-only:end -->

# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

**실제 사용자가 쓰는 프로덕션 서비스다.** 리포지토리 주인(이하 "사용자")은 Claude 세션에서 개발을 요청하고,
GitHub 에서 PR 종합 코멘트(CI · 코드 리뷰 · Risk Score)를 보고 merge 할지 더 고칠지 정한다.
커밋과 PR 은 Claude 가 만든다. merge 는 곧 프로덕션 배포다.

## 역할 분담

| 누가 | 무엇을 |
| --- | --- |
| 사용자 | 요청 · PR 판단 · **merge** · CRITICAL 변경의 `risk-accepted` 수락 · 비밀값/요금제 설정 |
| Claude (세션) | 브랜치 → 구현 → 로컬 검증 → 커밋 → push → **PR 생성** → CI·리뷰·Risk 결과 보고 → 지적 사항 수정 |
| GitHub Actions | CI · auto-fix · PR 프리뷰(프로덕션 복제 DB) · AI 리뷰 + Risk Score · merge 후 스냅샷 → 마이그레이션 → 스테이징 → 승격 → 자동 롤백 |

## 개발 요청을 받으면

1. **main 에서 새 브랜치**를 딴다: `claude/<짧은-설명>` (세션이 브랜치를 정해 줬으면 그걸 쓴다).
   `git fetch origin main` 후 최신 main 기준으로 시작한다.
2. 요청이 모호하거나 **인프라/비용/외부 서비스/개인정보 처리가 새로 필요한** 결정이면 구현 전에 먼저
   묻는다(아래 "인프라 결정"). 그 외에는 합리적으로 판단해 진행하고 PR 에 적는다.
3. 구현한다. **한 PR 에 한 목적.** 무관한 리팩터링은 하지 않는다. 위험한 변경(스키마 삭제·이름 변경,
   인증, 공통 모듈)은 작게 나눈다 — Risk 등급이 낮은 PR 여러 개가 CRITICAL 하나보다 낫다.
4. **push 전에 diff 를 스스로 다듬는다**: `.github/review/quality.md` 기준(덧붙임·재사용·단순화·일관성·빈틈)으로
   `git diff origin/main...HEAD` 를 한 번 훑는다. 세션에 `/simplify` 스킬이 있으면 그걸 써도 된다.
   CI 뒤의 품질 리뷰는 안전망이다 — 거기서 지적이 적을수록 좋다.
   그리고 **반드시** `npm run check` (lint → typecheck → test → build) 를 통과시킨다.
   DB 를 건드렸으면 로컬 Postgres 에 `npm run migrate` 도 돌려 본다(아래 참고).
5. **예상 Risk 를 먼저 본다**: `node scripts/risk/cli.mjs scan --base origin/main --head HEAD`
   (규칙 기반 최저치만 나온다. 최종 점수는 CI 뒤 AI 리뷰가 더한다.) HIGH 이상이 나올 변경이면
   PR 본문의 **롤백 계획**, VERY HIGH 이상이면 **배포 후 확인**까지 구체적으로 쓴다.
6. 커밋 메시지는 Conventional Commits, 제목은 한국어 가능: `feat: 할 일 목록 추가`.
7. push 후 **PR 을 만든다**. 본문은 `.github/pull_request_template.md` 형식으로 파일에 쓰고:
   `node scripts/gh.mjs pr-create --title "feat: ..." --body-file /tmp/pr.md`
   빈 섹션을 남기지 않는다. 사용자는 휴대폰으로 본다 — 첫 줄에서 무엇이 바뀌는지 알 수 있게.
8. `node scripts/gh.mjs pr-watch` 로 CI 와 PR 리뷰(risk-gate)가 끝날 때까지 기다린 뒤 두세 줄로 보고한다:
   CI 결과 · 리뷰 판정과 주요 지적 · **Risk 등급/점수와 merge 게이트 상태** · 프리뷰 링크.
   - 리뷰 finding(blocker/major)은 같은 브랜치에서 고쳐 push 한다. 고치지 않을 것은 이유를 PR 에 쓴다.
   - 게이트가 막혔으면 무엇이 필요한지(롤백 계획, 배포 후 확인, 사람의 수락) 정확히 알린다.
9. **merge 하지 않는다.** 사용자가 요청해도 "PR 에서 merge 버튼을 눌러 주세요" 라고 안내한다.

PR 이 이미 열려 있는 브랜치에서 추가 요청을 받으면 같은 브랜치에 커밋을 더한다.
그 전에 `git pull origin <브랜치>` — CI 가 `[claude-refine]`·`[claude-autofix]` 커밋을 더했을 수 있다.
품질 리뷰 코멘트(🧹)의 **제안**을 사용자가 반영해 달라고 하면 같은 브랜치에서 고친다.

### Risk Score 를 대하는 태도

- 기준은 `.github/risk/rubric.md`. Risk 는 품질 점수가 아니라 "프로덕션에서 잘못되면 얼마나 아픈가" 다.
- **점수를 낮추려고 위험을 숨기지 않는다.** SQL 을 쪼개 스캐너를 피하거나, 테스트를 형식적으로 추가하거나,
  PR 본문에 확인하지 않은 주장을 쓰지 않는다. 진짜로 위험을 줄이는 방법(작게 나누기, expand/contract,
  테스트, 기능 플래그)만 쓴다.
- `risk-accepted` 라벨, `risk:*` 라벨, PR 리뷰 상태는 **절대 건드리지 않는다.** 수락은 사람의 몫이다.
- `.github/risk/*`, `scripts/risk/*`, `.github/workflows/pr-review.yml`, `risk-gate.yml` 을 바꾸는 것은
  평가 기준 자체를 바꾸는 일이다. 사용자가 명시적으로 요청했을 때만 하고, 별도 PR 로 한다.

> **GitHub CLI 주의**: 클라우드 세션의 GitHub 프록시는 GraphQL 을 막는다. `gh pr create`,
> `gh pr list/checks/view`, `gh workflow run` 은 403 이 난다. `scripts/gh.mjs`(REST)나
> `gh api repos/{owner}/{repo}/...`, `gh run list/view` 를 쓴다. 세션이 PR 생성 도구를
> 따로 제공하면 그걸 써도 된다. `gh` 가 없으면 세션 시작 훅이 설치를 시도한다.

## 개발 상황을 물으면

`project-status` 스킬을 따른다. 열린 PR 과 각 CI·리뷰·**Risk 등급/게이트**, 최근 배포(롤백 여부 포함),
`docs/decisions.md` 의 미결 항목을 짧게 정리하고 다음에 할 일을 제안한다.

## 장애·롤백 요청을 받으면

`docs/runbook.md` 를 따른다. **먼저 복구, 원인은 나중.** 앱 문제면 Rollback 워크플로
(`node scripts/gh.mjs dispatch rollback.yml reason="..."`)로 직전 배포로 되돌리고, 그다음 원인을 고치는 PR 을 올린다.
DB 복구(스냅샷/PITR)는 데이터에 영향이 크므로 절차를 설명하고 사용자의 결정을 받는다.

## 파이프라인 (건드리기 전에 이해할 것)

```
PR 생성/push ─► ci.yml
                 ├ test     마이그레이션 append-only 확인 · lint · typecheck · test · 빈 Postgres 마이그레이션 · build
                 ├ preview  Neon 브랜치(프로덕션 복제)에 마이그레이션 → Vercel 프리뷰 → 스모크 테스트
                 ├ refine   위가 통과하면 Claude 품질 리뷰 → 작은 정리는 [claude-refine] 커밋, 큰 것은 제안 (PR 당 1회 — `quality-reviewed` 라벨)
                 └ autofix  위가 실패하면 Claude 가 고쳐서 [claude-autofix] 커밋 (PR 당 최대 3회)
             ─► risk-gate.yml (pull_request_target)  새 커밋이면 risk-gate 를 "대기" 로
CI 완료 ─► pr-review.yml (workflow_run, main 의 코드로 실행)
                 ├ scan     규칙 기반 스캔 → factor 최저치 · hard override
                 ├ review   Claude 리뷰 + Risk factor 점수 (CI 통과 시)
                 └ report   PR 종합 코멘트 · risk:* 라벨 · risk-gate 상태
라벨/본문 변경 ─► risk-gate.yml  게이트만 다시 계산 (risk-accepted 는 관리자 사람만)
PR 코멘트 @claude ─► claude-mention.yml  지시대로 수정
merge ─► ci.yml 의 test (merge 결과물을 한 번 더, 항상 전체 — 브랜치 보호가 "최신 main 포함" 을 요구하지 않아서)
      ─► 통과하면 deploy.yml  DB 스냅샷 → 마이그레이션 → 스테이징 배포 → 스모크 → promote → 헬스체크 → (실패 시) 자동 롤백
                              (문서만 바뀐 merge 는 배포하지 않음. test 가 실패하면 배포하지 않음)
수동 ─► rollback.yml  직전 성공 배포로 되돌리기
PR 닫힘 ─► preview-cleanup.yml  Neon 프리뷰 브랜치 삭제
```

- 워크플로를 고칠 때는 그 이유를 PR 에 적는다. 시크릿 값을 로그에 찍지 않는다.
- Vercel 프로젝트는 Git 에 연결하지 않는다. 배포는 deploy.yml 만 한다(마이그레이션 → 배포 순서 보장).
- `vercel.json` 의 `regions` 는 Neon 리전과 맞춘다(기본 `sin1` ↔ `aws-ap-southeast-1`). 어긋나면 쿼리마다 대륙을 건넌다.

## 스택

- Next.js (App Router, `src/app`) + TypeScript. **AGENTS.md 경고대로** 이 Next.js 버전은
  학습 데이터와 다를 수 있다. 새 API 를 쓰기 전에 `node_modules/next/dist/docs/` 를 확인한다.
  (예: 미들웨어 파일은 `src/proxy.ts`, `global-error` 의 재시도 prop 은 `retry`.)
- DB: Neon Postgres. 드라이버는 `pg` (`src/lib/db.ts` 의 `query()`). ORM 은 없다.
- 관측: Sentry(`@sentry/nextjs`, DSN 이 있을 때만 동작), 구조화 로그 `src/lib/log.ts`, `/api/health`.
- 테스트: Vitest (`test/**/*.test.ts`). 스타일은 기본 CSS(`globals.css`).
- Node 24 (`.nvmrc`, `engines`). 확정된 인프라와 이유는 `docs/decisions.md`.

## 데이터베이스 규칙

- 스키마 변경은 **반드시** `migrations/` 의 SQL 파일로. `npm run migrate:new -- <이름>` 으로 만든다.
- **이미 main 에 들어간 마이그레이션 파일은 절대 수정하지 않는다.** CI 와 러너가 막는다.
- **배포 중·롤백 후에는 이전 버전 코드가 새 스키마 위에서 돈다.** 그래서 expand → contract:
  1. 추가만 하는 PR(새 컬럼은 nullable 또는 상수 DEFAULT) → 2. 코드가 새 구조를 읽고 쓰게 하는 PR
  (필요하면 백필) → 3. 옛 컬럼을 지우는 PR(코드가 더 이상 안 쓴 뒤). 현재 코드가 쓰는 이름을
  지우거나 바꾸면 Risk 가 CRITICAL 이 된다.
- 러너는 `lock_timeout` 5초로 돈다. 큰 테이블 인덱스는 파일 맨 위에 `-- migrate:no-transaction` 을 쓰고
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` **한 문장만** 담는다.
- 데이터 백필은 한 번에 전체 UPDATE 하지 말고 범위를 나눠(`where id between ...`) 여러 번에 걸쳐 한다.
- 파괴적 변경(삭제, 되돌릴 수 없는 변환)은 PR 본문 "롤백 계획" 에 복구 방법(스냅샷 브랜치·PITR)을 쓴다.
- SQL 은 항상 파라미터 바인딩(`$1`). 문자열로 조합하지 않는다.
- 로컬 검증: 세션에 Postgres 가 있으면 시작 훅이 `TEST_DATABASE_URL` 을 설정한다.
  `DATABASE_URL=$TEST_DATABASE_URL npm run migrate`. `npm test` 도 이 값이 있으면 DB 테스트를 함께 돌린다.

## 보안·개인정보

- 쓰기 API(route handler 의 POST/PUT/PATCH/DELETE, 서버 액션)는 **인증·권한 확인 없이 열지 않는다.**
  인증 방식이 아직 정해지지 않았으면(`docs/decisions.md` 미결) 먼저 묻는다.
- 외부 입력은 경계에서 검증한다(타입·길이·형식). 에러 메시지에 내부 정보(SQL, 연결 문자열)를 노출하지 않는다.
- 로그·Sentry 로 개인정보(이메일, 전화번호, 토큰, 요청 본문 전체)를 보내지 않는다. `log` 는 민감한 키를 가리지만
  그것에 기대지 말고 애초에 넣지 않는다.
- 프리뷰 DB 는 **프로덕션 데이터 복제본**이다. 프리뷰 URL 을 외부에 공유하지 않는다(Vercel 배포 보호를 끄지 않는다).

## 환경변수와 비밀값

- 비밀값을 커밋하지 않는다. `.env*` 는 gitignore 되어 있고 Claude 는 읽지 않는다.
- 새 환경변수는 `src/lib/env.ts` 의 `ENV_DOCS` 에 이름·용도·발급처를 적고 `requireEnv`/`optionalEnv` 로 읽는다.
  PR 본문 "배포 영향" 에 적는다. **merge 전에** 사용자가 Vercel 에 값을 넣어야 한다(없으면 배포 후 장애).
  Claude 가 대신 설정할 수단이 있어도 먼저 묻는다.
- 이미 있는 것: `DATABASE_URL`(pooled) / `DATABASE_URL_UNPOOLED`(direct) / `SENTRY_DSN` · `NEXT_PUBLIC_SENTRY_DSN`(선택).

## 인프라 결정

Vercel(호스팅), Neon(DB), Sentry(오류 추적), GitHub Actions(CI/CD)는 고정이다(`docs/decisions.md`).
그 밖의 것(인증, 파일 저장소, 크론/큐, 이메일, 결제, 캐시, 외부 API)이 필요해 보이면:

1. 구현 전에 선택지 2~3개를 **비용·운영 부담·락인·개인정보/보안**으로 짧게 비교해 제안하고 결정을 받는다.
   Vercel 마켓플레이스/내장 기능(Cron, Blob, Firewall)을 먼저 검토한다.
2. 결정되면 `docs/decisions.md` 에 기록한다(날짜, 결정, 이유, 대안, 비용, 되돌리는 법).
3. 계정 가입·키 발급·요금제 변경처럼 사용자만 할 수 있는 일은 체크리스트로 알려 준다.

## 코드 규칙

- 경로는 `path.join`, 임시 디렉터리는 `os.tmpdir()`. npm scripts 에 POSIX 전용 문법 금지.
- 테스트를 지우거나 skip 해서 통과시키지 않는다. `eslint-disable` / `@ts-ignore` 로 덮지 않는다.
- 바뀐 동작에는 그 동작을 검증하는 테스트를 같은 PR 에 넣는다(Risk 의 Testing factor).
- 로그는 `console.log` 대신 `src/lib/log.ts` 의 `log`.
- 사용자에게 보이는 문구는 한국어가 기본.

## 명령

```bash
npm run dev             # 로컬 개발
npm run check           # lint + typecheck + test + build (push 전 필수)
npm run migrate:new -- add-todos
npm run migrate         # DATABASE_URL 대상
npm run migrate:status
node scripts/risk/cli.mjs scan --base origin/main --head HEAD   # 예상 Risk (규칙 기반)
node scripts/gh.mjs pr-list      # 열린 PR + CI + Risk (pr-create / pr-status / pr-watch / deploys / risk-history)
node scripts/gh.mjs dispatch rollback.yml reason="..."           # 앱 롤백
```
