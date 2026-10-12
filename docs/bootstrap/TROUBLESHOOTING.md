# 문제 해결

운영 중 장애·복구는 프로젝트의 [docs/runbook.md](../runbook.md). 여기는 템플릿·파이프라인 설정 문제.

## 새 프로젝트 생성

**New project 워크플로가 아예 안 돎 / job 이 skipped** — 리포지토리가 템플릿으로 지정되지 않았다.

**`BOOTSTRAP_PAT 시크릿이 없습니다`** — [SETUP.md](SETUP.md) 3번.

**초기화 push 가 `refusing to allow ... workflow` 로 실패** — `BOOTSTRAP_PAT` 에 `workflow` 스코프가 없다.

**Provision 실패 — `project-scoped`** — `NEON_API_KEY` 가 project-scoped 키다. Personal 키로 바꾸고 재실행.

**`Protect main` 실패** — 비공개 리포의 브랜치 규칙은 GitHub Pro/Team 이 필요하다. 요금제를 올리고 재실행하거나
[SETUP.md](SETUP.md) 5번대로 수동 설정. 그 전까지 `risk-gate` 는 표시만 되고 merge 를 막지 못한다.

**배포 보호 우회 시크릿 경고** — Vercel 토큰 권한 또는 플랜 문제. Vercel → Project → Settings →
Deployment Protection → Protection Bypass for Automation 에서 만들고 값을 리포지토리 시크릿
`VERCEL_AUTOMATION_BYPASS_SECRET` 에 넣는다. 없으면 스모크 테스트만 건너뛴다.

## PR 리뷰 · Risk Score

**PR 종합 코멘트가 안 붙음**
- `pr-review.yml` 은 `workflow_run` 이라 **기본 브랜치에 있는 버전**만 돈다. 이 파일을 처음 추가하는 PR 에는 안 붙는다.
- CI 가 취소됐으면(새 push 로 대체) 건너뛴다. 새 커밋의 CI 가 끝나면 붙는다.
- Actions → PR review 실행 로그의 `scan` job 에서 "PR 을 찾지 못함 / head 가 바뀜" 메시지를 확인.

**`risk-gate` 가 계속 "대기"** — 그 커밋의 PR review 가 실패했거나 아직 안 돌았다. Actions → PR review → Re-run.
CI 를 다시 돌려도 된다(CI 완료가 리뷰를 깨운다).

**AI 리뷰 없음 (규칙 기반 점수만)** — 종합 코멘트의 "AI 리뷰" 줄에 이유가 있다: CI 실패, draft, `CLAUDE_REVIEW=false`,
Claude 시크릿 없음, Dependabot PR, Claude 실행 실패(로그 확인). AI 평가 없이 HIGH 이상이면 `risk-accepted` 가 필요하다.

**Dependabot PR 에 AI 리뷰가 없음 / 코멘트·상태가 안 붙음** — Dependabot 이 시작한 실행에는 Claude 시크릿이 없어
규칙 기반 점수만 붙는다(설계). 토큰 권한 제한으로 코멘트·상태까지 안 붙으면, PR 의 **Update branch** 버튼으로
사람이 커밋을 하나 만들면 그 CI 는 사람이 시작한 실행이 되어 AI 리뷰까지 붙는다. (Re-run 은 원래 권한 그대로 돈다.)

**`risk-accepted` 를 붙였는데 떨어짐** — 붙인 계정이 admin/maintain 이 아니거나 봇이다, 또는 그 커밋의 평가가 끝나기
전에 붙였다. 이유가 PR 코멘트로 남는다. 새 커밋을 push 하면 수락은 자동으로 풀린다(다시 붙인다).

**점수가 이상하게 높다/낮다** — 종합 코멘트의 "규칙 기반 신호" 를 펼쳐 어떤 규칙이 floor 를 올렸는지 본다.
경로 분류는 `.github/risk/config.json`, 규칙은 `scripts/risk/scan.mjs`, 기준은 `.github/risk/rubric.md`.
고치는 PR 은 VERY HIGH 로 평가된다(의도된 동작).

## CI / 프리뷰

**품질 리뷰(🧹)가 안 붙음** — CI 가 실패했거나(그땐 auto-fix 가 돈다), draft, Dependabot, `no-refine` 라벨,
`CLAUDE_REFINE=false`, 또는 HEAD 가 이미 `[claude-refine]` 커밋이다(push 당 1회).

**`[claude-refine]` 커밋 뒤 세션에서 push 가 거절됨** — CI 가 브랜치에 커밋을 더했다. `git pull origin <브랜치>` 후 다시 push.

**품질 리뷰가 원치 않는 정리를 했다** — 그 커밋을 revert 하고 PR 에 `no-refine` 라벨. 기준을 바꾸려면 `.github/review/quality.md`.

**auto-fix 가 push 했는데 CI 가 다시 안 돎** — `GITHUB_TOKEN` push 는 워크플로를 트리거하지 않는다. Claude App 또는 `BOT_PAT`.

**`Migrations are append-only` 실패** — main 에 있는 `.sql` 을 고쳤다. 되돌리고 새 마이그레이션으로.

**preview 마이그레이션 실패** — 프로덕션 데이터에서 안 되는 마이그레이션이다(예: 기존 행이 있는데 DEFAULT 없는 NOT NULL).
merge 전에 잡혔다. auto-fix 가 시도하고, 안 되면 `@claude` 로 지시.

**preview 스모크 실패 (401/403)** — 배포 보호 우회 시크릿이 틀렸다. 위 "배포 보호 우회 시크릿" 참고.

**Neon 브랜치 한도** — 열린 PR + 스냅샷(`PREDEPLOY_SNAPSHOTS`) 수를 확인. Neon 콘솔에서 `preview/pr-*` 정리.

## 배포

**Snapshot 단계 실패 → 마이그레이션 안 함** — 의도된 fail-closed. Neon 키·브랜치 한도 확인 후 Re-run.
급하면 변수 `PREDEPLOY_SNAPSHOTS=0` 으로 끄고 재실행(PITR 로만 복구 가능해진다).

**스테이징 스모크 실패** — 프로덕션 환경변수로 빌드한 앱이 뜨지 않거나 DB 에 못 붙는다. Vercel 환경변수(Production)
`DATABASE_URL`, 새로 추가한 환경변수가 빠지지 않았는지. 트래픽은 옮겨지지 않았다.

**자동 롤백 대상이 없음** — 첫 배포이거나 production 환경의 성공 기록이 없다. Rollback 워크플로의 `to` 에 URL 을 직접 넣는다.
