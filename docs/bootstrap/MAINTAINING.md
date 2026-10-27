# 템플릿 유지보수

이 리포지토리는 **템플릿이자 컨트롤 리포지토리**다.

- 템플릿: "Use this template"/`new-project.yml` 이 이 리포지토리의 main 을 그대로 복사한다.
- 컨트롤: `new-project.yml` 이 리포지토리 생성·프로비저닝·초기화·브랜치 보호를 한다.

## 파일 구분

새 프로젝트로 복사된 뒤 `scripts/init-project.mjs` 가 지우는 **템플릿 전용** 파일
(목록은 그 스크립트의 `TEMPLATE_ONLY`):

- `.github/workflows/new-project.yml`
- `.claude/skills/new-project/`
- `scripts/provision.mjs`, `scripts/init-project.mjs`
- `test/template/`
- `docs/bootstrap/` (단, `project-README.md` 는 새 프로젝트의 `README.md` 가 된다)
- `CLAUDE.md` 안의 `<!-- template-only:start/end -->` 블록

**프로젝트로 복사되는 것** 중 운영에 중요한 것: `.github/risk/`(rubric·스키마·경로 분류 — 프로젝트마다 조정),
`scripts/risk/`, `docs/runbook.md`, `docs/decisions.md`.

플레이스홀더 `{{PROJECT_NAME}}`, `{{PROJECT_DESCRIPTION}}`, `{{CREATED_AT}}` 는
`src/lib/project.ts`, `CLAUDE.md`, `README.md`, `docs/decisions.md` 에서만 치환된다.

## 템플릿 리포지토리 자신의 워크플로

- `ci.yml` 의 `test` 는 템플릿에서도 돈다 → 템플릿 앱이 항상 초록인지 확인.
- `preview`, `deploy.yml`, `rollback.yml`, `preview-cleanup.yml` 은 `github.event.repository.is_template` 으로 건너뛴다.
- `pr-review.yml` 은 템플릿 PR 에서도 돈다(템플릿 자체 변경도 Risk 로 평가). main 에 있는
  버전이 실행되므로, 이 파일이나 `scripts/risk/` 를 바꾸는 PR 은 **바꾸기 전 규칙**으로 평가된다.

## Risk 규칙을 바꿀 때

1. 기준을 바꾸면 `.github/risk/rubric.md` 와 `scripts/risk/scan.mjs` / `score.mjs` 를 함께 고친다(AI 와 규칙이 같은 기준을 보게).
2. `test/risk.test.ts` 에 그 규칙의 케이스를 추가한다(SQL 분류, floor, override, 확인 사항).
3. `review-schema.json` 을 바꾸면 홑따옴표(')를 넣지 않는다 — 워크플로가 `--json-schema '<json>'` 로 넘긴다.

## 이미 만든 프로젝트에 템플릿 변경을 반영하려면

자동 동기화는 없다. 그 프로젝트 세션에서 "production-bootstrap 의 risk 규칙 변경을 반영해줘" 처럼 요청한다.

## 검증

```bash
npm ci
npm run check                     # 템플릿 테스트(test/template, test/risk) 포함
TEST_DATABASE_URL=postgres://... npm test   # 마이그레이션 러너 실제 DB 테스트 (lock_timeout, no-transaction 포함)
actionlint                        # 워크플로를 바꿨으면
node scripts/risk/cli.mjs scan --base origin/main --head HEAD   # 지금 브랜치의 규칙 기반 Risk
```

## 설계 근거

왜 이렇게 만들었는지는 [DESIGN.md](DESIGN.md), 스택 선택은 [STACK.md](STACK.md). 구조를 바꾸기 전에 읽는다.
