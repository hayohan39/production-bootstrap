# 설계 근거

production-bootstrap 의 구조를 정한 이유들. 개인용 템플릿 project-bootstrap 에서 이어받은 것(1~5)과
운영용으로 더한 것(6~10)으로 나뉜다. 스택 선택 이유는 [STACK.md](STACK.md).

## 1. 리포지토리 생성은 Actions 가 한다

Claude 클라우드 세션(웹·모바일)의 GitHub 접근은 전용 프록시를 거친다. 설정으로 풀 수 없다.

| 제약 | 내용 |
| --- | --- |
| GraphQL 차단 | `gh repo create`, `gh pr create/list/checks/view`, `gh workflow run` 이 GraphQL 을 써서 403 |
| 리포지토리 스코프 | API 요청은 세션에 붙은 리포지토리에만 닿는다. `POST /user/repos` 도 막힌다 |
| 설정 쓰기 차단 | 리포지토리 설정 변경(템플릿 지정 등), Actions 시크릿/변수 읽기·쓰기 불가 |

그래서 새 리포지토리는 `new-project.yml` 이 `BOOTSTRAP_PAT`(classic, `repo` + `workflow`)으로 만들고,
세션 안의 GitHub 작업은 REST(`scripts/gh.mjs`)로 한다.

## 2. DB 는 Neon, 연결 문자열은 두 개

| 이름 | 어디 | 누가 씀 | 종류 |
| --- | --- | --- | --- |
| `DATABASE_URL` (GitHub 시크릿) | 프로젝트 리포지토리 | deploy.yml 의 마이그레이션 | direct |
| `DATABASE_URL` (Vercel env, Production) | Vercel 프로젝트 | 앱 런타임 | pooled (`-pooler`) |
| `DATABASE_URL_UNPOOLED` (Vercel env) | Vercel 프로젝트 | 앱 안에서 세션 기능이 필요할 때 | direct |

- 마이그레이션 러너는 세션 advisory lock 을 쓰므로 PgBouncer(transaction 모드)를 거치면 안 된다.
- 앱의 쿼리 타임아웃은 `query_timeout`(클라이언트 쪽)으로 건다. `statement_timeout` 을 연결 옵션으로 주면
  시작 파라미터로 전송되어 PgBouncer 가 거부할 수 있다.
- Neon 콘솔의 GitHub/Vercel 연동은 켜지 않는다. 같은 값을 두 곳에서 관리하게 된다.
- Personal API 키를 쓴다. project-scoped 키로는 프로젝트를 만들 수 없다.

## 3. 배포 순서는 워크플로가 쥔다

- Vercel 프로젝트를 Git 에 연결하지 않는다(`vercel.json` 의 `git.deploymentEnabled: false` 는 안전장치).
  연결하면 merge 순간 Vercel 이 바로 배포해 마이그레이션보다 앞설 수 있다.
- 필요한 값이 없으면 실패가 아니라 건너뜀. 프로비저닝 전에 merge 했다는 이유로 main 이 빨간불이 되면 안 된다.
- 빌드는 Vercel 원격 빌드. Actions 사용 시간을 아낀다.

## 4. auto-fix

- `GITHUB_TOKEN` 으로 push 한 커밋은 워크플로를 트리거하지 않는다. Claude GitHub App 토큰 또는 `BOT_PAT` 이 필요하다.
- 무한 루프 방지: PR 브랜치의 `[claude-autofix]` 커밋 수(기본 3).
- **운영용 추가 제한**: 도구를 허용 목록으로 좁혔다(`npm`·`node`·`git`·`gh pr comment`, 파일 편집).
  `.github/` 와 `scripts/risk/` 는 편집 금지, 라벨·PR 상태를 바꾸는 명령은 쓸 수 없다.

## 4-1. 품질 리뷰 (refine)

CI 가 통과하면 Claude 가 `.github/review/quality.md` 기준(덧붙임·재사용·단순화·일관성·빈틈)으로 PR 을 한 번 더 본다.
PR 리뷰(버그·보안·Risk)와 목적이 다르다 — "동작하는 코드를 얼마나 깔끔하게 짰나".

- **동작이 바뀌지 않는 국소적 정리만** 자동 반영한다(`npm run check` 통과 필수, 실패하면 되돌리고 제안으로).
  여러 파일·공개 인터페이스·테스트 추가는 제안 코멘트로만 남기고 사람이 `@claude` 로 지시한다.
- 반복 방지: HEAD 가 이미 `[claude-refine]` 커밋이면 건너뛴다(`REFINE_MAX_ROUNDS`, 기본 1).
- `migrations/`, `.github/`, `scripts/risk/` 는 네 겹으로 막는다: 프롬프트, 편집 도구(Edit·Write) 차단, pre-push 훅,
  사후 검사(`[claude-refine]` 또는 claude[bot] 커밋이 건드렸으면 🧹 코멘트에 경고하고 job 을 실패시킨다).
  pre-push 훅은 커밋 제목의 `[claude-refine]` 도 강제한다(빠지면 반복 방지가 안 된다).
  완전한 차단은 아니다: `npm run check` 가 PR 코드를 실행하는 이상 의도적 우회는 가능하다.
  마지막 방어선은 그 커밋도 다시 거치는 CI · 리뷰와 사람의 merge 다.
