---
name: new-project
description: production-bootstrap 템플릿 리포지토리에서, 사용자가 새 운영용 프로젝트(실제 사용자가 쓰는 서비스)를 만들어 달라고 할 때 사용한다. new-project 워크플로를 실행해 GitHub 리포지토리·Neon DB·Vercel 프로젝트·브랜치 규칙을 한 번에 만든다.
---

# 새 프로젝트 만들기

클라우드 세션은 GitHub 프록시 때문에 리포지토리를 직접 만들 수 없다(`gh repo create` 403).
대신 이 리포지토리의 `new-project.yml` 워크플로를 dispatch 한다. Actions 러너에는 프록시가 없다.

## 1. 입력 정하기

- **name**: 소문자/숫자/하이픈 (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`). 리포지토리·Vercel·Neon 이름이 된다.
  사용자가 준 이름이 규칙에 안 맞으면 고친 이름을 제안하고 확인받는다.
- **description**: 한 줄. 사용자가 설명한 앱의 목적.
- **visibility**: 기본 private. (비공개 리포의 브랜치 규칙은 GitHub Pro/Team 이 필요하다 — 없으면 워크플로 요약에 경고가 남는다.)

이름이 이미 있는 리포지토리와 겹치면 워크플로가 **그 리포지토리를 재사용**한다(재실행용 동작).
새 프로젝트인데 이름이 겹치면 다른 이름을 제안한다.

## 2. 실행

`gh workflow run` 은 GraphQL 을 써서 클라우드 세션에서 403 이 난다. REST 로 dispatch 한다:

```bash
node scripts/gh.mjs dispatch new-project.yml name=<name> description="<설명>"
sleep 8
gh run list --workflow new-project.yml --limit 1      # REST 라서 된다
gh run watch <run-id> --exit-status
```

dispatch 가 안 되면 사용자에게 GitHub → Actions → New project → Run workflow 로
직접 실행해 달라고 안내한다.

실패하면 실패한 스텝 로그(`gh run view <id> --log-failed`)를 읽고 원인을 설명한다.
같은 이름으로 다시 실행하면 이미 된 부분은 재사용하고 나머지만 채운다.

## 3. 이 세션에서 계속 개발할 수 있는지 확인

`add_repo`(또는 이름이 비슷한, 세션에 리포지토리를 새로 붙이는) 도구가 **지금 이 세션에
있는지** 본다.

**있으면 — 같은 세션에서 바로 이어간다:**

1. `add_repo` 로 방금 만든 `<owner>/<name>` 을 붙인다(push 권한으로).
2. 안내받은 대로 clone 하고, `register_repo_root` 같은 도구가 있으면 호출해 그
   리포지토리의 CLAUDE.md·스킬을 이 세션에 불러온다.
3. 첫 배포(`deploy.yml`)가 아직 안 끝났을 수 있다 — `gh run list -R <owner>/<name>
   --workflow deploy.yml --limit 1` 로 확인하고, 진행 중이면 잠깐 기다린다.
4. 이제 이 세션은 새 프로젝트 리포지토리에서 작업하는 세션이 됐다. **production-bootstrap 이
   아니라 새로 불러온 CLAUDE.md 의 규칙**(브랜치 → 구현 → PR, merge 는 사용자)을 따라
   사용자가 애초에 설명한 앱을 실제로 만들기 시작한다 — 여기서 멈추고 "이제 개발하세요"
   라고 안내하지 않는다. 단, 첫 기능 전에 `docs/decisions.md` 의 미결(특히 **인증**)을 먼저 묻는다.
5. 사용자에게는 한 번에 알린다: 리포지토리가 만들어졌고, 같은 세션에서 이어서 개발을
   시작한다는 것.

**없으면 (`gh repo create` 만 막혀 있고 세션에 리포지토리 추가 기능 자체가 없는 경우,
예: Slack, claude.ai/code 의 일반 채팅 세션):**

run 요약(`gh run view <id>`)에서 확인해 알린다:

- 리포지토리 URL, 프로비저닝 결과, 빠진 시크릿, main 보호 규칙 결과
- 첫 배포는 새 리포지토리의 Deploy 워크플로가 이어서 한다(1~3분).
- **다음 단계**: claude.ai/code 에서 새 세션을 열고 `<owner>/<name>` 을 골라 개발을 요청.
  이 세션은 production-bootstrap 에 붙어 있고 다른 리포지토리를 붙일 수단이 없으므로,
  새 프로젝트 개발은 새 세션에서 해야 한다.

## 사용자에게 남는 일 (체크리스트로 알린다)

새 리포지토리의 `docs/runbook.md` "처음 한 번": Sentry DSN, 업타임 모니터, 커스텀 도메인,
Neon 플랜/PITR, Vercel Spend Management. 브랜치 규칙이 실패했으면 요금제.

## 이 세션에서 인프라를 추가로 정하는 경우

사용자가 만들 앱을 설명하면서 인증·스토리지 등을 언급하면, 프로젝트를 만든 뒤
(3번의 어느 경로든) **새 프로젝트의 컨텍스트에서** 결정하도록 한다(그 결정은
그 프로젝트의 `docs/decisions.md` 에 남는다).
