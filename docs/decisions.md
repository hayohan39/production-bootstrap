# 결정 기록

이 프로젝트에서 내린 기술·인프라 결정을 남긴다. Claude 와 세션에서 합의한 것도 여기에 적는다.
최신 항목이 위로 온다.

형식:

```
## YYYY-MM-DD 제목
- 결정:
- 이유:
- 검토한 대안:
- 비용:
- 영향: (새 환경변수, 되돌리는 법)
```

## 미결

첫 기능을 만들기 전에 정한다(대부분의 기능이 기대는 것들).

- **인증** — 후보: Better Auth(자체 DB 에 저장, 무료, 락인 낮음) / Clerk(가장 빠름, MAU 과금, 사용자 데이터가 외부에) /
  Auth.js. 결정 전까지 쓰기 API 를 열지 않는다.
- **이메일 발송** (가입 확인·알림이 필요해지면) — 후보: Resend / Postmark / AWS SES.
- **CSP(Content-Security-Policy)** — 외부 스크립트(분석, 결제 위젯)를 붙일 때 허용 출처와 함께 정한다.

## 외부 연동

Risk Score 의 Compatibility 판단에 쓰인다. 이 앱의 API·웹훅·데이터를 쓰는 외부 consumer 를 적는다.

- (없음)

---

## {{CREATED_AT}} 기본 스택 (production-bootstrap)

- 결정: Next.js(App Router) + TypeScript, Vercel Pro(호스팅), Neon(Postgres, `pg` + SQL 마이그레이션),
  Sentry(오류·성능), GitHub Actions(CI/CD) + Claude(리뷰·Risk Score·auto-fix)
- 이유: production-bootstrap 의 고정 스택. 근거와 대안 비교는 템플릿의 `docs/bootstrap/STACK.md`.
- 비용: Vercel Pro(배포 seat 당 월 정액 + 사용량), Neon Launch(사용량 과금), Sentry(무료 플랜으로 시작),
  GitHub Pro/Team(비공개 리포 브랜치 보호), Claude(API 사용량).
- 영향: merge = 프로덕션 배포. PR 마다 Neon 프리뷰 브랜치 + Vercel 프리뷰. 배포 전 Neon 스냅샷 3개 유지.
- 되돌리는 법: 앱 = Rollback 워크플로, DB = `docs/runbook.md`.