- push 는 마지막에 한 번. `ci.yml` 의 concurrency 가 push 직후 이 실행을 취소하므로 리포트를 먼저 쓰고,
  리포트 게시는 `always()` 라 취소돼도 올라간다.
- `ci.yml` 을 바꾸는 PR 에서는 건너뛴다 — claude-code-action 은 App 토큰을 받을 때 실행 중인 워크플로가
  기본 브랜치와 같은지 검사한다(`BOT_PAT` 을 쓰면 검사가 없어 그대로 돈다).
- refine 은 `ci.yml` 안에 있어 PR 의 버전으로 돈다. 코드를 고치는 도우미일 뿐 게이트가 아니므로 괜찮다 —
  정리된 커밋도 다시 CI 를 거치고, Risk 평가는 여전히 main 의 규칙(`pr-review.yml`)으로 한다.
  refine 이 push 하면 이전 커밋의 PR review 는 "head 가 바뀜" 으로 건너뛰고 새 커밋이 평가된다.
- 세션에서 PR 을 올리기 전 같은 기준으로 스스로 다듬게 한다(CLAUDE.md). CI 쪽은 안전망.

## 5. CI 는 ubuntu 만

로컬 Windows 에서도 돌아가도록 `.gitattributes`(LF 고정), npm scripts 의 POSIX 문법 금지, `path.join` 규칙은 유지한다.

---

## 6. Risk Score 는 두 겹으로 매긴다

기준은 `.github/risk/rubric.md` (사용자가 정리한 Agent Code Review Risk Score Rubric 을 운영용으로 다듬은 것).

- **규칙 스캔**(`scripts/risk/scan.mjs`)이 diff 에서 기계적으로 확인되는 신호로 factor 별 floor 와
  hard override 를 정한다. 결정적이고 비용이 없고, Dependabot·AI 장애 때도 돈다.
- **AI 리뷰**(Claude, structured output)가 근거와 함께 factor 점수를 낸다. **floor 보다 낮게 매길 수 없다.**
  PR 을 쓰는 쪽도 Claude 라서, 같은 모델이 같은 곳을 놓치는 것을 규칙이 막는다.
- factor 는 0/5/10/15/20 만. 중간값을 허용하면 같은 PR 이 실행마다 다른 점수를 받는다.
- 확인 불가(`unknown`)는 최소 10, AI 평가 없음은 최소 MEDIUM — "모르는 것은 안전하다고 보지 않는다".
- 최종 계산·등급·게이트는 스크립트(`score.mjs`)가 한다. LLM 의 산술·형식 실수가 결과를 바꾸지 못한다.

원 rubric 에서 바꾼 것:

| 원 rubric | 여기 | 이유 |
| --- | --- | --- |
| 모든 영속 스키마 변경 → 최소 HIGH | **추가형**(새 테이블, nullable 컬럼, 새 테이블 인덱스)은 제외 | 기능마다 테이블을 추가하는 구조라 거의 모든 PR 이 HIGH 가 되어 신호가 사라진다 |
| 테스트 없음 = Testing 20 | 런타임 영향 없는 변경은 0 | 문서 수정이 MEDIUM 이 되는 것을 막는다 |
| "외부 consumer 를 모르면 높게" | 알려진 consumer 를 명시(같은 리포 프런트, **이전 버전 서버 코드**, decisions.md 의 외부 연동) | 개인·소규모 서비스에서 Compatibility 가 늘 부풀지 않게 |
| Deployment sequence (일반론) | **현재 배포된 코드가 쓰는 컬럼 삭제/이름 변경 → CRITICAL** (main 의 `src/` 를 검색) | 이 파이프라인은 마이그레이션 → 배포 순서이고 앱 롤백이 DB 를 되돌리지 않는다 |
| Human review / Code Owner / Senior | 등급별 **merge 조건**(롤백 계획 → 배포 후 확인 → 관리자 수락) | 리뷰어가 한 명. "누가 보나" 대신 "무엇이 갖춰져야 하나" |
| — | 리스크 평가 규칙 자체의 변경 → 최소 VERY HIGH | 에이전트가 게이트를 약하게 만드는 경로를 막는다 |

## 7. 평가는 main 의 코드로 한다 (자기 채점 방지)

`ci.yml`(pull_request)은 **PR 의 버전**이 실행된다. 리뷰·점수·게이트를 거기 두면 PR 이 자기 평가 방식을
바꿀 수 있다. 그래서:

- `pr-review.yml` 은 `workflow_run`(CI 완료) — 항상 기본 브랜치의 워크플로와 스크립트로 실행된다.
  PR 의 커밋은 `git fetch` 로 데이터로만 가져오고 실행하지 않는다(`npm ci` 도 하지 않는다 — 스크립트는 Node 내장 모듈만 쓴다).
