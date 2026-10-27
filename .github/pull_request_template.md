## 무엇을

<!-- 이 PR 이 무엇을 바꾸는지, merge 하면 사용자에게 무엇이 달라지는지 한두 줄. -->

## 어떻게 확인했나

- [ ] `npm run check` (lint · typecheck · test · build) 통과
- [ ] 품질 점검(`.github/review/quality.md`): <!-- 고친 것 / 남긴 것 한 줄 -->
- [ ] 바뀐 동작을 검증하는 테스트: <!-- 파일과 케이스 -->
- [ ] (DB 변경 시) 로컬 Postgres 에 `npm run migrate` 적용 확인
- [ ] (UI 변경 시) 프리뷰에서 확인할 곳:

## 배포 영향

<!-- 마이그레이션(잠금·데이터 변경·삭제), 새 환경변수(이름·용도·발급처 — merge 전에 Vercel 에 설정 필요),
     외부 서비스, 배포 순서 제약. 없으면 "없음". -->

## 예상 Risk

<!-- 작성자의 자기 평가(.github/risk/rubric.md). 등급 · 규칙 스캔 최저치 · 가장 큰 factor 두세 개와 이유.
     예: "MEDIUM (스캔 최저 30) — Compatibility: nullable 컬럼 추가만, 이전 코드는 무시 / Testing: 새 API 테스트 추가"
     최종 점수는 CI 뒤 AI 리뷰가 낸다. -->

## 롤백 계획

<!-- Risk HIGH 이상이면 꼭 쓴다(PR 종합 코멘트가 빠졌는지 알려 준다). 문제가 생기면 무엇을 어떤 순서로 되돌리는가.
     예: "앱 롤백(rollback.yml)만으로 복구. 추가한 컬럼은 이전 코드가 무시하므로 그대로 둔다."
     예: "pre-deploy 스냅샷 브랜치에서 users.email 을 복원하는 SQL: ..." -->

## 배포 후 확인

<!-- Risk VERY HIGH 이상이면 꼭 쓴다. 배포 직후 무엇을 보면 정상인지.
     예: "/api/health OK, 가입 → 로그인 흐름 1회, Sentry 에 새 오류 없음(10분)" -->

---

**merge = 프로덕션 배포**입니다 (스냅샷 → 마이그레이션 → 스테이징 → 승격, 실패 시 앱 자동 롤백).
CI · AI 리뷰 · Risk Score 는 PR 종합 코멘트 하나에 모입니다. 수정이 필요하면 `@claude <지시>` 로 코멘트하세요.
