# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

[production-bootstrap](https://github.com/hayohan39/production-bootstrap) 으로 만든 프로덕션 서비스.

## 개발 흐름

1. **Claude 세션**(claude.ai/code, 웹·모바일)에서 이 리포지토리를 골라 만들고 싶은 것을 요청
2. Claude 가 브랜치 → 구현 → 커밋 → **PR** 생성
3. CI 자동 실행(실패하면 Claude 가 최대 3회 자동 수정) → 프리뷰(프로덕션 DB 복제본)
4. PR 에 **종합 코멘트** 하나: CI 결과 · AI 코드 리뷰 · **Risk Score(0–100)** · merge 조건
5. **내가 판단해서 merge** (또는 `@claude <지시>` 로 수정 요청)
   → DB 스냅샷 → 마이그레이션 → 스테이징 배포·스모크 → 프로덕션 승격 → 실패 시 자동 롤백 → PR 에 결과

| Risk | merge 전에 필요한 것 |
| --- | --- |
| 🟢 LOW · 🟡 MEDIUM | — |
| 🟠 HIGH | PR 본문 "롤백 계획" |
| 🔴 VERY HIGH | + "배포 후 확인" |
| ⛔ CRITICAL | + 나눠서 배포할 수 없는지 내가 직접 판단 |

기준: [.github/risk/rubric.md](.github/risk/rubric.md). 진행 상황은 Claude 세션에서 "지금 상황 알려줘".

## 장애 때

[docs/runbook.md](docs/runbook.md) — 먼저 Actions → **Rollback** → Run workflow, 그다음 원인.

## 로컬 개발 (선택)

```bash
npm ci
echo 'DATABASE_URL=postgres://...' > .env.local   # 로컬 Postgres 또는 Neon dev 브랜치 (프로덕션 금지)
npm run dev
npm run check                # lint + typecheck + test + build
```

## 참고

- 결정 기록: [docs/decisions.md](docs/decisions.md)
- Claude 작업 규칙: [CLAUDE.md](CLAUDE.md)
- 헬스체크: `/api/health`
