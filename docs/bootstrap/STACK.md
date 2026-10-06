# 프로덕션 스택 추천 (소규모 베타 → scale-up)

project-bootstrap(개인용)의 Vercel Hobby + Neon Free 조합을 실제 운영 서비스로 올릴 때의 조합이다.
기준: **지금은 1~2명이 운영하는 베타**, 하지만 사용자가 늘면 다시 짜지 않고 키울 수 있을 것.

> 요금과 한도는 자주 바뀐다. 아래 숫자는 2026년 10월 기준 공개 자료이고, 도입 전에 각 요금 페이지에서 확인한다.

## 결론

| 영역 | 추천 | 개인용과 다른 점 | 시작 비용 감각 |
| --- | --- | --- | --- |
| 호스팅 | **Vercel Pro** | Hobby 는 **상업적 이용 금지**. Pro 부터 운영에 필요한 기능(아래) | 배포 seat 당 월 $20 (사용량 크레딧 포함) + 초과 사용량 |
| DB | **Neon Launch** → 트래픽이 늘면 Scale | Free 는 PITR 6시간·작은 한도. Launch 는 PITR 최대 7일, Scale 은 30일 | 사용량 과금(컴퓨트 시간 + 저장량), 최소 금액 없음 |
| 오류·성능 | **Sentry** (`@sentry/nextjs`, 이미 연결됨) | 개인용엔 없음. 릴리스(커밋) 단위로 오류 추적 | 무료 플랜으로 시작, 팀이 생기면 유료 |
| 업타임 | Better Stack Uptime 또는 Checkly | 외부에서 `/api/health` 감시 + 알림 | 무료 플랜으로 충분 |
| CI/CD | GitHub Actions + **GitHub Pro(개인)/Team(조직)** | 비공개 리포에 브랜치 규칙(필수 체크 `test`·`risk-gate`)을 걸려면 유료 플랜 | 사용자당 월 수 달러 |
| 코드 리뷰 | Claude (claude-code-action) + Risk Score | 개인용은 열 때 한 번. 여기는 push 마다, 위험하면 더 강한 모델 | API 사용량 (PR 크기·모델에 따라 다름 — 변수 `CLAUDE_REVIEW_MODEL` 로 조정) |

**다음은 기능이 필요해질 때 정한다** (`docs/decisions.md` 미결 — 첫 기능 전에 인증부터):

| 영역 | 1순위 | 대안 | 메모 |
| --- | --- | --- | --- |
| 인증 | Better Auth (자체 Postgres 에 저장) | Clerk, Auth.js | 사용자 데이터가 우리 DB 에 남아 락인이 낮다. Clerk 은 가장 빠르지만 MAU 과금·외부 저장 |
| 이메일 | Resend | Postmark, AWS SES | 발신 도메인 인증(SPF/DKIM) 필수 |
| 레이트 리밋·캐시 | Vercel Firewall 규칙 → Upstash Redis | | Firewall 은 코드 없이 Pro 에서 |
| 백그라운드 작업 | Vercel Cron → Inngest / Upstash QStash | | 함수 실행 시간을 넘는 작업이 생기면 |
| 파일 | Vercel Blob | Cloudflare R2 | 트래픽이 크면 R2(전송 비용 없음) |
| 제품 분석 | Vercel Web Analytics | PostHog | 개인정보 고지 확인 |

## 왜 Vercel + Neon 을 유지하나 (대안 비교)

| | A. Vercel Pro + Neon (추천) | B. Vercel + Supabase | C. AWS/GCP 컨테이너 + RDS/Cloud SQL | D. Cloudflare Workers + Hyperdrive |
| --- | --- | --- | --- | --- |
| 지금 파이프라인 재사용 | 그대로 (프리뷰 DB 브랜치·스냅샷·배포 순서) | DB 브랜치·마이그레이션 흐름 재작성 | 배포 전부 재작성 | Next.js 어댑터(OpenNext) 필요 |
| 운영 부담 | 낮음 | 낮음 | **높음** (네트워크, IAM, 패치, 오토스케일) | 중간 (런타임 호환성) |
| 묶음 기능 | 따로 고른다 | Auth·Storage·Realtime 포함 | 전부 직접 | KV·R2·Queues |
| 락인 | 낮음 (표준 Postgres, 표준 Next.js) | Auth·Storage 쪽이 높음 | 낮음 | 중간 |
| 규모가 커졌을 때 단가 | 트래픽 많으면 비싸질 수 있음 | 중간 | **가장 낮음** | 낮음 |
| 언제 맞나 | 베타~수만 MAU, 1~5명 팀 | Auth/Storage 를 한 벤더로 끝내고 싶을 때 | 전담 인프라 인력이 생긴 뒤 | 엣지·저비용이 최우선일 때 |

