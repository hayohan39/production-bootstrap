# 운영 런북

장애·배포 실패·데이터 복구 때 이 순서대로 한다. 원칙: **먼저 복구, 원인은 나중.**
Claude 세션에서 "장애 났어" 라고 하면 Claude 도 이 문서를 따른다.

## 처음 한 번 (프로젝트를 만든 직후)

- [ ] **Sentry**: Sentry 에서 Next.js 프로젝트를 만들고 Vercel 환경변수(Production·Preview)에 넣는다.
  - `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (같은 값) — 오류 수집
  - `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` — 빌드 때 소스맵 업로드(읽을 수 있는 스택트레이스)
  - 다음 배포부터 적용된다(Actions → Deploy → Run workflow 로 바로 다시 배포해도 된다).
- [ ] **업타임 모니터**: Better Stack Uptime / Checkly 등에 `https://<도메인>/api/health` 를 1~3분 간격으로 등록하고
  알림(이메일·Slack·전화)을 연결한다. 배포 워크플로의 헬스체크는 배포 순간만 본다.
- [ ] **도메인**: Vercel → Project → Domains 에 커스텀 도메인. (헬스체크는 커스텀 도메인을 우선 쓴다.)
- [ ] **Neon**: 플랜(Launch 이상)과 PITR 보존 기간을 확인한다. 이 기간이 "몇 시간/며칠 전으로 되돌릴 수 있나" 다.
- [ ] **Vercel**: Deployment Protection 은 켠 채로 둔다(프리뷰는 프로덕션 데이터 복제본을 쓴다).
  Spend Management 로 월 한도를 건다. 로그인·쓰기 API 가 생기면 Firewall 레이트 리밋 규칙을 건다.
- [ ] **GitHub**: Settings → Rules 에 `main protection`(PR 필수, 필수 체크 `test`)이 있는지.
  없으면 템플릿의 `docs/bootstrap/SETUP.md` "브랜치 보호" 를 따른다.

## 장애 대응

1. **확인** — `/api/health`, Sentry 새 오류, Vercel → Logs. 언제부터인지, 최근 배포 직후인지.
2. **최근 배포 때문이면 롤백** — GitHub → Actions → **Rollback** → Run workflow (`to` 를 비우면 직전 성공 배포).
   세션에서는 `node scripts/gh.mjs dispatch rollback.yml reason="가입 500 에러"`.
   Vercel 대시보드 → Deployments → 이전 배포 → Instant Rollback 도 같은 일이다.
3. **정상화 확인** — `/api/health`, 문제의 흐름, Sentry 오류가 멈췄는지.
4. **원인을 고치는 PR** — 롤백한 상태에서 다른 PR 을 merge 하면 문제의 코드가 다시 나간다. 고치는 PR 을 먼저.
5. 사후 기록 — 무엇이 깨졌고, 그 PR 의 Risk 등급이 얼마였는지(`node scripts/gh.mjs risk-history`).
   낮게 평가됐다면 `.github/risk/rubric.md` 나 `config.json` 을 보정하는 PR 을 만든다.

> 앱 롤백은 **DB 를 되돌리지 않는다.** expand → contract 를 지켰다면 이전 코드는 새 스키마에서 그대로 돈다.

## 배포가 실패했을 때 (PR 에 달린 배포 코멘트별)

| 코멘트 | 상태 | 할 일 |
| --- | --- | --- |
| ⛔ 스테이징 스모크 테스트 실패 | 트래픽은 이전 버전. 마이그레이션은 적용됐을 수 있음 | 로그 확인 → 고치는 PR |
| ↩️ 자동 롤백 | 이전 버전으로 복귀. DB 는 새 스키마 | 위와 같음. 이전 코드가 새 스키마에서 오류를 내는지 Sentry 확인 |
| 🔥 헬스체크 실패 + 롤백 못 함 | **장애 가능성** | 바로 "장애 대응" 2번 (`to` 에 이전 배포 URL 을 직접 넣어도 된다) |
| ❌ 운영이 새 버전으로 바뀌지 않음 | 새 배포는 스테이징에만 있음 | Vercel → Deployments 에서 현재 Production 이 이전 배포인지 확인(승격이 늦게 끝났을 수 있음). 원인 확인 후 Actions → Deploy → Re-run |
| ⚠️ 운영 버전 확인 불가 | 알 수 없음 | Vercel → Deployments 에서 현재 Production 확인 → 새 배포면 `/api/health` 확인, 이상하면 "장애 대응" 2번 |
| ❌ 배포 실패 | 트래픽은 이전 버전 | 로그(빌드 오류·토큰·한도) 확인 |

**마이그레이션 실패** (Deploy 의 `Database migrate` job 이 빨강, 배포는 안 됨)

- 파일 하나가 하나의 트랜잭션이라 실패한 파일은 되돌려졌다. 그 앞 파일은 적용됐을 수 있다 — `npm run migrate:status`.
- `lock_timeout` 이면 그 테이블을 오래 쓰는 요청이 있었다. 트래픽이 적을 때 Actions → Deploy → Re-run.
- `-- migrate:no-transaction` 파일이 실패했으면 INVALID 인덱스가 남았을 수 있다:
  `select indexrelid::regclass from pg_index where not indisvalid;` → `drop index concurrently <이름>;` → Re-run.

## 데이터 복구 (사람이 결정한다)

데이터를 잃거나 잘못 바꾼 경우. 복구 방법마다 잃는 것이 다르므로 Claude 는 절차와 영향을 설명하고 결정을 받는다.

1. **배포 전 스냅샷 브랜치 (부분 복구, 먼저 고려)** — 마이그레이션이 있던 배포마다 `pre-deploy/<sha>-<시각>` 브랜치가
   남는다(최근 3개, 변수 `PREDEPLOY_SNAPSHOTS`). Neon 콘솔 → Branches → 그 브랜치에 컴퓨트를 붙여 접속하고,
   필요한 행·컬럼만 읽어서 프로덕션에 되돌리는 SQL 을 새 마이그레이션(또는 일회성 스크립트)으로 만든다.
   그 이후 들어온 데이터를 잃지 않는다.
2. **시점 복구(PITR, 전체 되돌리기)** — Neon 콘솔 → 프로덕션 브랜치 → Restore → 시각 지정.
   Deploy 실행 요약의 "마이그레이션 시작" 시각 직전으로 되돌리면 그 마이그레이션 이전 상태가 된다.
   **그 시각 이후 쓰인 데이터가 모두 사라진다.** 복원 후 `npm run migrate:status` 와 배포된 코드가 맞는지 보고,
   필요하면 앱도 롤백한다.

## 비밀값이 새었을 때

1. 발급처에서 **즉시 폐기·재발급** (git 히스토리에서 지우는 것보다 먼저 — 이미 복제됐다고 가정한다).
2. 새 값을 Vercel 환경변수 / GitHub 시크릿에 넣고 Actions → Deploy → Run workflow 로 다시 배포.
3. 접근 로그(발급처 대시보드)에서 악용 흔적 확인. 필요하면 사용자 고지.

## 정기 점검 (월 1회)

- `node scripts/gh.mjs risk-history` — 등급과 실제 배포 결과가 맞는지(점수 보정).
- Dependabot PR 처리(보안 업데이트 우선).
- Vercel · Neon · Sentry · Claude 사용량과 비용.
- 분기 1회 복구 리허설: 최근 스냅샷 브랜치에 접속해 데이터를 읽어 본다.
