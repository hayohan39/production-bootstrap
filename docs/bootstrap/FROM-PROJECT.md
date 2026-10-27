# project-bootstrap 에서 전환하기

[project-bootstrap](https://github.com/hayohan39/project-bootstrap)(개인용)으로 만든 프로젝트를 이 템플릿의 운영 흐름
(Risk Score · merge 게이트 · 스냅샷 → 스테이징 → 승격 → 자동 롤백 · 관측)으로 옮기는 절차.

두 템플릿은 스택이 같다(Next.js + Neon + Vercel, `pg`, 같은 마이그레이션 러너). 그래서 **앱 코드는 거의 그대로**이고
바뀌는 것은 CI/CD·리뷰·운영 장치다. 실제 사례: happy-holiday 가 PR 하나(약 50개 파일, 대부분 복사)로 전환했고
Vercel Hobby + Neon Free 에서 이 흐름을 그대로 돌리고 있다.

> 이 문서는 템플릿 전용(`docs/bootstrap/`)이라 새 프로젝트로 복사되지 않는다. 전환할 프로젝트의 세션에서
> 이 리포지토리를 함께 열고(`add_repo`) "production-bootstrap 으로 전환해줘 — FROM-PROJECT.md 대로" 라고 요청한다.

## 1. 전환할 때인가

하나라도 해당하면 전환을 검토한다.

- 나 말고 실제 사용자가 있다(직원, 고객, 베타 사용자).
- 데이터를 잃거나 잘못 바꾸면 되돌리기 어렵다(금융·인사·개인정보).
- merge 하고 나서 "배포가 깨졌는데 내가 못 보고 있었다" 가 문제가 된다.
- 돈을 받거나 받을 예정이다 → Vercel Hobby 는 상업적 이용 금지이므로 이때는 Pro 로 올린다.

해당하지 않으면 project-bootstrap 그대로가 낫다(리뷰 비용·절차가 적다).

## 2. 무엇이 바뀌나

| | 전환 전 (project) | 전환 후 (production) |
| --- | --- | --- |
| PR 리뷰 | `claude-review.yml` — PR 열 때 1회 | `pr-review.yml` — CI 뒤 push 마다, **Risk Score 0–100** + `risk:*` 라벨 |
| merge 게이트 | 사람이 누르는 것뿐 | 브랜치 규칙: `test` + `risk-gate` 필수, CRITICAL 은 관리자 `risk-accepted` |
| 배포 | 마이그레이션 → 프로덕션 배포 → 헬스체크 | **DB 스냅샷** → 마이그레이션(`lock_timeout`) → 도메인 없이 배포 → **스모크** → **승격** → 헬스체크 → 실패 시 **자동 롤백** |
| 복구 | Vercel 대시보드에서 수동 | `rollback.yml`, 스냅샷 브랜치, PITR, `docs/runbook.md` |
| 관측 | `/api/health` | + Sentry(DSN 있을 때만), 구조화 로그 `src/lib/log.ts` |
| 앱 기본값 | — | 보안 헤더, 쿼리 타임아웃, `src/lib/env.ts`(환경변수 검증) |
| 의존성 | 수동 | 수동(세션에서 요청) + 보안 알림(Dependabot alerts) |

**DB 는 그대로 쓴다.** 마이그레이션 러너가 같은 `schema_migrations` 테이블과 같은 체크섬을 쓰므로 이미 적용된 이력이
그대로 이어진다. 전환 후 달라지는 것은 `lock_timeout 5s`·`statement_timeout 5min` 이 걸리고, CI 가 main 에 있는
마이그레이션 파일 수정을 막고(append-only), `-- migrate:no-transaction` 지시어를 쓸 수 있다는 것뿐이다.

## 3. 사용자가 먼저 할 일

전환 PR 을 merge 하기 **전에** 해 둔다(없으면 merge 직후 배포나 스모크가 실패한다).

- [ ] **Vercel 배포 보호 우회 키**: Vercel 프로젝트 → Settings → Deployment Protection →
      **Protection Bypass for Automation** → 생성. 값을 GitHub 리포지토리 시크릿 `VERCEL_AUTOMATION_BYPASS_SECRET` 으로 넣는다.
      (deploy.yml 의 스모크 테스트가 도메인 연결 전 배포를 이 값으로 연다. 새 프로젝트는 provision 이 자동으로 만든다.)
- [ ] **Claude 시크릿 확인**: `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN` 이 이미 있다. 리뷰가 push 마다 돌아
      사용량이 늘어난다 — API 키라면 콘솔에서 월 한도를 걸어 둔다.
- [ ] (선택) **Sentry**: 프로젝트를 만들고 Vercel 환경변수(Production)에 `SENTRY_DSN`·`NEXT_PUBLIC_SENTRY_DSN`.
      소스맵 업로드까지 하려면 `SENTRY_AUTH_TOKEN`·`SENTRY_ORG`·`SENTRY_PROJECT`. 없으면 꺼진 채로 동작한다.
- [ ] (선택) **요금제**: 상업적 이용이면 Vercel Pro. PITR 보존 기간이 필요하면 Neon Launch. 비공개 리포에 merge 게이트를
      강제하려면 GitHub Pro(아래 6번). 근거는 [SETUP.md](SETUP.md) 0번, [STACK.md](STACK.md).
- [ ] (선택) 변수: `CLAUDE_REVIEW_MODEL`·`CLAUDE_REVIEW_MODEL_HIGH`(리뷰 모델), `PREDEPLOY_SNAPSHOTS`(기본 3) — [SETUP.md](SETUP.md) 4번.

이미 있는 것은 그대로 쓴다: `DATABASE_URL`, `VERCEL_TOKEN`, `NEON_API_KEY`, `BOT_PAT`, 변수 `NEON_PROJECT_ID`·`VERCEL_PROJECT_ID`·`VERCEL_ORG_ID`.

## 4. Claude 가 하는 일 — 전환 PR

브랜치 `claude/production-bootstrap` 하나에 담는다. 파일은 이 템플릿의 main 에서 가져온다.

**그대로 복사** (프로젝트에 같은 이름이 없다)

- `.github/workflows/pr-review.yml`, `risk-gate.yml`, `rollback.yml`
- `.github/risk/`(rubric·config·review-prompt·review-schema), `.github/dependabot.yml`
- `scripts/risk/`, `scripts/release.mjs`, `scripts/smoke.mjs`
- `src/lib/env.ts`, `src/lib/log.ts`, `src/lib/sentry.ts`, `src/instrumentation.ts`, `src/instrumentation-client.ts`,
  `src/sentry.server.config.ts`, `src/sentry.edge.config.ts`, `src/app/global-error.tsx`
- `docs/runbook.md`
- 테스트: `test/risk.test.ts`, `test/release.test.ts`, `test/env.test.ts`, `test/log.test.ts`

**템플릿 버전으로 바꾸고 프로젝트 고유 수정을 다시 얹는다** (먼저 `git diff` 로 그 프로젝트가 템플릿에서 바꾼 부분을 확인한다)

- `.github/workflows/ci.yml`, `deploy.yml`, `claude-mention.yml`, `preview-cleanup.yml`
- `.github/pull_request_template.md`(롤백 계획·배포 후 확인 섹션이 생긴다 — risk-gate 가 읽는다), `.github/review/quality.md`
- `scripts/gh.mjs`, `scripts/migrate.mjs`, `scripts/neon.mjs`, `scripts/preview-comment.mjs` 와 그 테스트(`test/migrate.test.ts`, `test/preview-comment.test.ts`)
- `.claude/skills/project-status/SKILL.md`
- `CLAUDE.md` — 템플릿의 운영 규칙(Risk 를 대하는 태도, expand → contract, 보안·개인정보, 장애·롤백)으로 바꾸고,
  프로젝트 설명·도메인 규칙·비용 규칙 같은 **프로젝트 고유 절**은 그대로 옮긴다.

**손으로 합친다** (앱 쪽, 작은 차이)

- `next.config.ts` — 보안 헤더, `poweredByHeader: false`, `withSentryConfig` 감싸기. 앱에 이미 있는 설정은 지키고,
  외부 리소스를 쓰는 앱이면 헤더(`X-Frame-Options` 등)가 막지 않는지 본다.
- `vercel.json` — `installCommand: "npm ci"`, `regions` 를 Neon 리전과 맞춘다(`aws-ap-southeast-1` ↔ `sin1`).
- `src/lib/db.ts` — `requireEnv`, `connectionTimeoutMillis`·`query_timeout`. 15초를 넘는 쿼리가 있으면 먼저 확인한다.
- `src/lib/health.ts` — `APP_COMMIT_SHA` 우선(스모크가 새 커밋인지 이 값으로 본다).
- `package.json` — `@sentry/nextjs` 추가(`npm install`, lock 은 도구로 갱신).
- `.gitignore` — `.review/`(PR 리뷰가 만드는 임시 파일. 커밋되면 diff 전체가 리포에 남는다).
- `docs/decisions.md` — "운영 흐름 전환" 항목(날짜, 이유, 되돌리는 법)과 미결 항목(오류 추적·CSP).

**지운다**: `.github/workflows/claude-review.yml` (pr-review.yml 이 대신한다).

**가져오지 않는다**(템플릿 전용): `new-project.yml`, `scripts/provision.mjs`, `scripts/init-project.mjs`, `test/template/`,
`docs/bootstrap/`, `.claude/skills/new-project/`.

**라벨**: `risk:low`·`risk:medium`·`risk:high`·`risk:very-high`·`risk:critical`·`risk-accepted`·`no-autofix`·`no-refine`
을 만든다(`gh api repos/{owner}/{repo}/labels` — 이름·색은 `scripts/provision.mjs` 의 `LABELS`). 라벨 정의를 만드는 것이고
PR 에 붙이거나 떼는 것이 아니다.

push 전: `npm run check`, `actionlint`, 로컬 Postgres 에 `npm run migrate`(기존 마이그레이션이 새 러너에서 그대로 도는지),
`node scripts/risk/cli.mjs scan --base origin/main --head HEAD`.

PR 본문의 "배포 영향" 에 3번 체크리스트(사용자가 넣어야 할 시크릿)를 적는다.

### 전환 PR 자체에서 볼 수 없는 것

- **Risk Score 가 붙지 않는다.** `pr-review.yml` 은 main 에 있는 버전만 실행되는데, main 에는 아직 없다.
  이 PR 은 기존 `claude-review.yml` 이 리뷰한다. Risk 는 전환 뒤 다음 PR 부터.
- **품질 리뷰(refine)가 건너뛴다.** `ci.yml` 을 바꾸는 PR 이라 정상이다.
- 그래서 이 PR 은 diff 를 사람이 한 번 훑고 merge 한다. 앱 코드 변경은 위 "손으로 합친다" 뿐이다.

## 5. merge 뒤 확인

- [ ] Deploy 가 초록: 스냅샷 → 마이그레이션 → 스테이징 배포 → 스모크 → 승격 → 헬스체크 순으로 돈다.
      스모크가 401/403 이면 `VERCEL_AUTOMATION_BYPASS_SECRET` 이 없거나 틀렸다.
- [ ] `https://<도메인>/api/health` 의 `commit` 이 merge 커밋 7자리.
- [ ] 아무 작은 PR 을 올려 **PR 종합 코멘트**(CI · 리뷰 · Risk), `risk:*` 라벨, `risk-gate` 체크가 붙는지 본다.
- [ ] 그 PR 에서 `@claude` 로 작은 수정을 시켜, Claude 커밋에도 품질 리뷰와 AI 리뷰가 붙는지 본다
      ("결과를 남기지 못했습니다"·"AI 리뷰 없음" 이면 [DESIGN.md](DESIGN.md) 4번의 `allowed_bots`).
- [ ] (선택) Rollback 워크플로를 한 번 돌려 직전 배포로 돌아가는지 보고, 다시 최신으로 배포한다.

## 6. 마지막으로 merge 게이트

위 확인에서 `risk-gate` 체크가 한 번 이상 보고된 뒤에 브랜치 규칙을 건다(먼저 걸면 아직 없는 체크를 기다리느라 PR 이 막힌다).
절차는 [SETUP.md](SETUP.md) 5번 — 필수 체크 `test`, `risk-gate`. 비공개 리포는 GitHub Pro 가 필요하다. 그 전까지
`risk-gate` 는 표시만 되고 merge 를 막지 못한다.

## 되돌리기

전환 PR 을 revert 하면 이전 흐름으로 돌아간다. DB 스키마·데이터는 바꾸지 않았고, 새로 생긴 것(배포 전 스냅샷 브랜치,
라벨, 시크릿)은 남아도 해가 없다 — 정리하려면 Neon 콘솔에서 `pre-deploy/*` 브랜치를 지운다.