베타에서 가장 비싼 것은 서버비가 아니라 **운영에 쓰는 시간과 장애**다. A 는 지금 파이프라인을 그대로 쓰면서
운영 기능(롤백, 스냅샷, 감시)만 더하면 된다. C 는 규모가 커졌을 때 단가가 가장 낮지만, 그 시점은 대개
"인프라를 볼 사람이 생긴 뒤" 다.

### Vercel Pro 에서 이 템플릿이 쓰는 것

- 상업적 이용 허용(Hobby 는 비상업 전용)
- 스테이징 배포(`--skip-domain`) → 스모크 → `promote`, 실패 시 이전 배포로 `rollback` (Hobby 는 직전 1개로만 롤백)
- Deployment Protection + 자동화용 우회 시크릿(CI 스모크 테스트)
- 함수 리전 지정(`vercel.json` 의 `regions`: DB 와 같은 곳 — 기본 `sin1` ↔ Neon `aws-ap-southeast-1`)
- Firewall/레이트 리밋, Spend Management, 로그 보존 기간 증가

### Neon 유료 플랜에서 이 템플릿이 쓰는 것

- PITR(시점 복구): Free 6시간 → Launch 최대 7일 → Scale 최대 30일. **"며칠 전 데이터로 되돌릴 수 있나" 가 곧 이 값**이다.
- 브랜치: PR 마다 프리뷰 브랜치 + 배포 전 스냅샷 브랜치 3개. 동시에 열린 PR 이 많으면 브랜치 한도·추가 요금을 확인한다.
- 스케일: 컴퓨트 오토스케일, 필요하면 읽기 복제본. scale-to-zero 는 콜드 스타트가 있으니 프로덕션 브랜치는
  사용자 수에 따라 끄는 것을 검토한다.

## scale-up 경로 (다시 짜지 않고 키우기)

이식성을 지키기 위해 템플릿이 일부러 하는 것:

- **표준 Postgres + SQL 마이그레이션**(ORM 락인 없음) → 언제든 `pg_dump` 로 RDS/Aurora/Cloud SQL 로 옮길 수 있다.
- **표준 Next.js**(Vercel 전용 API 는 `@vercel/functions` 의 `attachDatabasePool` 하나, 다른 곳에선 아무 일도 안 함)
  → 컨테이너(Cloud Run, Fly, ECS)로 옮길 때 코드 변경이 거의 없다.
- 환경변수는 `src/lib/env.ts` 한곳, 로그는 JSON 한 줄, 오류는 Sentry → 호스팅을 바꿔도 관측은 그대로.

언제 무엇을 바꾸나:

| 신호 | 다음 단계 |
| --- | --- |
| DB CPU·연결 수가 계속 높다 | Neon Scale, 컴퓨트 상한 올리기, 읽기 복제본, 느린 쿼리 인덱스 |
| 함수 실행 시간 한도에 걸리는 작업 | Inngest/QStash 로 백그라운드화 |
| Vercel 월 비용이 서버 몇 대 값을 넘는다 / WebSocket·장시간 연결 필요 | 무거운 부분만 컨테이너(Cloud Run 등)로 분리, 나머지는 Vercel |
| 팀이 3명 이상 | GitHub Team, CODEOWNERS, 사람 리뷰 1명 필수(브랜치 규칙), Sentry 팀 플랜 |
| 비공개 리포에서 배포 승인 단계가 필요 | GitHub 환경의 required reviewers 는 비공개 리포에선 Enterprise 전용 — 그 전까지는 merge 가 승인이다 |
| 규제·감사 요구 | 감사 로그(Vercel Enterprise / GitHub Enterprise), DB 접근 역할 분리(앱 역할은 DML 만) |

## 개인용(project-bootstrap)과 비교

| | project-bootstrap | production-bootstrap |
| --- | --- | --- |
| 대상 | 개인 앱, 실험 | 실제 사용자가 있는 서비스(베타~) |
| 요금제 | 전부 무료 | Vercel Pro, Neon Launch, GitHub Pro/Team, Sentry |
| 리뷰 | PR 열 때 1회, ✅/✋ | CI 뒤 push 마다, ✅/✋ + **Risk Score 0–100** + merge 게이트 |
| merge 게이트 | 프로세스(사람이 누름) | 브랜치 규칙: `test` + `risk-gate` 필수, CRITICAL 은 관리자 수락 |
| 배포 | 마이그레이션 → 배포 → 헬스체크 | **스냅샷** → 마이그레이션(lock_timeout) → **스테이징 → 스모크 → 승격** → 헬스체크 → **자동 롤백** |
| 복구 | 수동 Instant Rollback | Rollback 워크플로, 스냅샷 브랜치, PITR, 런북 |
| 관측 | `/api/health` | + Sentry, 구조화 로그, 업타임 모니터 |
| 의존성 | 수동 | Dependabot(주간, 묶음) |
| 보안 기본값 | — | 보안 헤더, 쿼리 타임아웃, 비밀값 스캔, 개인정보 미전송 |