- Claude 는 `./`(main) 에서 돌고 PR 은 `./pr/` 작업 트리로 읽는다. Claude Code 의 설정·훅(`.claude/`)은
  main 의 것만 로드된다. 프롬프트는 PR 안의 텍스트를 지시가 아닌 데이터로 다루게 한다(점수 조작 시도는 blocker).
- Claude 를 돌리는 job 은 읽기 권한만, 코멘트·라벨·상태는 별도 `report` job 이 쓴다.
- `risk-gate.yml` 은 `pull_request_target` 이지만 PR 의 코드를 체크아웃하지 않는다(이 트리거의 알려진 위험을 피하는 방식).
- 종합 코멘트의 저장 데이터는 `github-actions[bot]` 이 쓴 코멘트에서만 읽는다(사람이 마커를 흉내 내도 무시).
- 프리뷰 job 이 넘기는 메타데이터(`ci-meta` 아티팩트)는 형식을 검증해서만 쓴다(URL 은 `*.vercel.app` 만).

## 8. merge 게이트는 커밋 상태 + 브랜치 규칙

- `risk-gate` 커밋 상태와 `test` 체크를 브랜치 규칙(ruleset)의 필수 체크로 건다. 비공개 리포는 GitHub Pro/Team 이 필요하다
  (무료면 게이트는 표시만 되고 강제되지 않는다).
- 새 커밋이 오면 `risk-gate` 가 바로 "대기" 가 된다 → 평가 전 merge 를 막는다.
- `risk-accepted` 는 관리자/maintainer **사람 계정**만. 봇·에이전트가 붙이면 즉시 떼어진다.
  수락은 그 커밋에만 유효하다(새 push 로 해제). 그래서 에이전트 토큰으로 `BOT_PAT` 에 주인의 PAT 를 쓰지 말 것 —
  그러면 에이전트의 행동이 주인으로 보인다. Claude GitHub App 을 쓰거나 별도 머신 계정의 PAT 를 쓴다.
- GitHub 환경의 required reviewers(배포 승인)는 비공개 리포에서 Enterprise 전용이라 쓰지 않는다. merge 가 승인이다.

## 9. 배포: 스냅샷 → 마이그레이션 → 스테이징 → 승격 → 자동 롤백

- 마이그레이션이 있으면 먼저 Neon **copy-on-write 스냅샷 브랜치**(`pre-deploy/<sha>`, 컴퓨트 없음)를 만든다.
  PITR 보다 찾기 쉽고 부분 복구에 좋다. 만들지 못하면 마이그레이션도 하지 않는다(fail closed).
- 러너는 `lock_timeout` 5s / `statement_timeout` 5min. 잠금 대기열에서 기다리는 ALTER 가 그 테이블의 모든
  요청을 뒤에 세우는 고전적 장애를 막는다. `CREATE INDEX CONCURRENTLY` 는 `-- migrate:no-transaction` 파일로.
- 앱은 `vercel deploy --prod --skip-domain` 으로 **프로덕션 설정으로 빌드하되 트래픽은 옮기지 않고**,
  그 URL 에 스모크 테스트(배포 보호 우회 시크릿 사용, `/api/health` 의 커밋까지 확인) → `vercel promote`
  → 프로덕션 도메인 헬스체크 → 실패하면 직전 성공 배포로 `vercel rollback`.
- 롤백 대상은 GitHub 의 production 환경 배포 기록에서 "성공으로 끝난 것" 을 고른다. 스모크에서 떨어진
  스테이징 배포는 성공 기록이 없으므로 롤백 대상이 되지 않는다.
- 앱 롤백은 DB 를 되돌리지 않는다 → expand/contract 를 rubric·스캐너·CLAUDE.md 가 함께 강제한다.
- Vercel 함수 리전을 DB 리전에 맞춘다(`vercel.json` `regions`). 기본값(미국 동부)이면 싱가포르 DB 까지 쿼리마다 왕복한다.

## 10. 관측과 개인정보

- Sentry 는 DSN 이 있을 때만 켜진다(로컬·CI·미설정 프로젝트에서 아무것도 보내지 않음). `sendDefaultPii: false`,
  트레이스 샘플 10%. 릴리스 = 커밋 SHA(배포 때 주입) → 어느 배포에서 오류가 시작됐는지 보인다.
- `withSentryConfig` 는 `@sentry/nextjs/config` 에서 가져온다(SDK 11 부터). 소스맵 업로드는 `SENTRY_AUTH_TOKEN` 이 있을 때만.
- 로그는 JSON 한 줄(`src/lib/log.ts`), 민감한 키 이름은 자동으로 가린다.
- 프리뷰는 프로덕션 데이터 복제본을 쓴다(마이그레이션을 실제 데이터로 검증하기 위해). 대가로 Vercel 배포
  보호를 끄면 안 된다. Neon 의 schema-only 브랜치는 마이그레이션 상태 테이블(`schema_migrations`)의 행이
  없어 이 러너와 맞지 않아 쓰지 않았다. 개인정보가 많아지면 익명화 브랜치를 검토한다.
