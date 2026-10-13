# 최초 1회 설정

production-bootstrap 리포지토리에 한 번만 해 두면, 이후 새 프로젝트는 워크플로 실행 한 번이다.

## 0. 요금제 (운영용이라 무료로는 안 되는 것들)

| 서비스 | 플랜 | 왜 |
| --- | --- | --- |
| Vercel | **Pro** | Hobby 는 상업적 이용 금지. 스테이징 승격·롤백·리전 지정·Firewall |
| Neon | **Launch** 이상 | PITR 보존 기간(Launch 최대 7일), 브랜치·컴퓨트 한도 |
| GitHub | **Pro**(개인 계정) / **Team**(조직) | 비공개 리포에 브랜치 규칙(필수 체크 `test` · `risk-gate`) |
| Sentry | Developer(무료)로 시작 | 팀이 생기면 유료 |
| Claude | API 키 권장 | 리뷰가 push 마다 돈다. 사용량을 콘솔에서 보고 한도를 걸 수 있다 |

자세한 이유와 대안은 [STACK.md](STACK.md).

## 1. 이 리포지토리를 템플릿으로 지정

GitHub → Settings → General → **Template repository** 체크.
(new-project 워크플로는 템플릿으로 지정된 리포지토리에서만 돈다.)

## 2. Claude GitHub App — All repositories

https://github.com/apps/claude → Configure → Repository access → **All repositories**

- 새로 만든 리포지토리를 claude.ai/code 에서 바로 고를 수 있다.
- auto-fix 가 App 토큰으로 push 하므로 그 push 가 CI 를 다시 돌린다.

## 3. 시크릿 (Settings → Secrets and variables → Actions)

| 이름 | 필수 | 용도 | 발급 |
| --- | --- | --- | --- |
| `BOOTSTRAP_PAT` | ✅ | 새 리포지토리 생성, 시크릿/변수/라벨/브랜치 규칙 설정, 초기화 push | **classic** PAT, 스코프 `repo` + `workflow` — https://github.com/settings/tokens/new |
| `ANTHROPIC_API_KEY` | ✅* | Actions 안의 Claude (리뷰·Risk, auto-fix, @claude) | https://console.anthropic.com/settings/keys |
| `CLAUDE_CODE_OAUTH_TOKEN` | * | 위와 같음, 구독 사용량으로 | 터미널에서 `claude setup-token` |
| `VERCEL_TOKEN` | ✅ | Vercel 프로젝트 생성·배포·롤백 | https://vercel.com/account/tokens (Pro 팀 범위) |
| `NEON_API_KEY` | ✅ | Neon 프로젝트 생성, 프리뷰·스냅샷 브랜치 | Neon 콘솔 → Account settings → API keys (**Personal 키**) |
| `BOT_PAT` | 선택 | Claude App 없이 auto-fix push 가 CI 를 재실행하게 | **별도 머신 계정**의 fine-grained PAT (주인 계정 PAT 는 쓰지 않는다 — DESIGN.md 8) |
| `NEON_ORG_ID` | 선택 | Neon 조직이 여러 개일 때 | Neon 콘솔 |
| `VERCEL_TEAM_ID` | 선택 | Vercel 팀 계정일 때 | Vercel 팀 설정 |

\* 둘 중 하나. 공통 시크릿(Claude/Vercel/Neon/BOT_PAT)은 새 프로젝트로 **자동 복사**된다.
`BOOTSTRAP_PAT` 은 템플릿 리포지토리에만 두고 복사하지 않는다.

프로젝트마다 자동으로 만들어지는 것: `DATABASE_URL`(시크릿), `VERCEL_AUTOMATION_BYPASS_SECRET`(시크릿, 스모크 테스트용),
`NEON_PROJECT_ID` · `VERCEL_PROJECT_ID` · `VERCEL_ORG_ID`(변수), Risk 라벨, main 브랜치 규칙.

## 4. 변수 (선택)

| 이름 | 기본값 | 의미 |
| --- | --- | --- |
| `NEON_REGION` | `aws-ap-southeast-1` | 새 Neon 프로젝트 리전. 바꾸면 프로젝트의 `vercel.json` `regions` 도 맞춘다 |
| `CLAUDE_MODEL` | `claude-sonnet-5` | auto-fix · @claude 모델 |
| `CLAUDE_REVIEW_MODEL` | `claude-sonnet-5-5` | PR 리뷰·Risk (규칙 스캔이 HIGH 미만) |
| `CLAUDE_REVIEW_MODEL_HIGH` | `claude-opus-5-5` | PR 리뷰·Risk (규칙 스캔이 HIGH 이상 — 더 오래, 더 깊게) |

위 세 Claude 변수는 새 프로젝트로도 복사된다. 프로젝트별 변수(새 프로젝트 쪽에서 바꿈):

| 이름 | 기본값 | 의미 |
| --- | --- | --- |
| `AUTOFIX_MAX_ATTEMPTS` | `3` | PR 당 auto-fix 최대 시도 |
| `CLAUDE_REVIEW` | (켜짐) | `false` 면 AI 리뷰를 끈다(규칙 기반 Risk 와 게이트는 계속) |
| `CLAUDE_REFINE` | (켜짐) | `false` 면 CI 뒤 품질 리뷰(refine) 끔. PR 하나만 끄려면 `no-refine` 라벨 |
| `REFINE_MAX_ROUNDS` | `1` | 작성자 push 한 번에 품질 반영 커밋을 몇 번까지 연속으로 허용할지 |
| `PREDEPLOY_SNAPSHOTS` | `3` | 배포 전 DB 스냅샷 브랜치 보관 개수. `0` 이면 끈다 |

## 5. 브랜치 보호 (new-project 가 실패했을 때 수동으로)

새 프로젝트의 Settings → Rules → Rulesets → New branch ruleset:

- Target: Default branch, Enforcement: Active
- Restrict deletions, Block force pushes
- Require a pull request before merging (승인 수 0 — 혼자 운영이면 자기 PR 을 승인할 수 없다)
- Require status checks to pass: `test`, `risk-gate`

또는 요금제를 올린 뒤 New project 워크플로를 같은 이름으로 다시 실행한다(이미 된 것은 재사용).

## 6. 확인

claude.ai/code 에서 production-bootstrap 으로 세션을 열고 "테스트용 프로젝트 hello-prod 만들어줘".

1. Actions 의 New project 가 초록, 새 리포지토리의 Deploy 가 초록
2. `https://hello-prod*.vercel.app/api/health` 가 `{"ok":true, "commit":"<sha 7자리>", "database":{"state":"ok"…}}`
3. 새 리포지토리에서 아무 PR 이나 올리면 CI 뒤 **PR 종합 코멘트**(CI · 리뷰 · Risk)와 `risk:*` 라벨, `risk-gate` 체크가 붙는다
4. 그 PR 을 merge 하면 PR 에 "🚀 프로덕션 배포 완료" 코멘트

확인 후 지우려면: GitHub 리포지토리, Vercel 프로젝트, Neon 프로젝트를 각각 삭제.
