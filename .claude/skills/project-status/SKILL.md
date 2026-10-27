---
name: project-status
description: 사용자가 이 프로젝트의 개발 상황·진행 현황·"어디까지 됐어?"·"PR 어떻게 됐어?"·배포 상태·Risk 를 물을 때 사용한다. 열린 PR(CI·리뷰·Risk), 최근 배포와 롤백, 미결 결정을 모아 짧게 보고한다.
---

# 개발 현황 보고

사용자는 대개 휴대폰으로 읽는다. **10줄 안팎**으로, 결론부터.

## 1. 모으기

클라우드 세션에서는 GraphQL 이 막혀 `gh pr ...` 이 안 된다. REST 헬퍼를 쓴다:

```bash
git fetch origin main --quiet
node scripts/gh.mjs pr-list          # 열린 PR + Risk 라벨 + 체크
node scripts/gh.mjs pr-status <번호>  # 체크 상세 + 종합 코멘트(Risk·리뷰·프리뷰·발견 사항)
node scripts/gh.mjs deploys          # 최근 main 배포 결과
git log origin/main --oneline -10    # 최근 merge
```

배포가 실패·롤백됐으면 그 PR 의 마지막 코멘트(🚀/↩️/🔥/⛔/❌)를 본다.
그리고 `docs/decisions.md` 에서 "미결" 항목을 확인한다.
gh 자체가 안 되면 git 만으로라도 파악하고 "CI 상태는 확인 못 함" 이라고 적는다.

## 2. 보고 형식

```
**요약** 한 줄 (예: PR 2개 중 1개 merge 가능, 마지막 배포 정상)

**merge 가능** — #12 할 일 목록: 🟡 MEDIUM 28 · 리뷰 ✅ · 프리뷰 <링크>
**조치 필요** — #13 결제 웹훅: 🟠 HIGH 52 · 리뷰 ✋ (보안 1건) · 롤백 계획 빠짐
**진행 중** — #14 …: CI ❌ auto-fix 2/3
**최근 배포** — 10/5 #11 ✅ / 10/4 #10 ↩️ 자동 롤백
**결정 필요** — 인증 방식 (decisions.md)

**다음 제안** 1~2개
```

- 사용자가 할 일(merge, CRITICAL 판단, 결정, 키 발급)은 굵게 표시한다.
- 장애·자동 롤백·🔥 배포·CRITICAL PR 은 맨 위에 올린다.
- Risk 점수는 숫자만 전하지 말고 가장 큰 위험 요인 한 가지를 같이 적는다.
- 추측하지 않는다. 확인 못 한 항목은 "확인 못 함" 이라고 쓴다.
