// PR 이 문서만 바꿨는지 판정한다. 문서만 바뀌었으면 CI 가 설치·빌드·테스트·프리뷰·품질 리뷰를 건너뛴다
// (Actions 사용 시간 절약). `test` job 자체는 돌아서 필수 체크는 그대로 통과한다.
//
//   BASE=<base sha> node scripts/ci-scope.mjs   →  GITHUB_OUTPUT 에 docs_only=true|false
//
// 확실하지 않으면(파일 목록을 못 얻음, 빈 목록) false — 전체 CI 를 돈다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 문서로 보는 곳만 나열한다: docs/, .claude/ 의 *.md(세션 지침 — settings.json·훅은 아니다), 루트의 *.md, LICENSE.
// 그 밖의 .md(리뷰 프롬프트·rubric, 빌드 때 읽는 콘텐츠 등)는 앱·파이프라인에 영향이 있을 수 있어 문서로 보지 않는다.
const DOCS = /^docs\/|^\.claude\/.*\.md$|^[^/]+\.md$|^LICENSE$/i;

/** 바뀐 파일이 모두 문서인가 */
export function isDocsOnly(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  return list.length > 0 && list.every((f) => DOCS.test(f));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let docsOnly = false;
  try {
    // --no-renames: 이름 변경을 삭제+추가로 보여 옛 경로도 목록에 남는다(코드를 docs/ 로 옮긴 PR 을 문서로 보지 않게).
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${process.env.BASE}...HEAD`], { encoding: 'utf8' });
    docsOnly = isDocsOnly(out.split('\n'));
  } catch (error) {
    console.log(`::warning::바뀐 파일 목록을 얻지 못해 전체 CI 를 돈다: ${error.message}`);
  }
  console.log(`문서만 바뀜: ${docsOnly}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  if (docsOnly && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      '### 📝 문서만 바뀜\n\n설치·lint·typecheck·test·build·프리뷰·품질 리뷰를 건너뜁니다.\n',
    );
  }
}
