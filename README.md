# production-bootstrap

실제 사용자가 쓰는 **운영용 프로덕트**(소규모 베타 → scale-up)를 위한 GitHub 템플릿.
개인용 [project-bootstrap](https://github.com/hayohan39/project-bootstrap) 과 같은 흐름(Claude 세션에서 개발 → PR → 내가 merge)에
운영에 필요한 것 — **PR 마다 Risk Score**, merge 게이트, 스테이징 승격, 자동 롤백, DB 스냅샷, 오류 추적 — 을 더했다.

```
나 ── Claude 세션(웹/모바일) ── "이거 만들어줘" / "지금 상황 어때?" / "장애 났어"
          │
          ▼
   Claude: 브랜치 → 구현 → npm run check → 예상 Risk 확인 → 커밋 → PR
          │
          ▼
   CI ─ test (append-only 마이그레이션 · lint · typecheck · test · 빈 DB 마이그레이션 · build)
      ─ preview (프로덕션 복제 DB 에 마이그레이션 → Vercel 프리뷰 → 스모크)
      ├ 통과 → Claude 품질 리뷰: 작은 정리는 직접 커밋, 큰 리팩터링은 제안 (PR 당 1회)
      └ 실패 → Claude auto-fix (PR 당 최대 3회)
          │
          ▼
   PR review (main 의 규칙으로) ─ 규칙 스캔 + Claude 리뷰 → Risk Score 0–100
          └ PR 종합 코멘트 하나:  🟠 HIGH · Risk 47/100 · ✋ 리뷰: 수정 필요 · CI ✅
                                 + merge 조건(risk-gate) · 발견 사항 · factor 표 · 위험 요인 · 완화책
          │
          ▼
나 ── CI · 리뷰 · Risk 를 보고 merge  (또는 @claude 로 수정 요청)
          │
          ▼
   Deploy ─ DB 스냅샷 → 마이그레이션(lock_timeout) → 스테이징 배포 → 스모크 → 프로덕션 승격
            → 헬스체크(커밋 확인) → 실패 시 자동 롤백 → PR 에 결과
```

## 스택

| 고정 | 프로젝트에서 결정 (`docs/decisions.md`) |
| --- | --- |
| Next.js + TypeScript · **Vercel Pro** · **Neon (Launch+)** · **Sentry** · GitHub Actions (+ GitHub Pro/Team) · Claude 리뷰 | 인증(1순위 Better Auth) · 이메일 · 레이트 리밋 · 백그라운드 작업 · 파일 · 분석 |

추천 이유, 대안(Supabase / AWS·GCP / Cloudflare) 비교, scale-up 경로: **[docs/bootstrap/STACK.md](docs/bootstrap/STACK.md)**

## Risk Score

PR 이 "좋은 코드인가" 가 아니라 **"프로덕션에서 잘못되면 얼마나 심각하고, 얼마나 넓게 퍼지고, 얼마나 확신 있게
검증했고, 얼마나 빨리 되돌릴 수 있는가"** 를 잰다. 5개 factor × 20점(Security · Scope · Compatibility · Testing · Migration/Rollback).

- 규칙 스캔(결정적)이 factor 별 최저치와 hard override 를 정하고, Claude 가 근거와 함께 점수를 매긴다. AI 는 최저치 아래로 못 내린다.
- 등급별 merge 조건을 `risk-gate` 필수 체크로 강제: HIGH → 롤백 계획, VERY HIGH → + 배포 후 확인, CRITICAL → + 관리자의 `risk-accepted`.
- 평가는 항상 **main 의 규칙**으로 한다 — PR 이 자기 평가 기준을 바꿔 통과할 수 없다.

기준 전문: [.github/risk/rubric.md](.github/risk/rubric.md) · 설계 이유: [docs/bootstrap/DESIGN.md](docs/bootstrap/DESIGN.md) 6~8

## 새 프로젝트 만들기

**Claude 세션에서** (이 리포지토리를 골라서):

> 새 프로젝트 만들어줘. 이름 `receipt-book`, 영수증 사진으로 가계부 쓰는 서비스

또는 GitHub → Actions → New project → Run workflow (`name`, `description`). 워크플로가 하는 일:

1. 이 템플릿으로 리포지토리 생성(merge 된 PR 브랜치 자동 삭제 켬), 공통 시크릿 복사
2. Neon 프로젝트 + Vercel 프로젝트 생성·연결, 배포 보호 우회 시크릿(스모크 테스트용)
3. 이름/설명 채우고 템플릿 전용 파일 제거 후 push → 첫 프로덕션 배포
4. Risk 라벨, main 브랜치 규칙(PR 필수, `test` · `risk-gate` 필수 체크)

그 다음 새 리포지토리의 `docs/runbook.md` "처음 한 번"(Sentry DSN, 업타임 모니터, 도메인)을 채운다.

## 처음 한 번

[docs/bootstrap/SETUP.md](docs/bootstrap/SETUP.md) — 요금제, 템플릿 지정, Claude GitHub App, 시크릿.

## 들어 있는 것

```
.github/
  workflows/
    ci.yml               test → preview(스모크) → refine(품질 리뷰·정리) / autofix(실패 시)
    pr-review.yml        CI 완료 → 규칙 스캔 + Claude 리뷰 → Risk Score → 종합 코멘트·라벨·risk-gate
    risk-gate.yml        라벨/본문 변경 → 게이트 재계산, risk-accepted 권한 확인
    deploy.yml           main → 스냅샷 → 마이그레이션 → 스테이징 → 승격 → 헬스체크 → 자동 롤백
    rollback.yml         수동 롤백 (직전 성공 배포)
    preview-cleanup.yml  PR 닫히면 Neon 프리뷰 브랜치 삭제
    claude-mention.yml   @claude 코멘트 처리
    new-project.yml      [템플릿 전용] 새 프로젝트 생성
  risk/
    rubric.md            Risk Score 기준 (AI 리뷰어가 읽는 문서)
    review-prompt.md     리뷰 지시문 · review-schema.json  구조화 출력 스키마
    config.json          경로 분류 (인프라·공통 모듈·인증·API …)
  dependabot.yml         주간 의존성 업데이트(묶음)
scripts/
  risk/                  scan(규칙) · score(합산·게이트) · render(코멘트) · cli
  migrate.mjs            마이그레이션 러너 (체크섬, lock_timeout, no-transaction)
  neon.mjs               프리뷰 브랜치 · 배포 전 스냅샷
  release.mjs / smoke.mjs  배포 도메인·롤백 대상 · 스모크 테스트
  gh.mjs                 REST 전용 GitHub 헬퍼 (pr-status 에 Risk, risk-history)
  provision.mjs          [템플릿 전용] Neon + Vercel + 시크릿 + 브랜치 규칙
src/                     Next.js 앱 (상태 페이지, /api/health, pg, env 검증, 구조화 로그, Sentry, 보안 헤더)
docs/
  runbook.md             장애 대응 · 배포 실패 · 데이터 복구 · 비밀값 유출
  decisions.md           결정 기록 (미결: 인증 · 이메일 · CSP)
```

## 더 보기

- [STACK.md](docs/bootstrap/STACK.md) — 스택 추천과 scale-up 경로
- [DESIGN.md](docs/bootstrap/DESIGN.md) — 설계 근거 (Risk 두 겹 평가, 자기 채점 방지, 배포 순서)
- [SETUP.md](docs/bootstrap/SETUP.md) · [MAINTAINING.md](docs/bootstrap/MAINTAINING.md) · [TROUBLESHOOTING.md](docs/bootstrap/TROUBLESHOOTING.md)
- [FROM-PROJECT.md](docs/bootstrap/FROM-PROJECT.md) — project-bootstrap 으로 만든 프로젝트를 이 운영 흐름으로 전환하기
