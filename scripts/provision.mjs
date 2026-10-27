// [템플릿 전용] 새 프로젝트의 Neon DB 와 Vercel 프로젝트를 만들고 서로, 그리고
// GitHub 리포지토리와 연결한다. new-project.yml 워크플로가 실행한다.
//
//   node scripts/provision.mjs --repo owner/name [--region aws-ap-southeast-1]
//   node scripts/provision.mjs --repo owner/name --protect
//       라벨(쓰지 않는 기본 라벨은 지움) + main 브랜치 규칙(ruleset): PR 필수, 필수 체크 test, force push·삭제 금지.
//       이미 있는 규칙은 갱신한다(예전 프로젝트의 필수 체크 risk-gate 도 이걸로 빠진다).
//       초기화 push 뒤에 실행한다(규칙이 먼저 걸리면 초기화 커밋을 main 에 push 할 수 없다).
//
// 필요한 환경변수:
//   GH_TOKEN        대상 리포지토리에 시크릿/변수를 쓸 수 있는 토큰
//   NEON_API_KEY    Personal(또는 Organization) 키. project-scoped 키로는 프로젝트를 못 만든다
//   VERCEL_TOKEN
//   NEON_ORG_ID     (선택) Neon 조직이 여러 개일 때
//   VERCEL_TEAM_ID  (선택) Vercel 팀 계정일 때
//
// 다시 실행해도 안전하다(같은 이름의 프로젝트가 있으면 재사용한다).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { connectionUris, neon, waitForOperations } from './neon.mjs';

const VERCEL_API = process.env.VERCEL_API_URL ?? 'https://api.vercel.com';

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function gh(argv, input) {
  execFileSync('gh', argv, { input, stdio: ['pipe', 'inherit', 'inherit'] });
}
const ghJson = (argv, input) =>
  JSON.parse(execFileSync('gh', argv, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }) || 'null');
const setSecret = (repo, key, value) => {
  gh(['secret', 'set', key, '-R', repo], value);
  console.log(`  secret ${key} → ${repo}`);
};
const setVariable = (repo, key, value) => {
  gh(['variable', 'set', key, '-R', repo, '--body', value]);
  console.log(`  variable ${key}=${value}`);
};

async function vercel(path, { method = 'GET', body } = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN 이 없습니다.');
  const url = new URL(`${VERCEL_API}${path}`);
  if (process.env.VERCEL_TEAM_ID) url.searchParams.set('teamId', process.env.VERCEL_TEAM_ID);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(`Vercel ${method} ${path} → HTTP ${res.status}: ${data.error?.message ?? ''}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------

async function provisionNeon({ name, region }) {
  console.log('\n▶ Neon');
  const { projects } = await neon(`/projects?search=${encodeURIComponent(name)}&limit=100`);
  let project = projects?.find((p) => p.name === name);

  if (project) {
    console.log(`  기존 프로젝트 재사용: ${project.id}`);
  } else {
    try {
      const created = await neon('/projects', {
        method: 'POST',
        body: {
          project: {
            name,
            region_id: region,
            pg_version: 17,
            ...(process.env.NEON_ORG_ID ? { org_id: process.env.NEON_ORG_ID } : {}),
          },
        },
      });
      await waitForOperations(created.project.id, created.operations);
      project = created.project;
      console.log(`  생성: ${project.id} (${region})`);
    } catch (error) {
      if (/project-scoped/i.test(error.message)) {
        throw new Error(
          'NEON_API_KEY 가 project-scoped 키라 프로젝트를 만들 수 없습니다. ' +
            'Neon 콘솔 → Account settings → API keys 에서 Personal 키를 만드세요.',
        );
      }
      throw error;
    }
  }

  const { branches } = await neon(`/projects/${project.id}/branches`);
  const main = branches.find((b) => b.default) ?? branches.find((b) => b.primary) ?? branches[0];
  const uris = await connectionUris(project.id, main.id);
  return { projectId: project.id, ...uris };
}

async function provisionVercel({ name }) {
  console.log('\n▶ Vercel');
  let project;
  try {
    // framework 를 비워 두면 첫 배포에서 CLI 가 projectSettings 를 요구하며 실패한다.
    project = await vercel('/v11/projects', { method: 'POST', body: { name, framework: 'nextjs' } });
    console.log(`  생성: ${project.id}`);
  } catch (error) {
    if (error.status !== 409) throw error;
    project = await vercel(`/v9/projects/${encodeURIComponent(name)}`);
    console.log(`  기존 프로젝트 재사용: ${project.id}`);
  }
  return { projectId: project.id, orgId: project.accountId };
}

async function setVercelEnv(projectId, key, value) {
  // production 에만 넣는다. preview 는 PR 마다 Neon 브랜치 연결 문자열을
  // 배포 단위로 주입한다(ci.yml 의 preview job). 여기서 preview 에도 프로덕션
  // 값을 넣으면 PR 미리보기가 실서비스 DB 에 쓰게 된다.
  const result = await vercel(`/v10/projects/${projectId}/env?upsert=true`, {
    method: 'POST',
    body: { key, value, type: 'encrypted', target: ['production'] },
  });
  if (result.failed?.length) throw new Error(`Vercel env ${key} 실패: ${JSON.stringify(result.failed)}`);
  console.log(`  Vercel env ${key} (production)`);
}

/**
 * 프리뷰·스테이징 URL 은 Vercel 배포 보호로 막혀 있다. CI 의 스모크 테스트가 들어갈 수 있도록
 * "Protection Bypass for Automation" 시크릿을 만들어 GitHub 시크릿에 넣는다. 이미 있으면 그대로 둔다.
 */
async function ensureBypassSecret(repo, projectId) {
  const existing = ghJson(['secret', 'list', '-R', repo, '--json', 'name']) ?? [];
  if (existing.some((s) => s.name === 'VERCEL_AUTOMATION_BYPASS_SECRET')) {
    console.log('  VERCEL_AUTOMATION_BYPASS_SECRET 이미 있음');
    return;
  }
  const secret = randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').padEnd(32, '0').slice(0, 32);
  console.log(`::add-mask::${secret}`);
  await vercel(`/v1/projects/${projectId}/protection-bypass`, {
    method: 'PATCH',
    body: { generate: { secret, note: 'GitHub Actions smoke tests' } },
  });
  setSecret(repo, 'VERCEL_AUTOMATION_BYPASS_SECRET', secret);
}

const LABELS = [
  ['risk:low', '2da44e', 'Risk Score LOW'],
  ['risk:medium', 'd4a72c', 'Risk Score MEDIUM'],
  ['risk:high', 'e16f24', 'Risk Score HIGH'],
  ['risk:very-high', 'cf222e', 'Risk Score VERY HIGH'],
  ['risk:critical', '6e0b0b', 'Risk Score CRITICAL'],
  ['no-autofix', 'bfdadc', 'CI 실패 시 Claude auto-fix 끄기'],
];
// 파이프라인이 쓰지 않는 라벨: GitHub 기본 라벨, Dependabot 이 만든 것, 예전 파이프라인의 것(merge 게이트·CI 품질 리뷰).
// ai-reviewed 는 PR 리뷰가 필요할 때 만든다.
const UNUSED_LABELS = [
  'bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted', 'invalid', 'question',
  'wontfix', 'accessibility', 'dependencies', 'javascript', 'github_actions',
  'risk-accepted', 'no-refine', 'quality-reviewed',
];

function ensureLabels(repo) {
  for (const [name, color, description] of LABELS) {
    try {
      gh(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
    } catch {
      console.log(`  ::warning::라벨 ${name} 생성 실패`);
    }
  }
  for (const name of UNUSED_LABELS) {
    try {
      execFileSync('gh', ['label', 'delete', name, '-R', repo, '--yes'], { stdio: 'ignore' });
      console.log(`  라벨 ${name} 삭제`);
    } catch {
      // 없는 라벨
    }
  }
}

/** main 보호 규칙. 비공개 리포는 GitHub Pro/Team 이상에서만 된다. */
function protectMain(repo) {
  const ruleset = {
    name: 'main protection',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: 'test' }],
        },
      },
    ],
  };
  const existing = ghJson(['api', `repos/${repo}/rulesets`]) ?? [];
  const found = existing.find((r) => r.name === ruleset.name);
  const path = found ? `repos/${repo}/rulesets/${found.id}` : `repos/${repo}/rulesets`;
  ghJson(['api', '-X', found ? 'PUT' : 'POST', path, '--input', '-'], JSON.stringify(ruleset));
  console.log(`  ruleset "${ruleset.name}" ${found ? '갱신' : '생성'} (필수 체크: test)`);
}

// ---------------------------------------------------------------------------

const { repo, region = 'aws-ap-southeast-1', protect } = args();
if (!repo || !repo.includes('/')) {
  console.error('usage: node scripts/provision.mjs --repo owner/name [--region <neon-region>]');
  process.exit(1);
}
const name = repo.split('/')[1];

async function provision() {
  const db = await provisionNeon({ name, region });
  // 연결 문자열에는 비밀번호가 있다. Actions 로그에 남지 않게 마스킹한다.
  console.log(`::add-mask::${db.direct}`);
  console.log(`::add-mask::${db.pooled}`);
  setVariable(repo, 'NEON_PROJECT_ID', db.projectId);
  // GitHub 시크릿 DATABASE_URL 은 deploy.yml 의 마이그레이션이 쓴다 → direct 연결.
  setSecret(repo, 'DATABASE_URL', db.direct);

  const app = await provisionVercel({ name });
  setVariable(repo, 'VERCEL_PROJECT_ID', app.projectId);
  setVariable(repo, 'VERCEL_ORG_ID', app.orgId);
  // 앱 런타임은 pooled 연결. 마이그레이션 도구를 앱 안에서 돌릴 일이 생기면 UNPOOLED 를 쓴다.
  await setVercelEnv(app.projectId, 'DATABASE_URL', db.pooled);
  await setVercelEnv(app.projectId, 'DATABASE_URL_UNPOOLED', db.direct);
  try {
    await ensureBypassSecret(repo, app.projectId);
  } catch (error) {
    // 없어도 배포는 된다(스모크 테스트만 건너뜀). 요약에서 알린다.
    console.log(`::warning::배포 보호 우회 시크릿을 만들지 못했습니다: ${error.message}`);
  }
  console.log('\n✅ 프로비저닝 완료');
}

try {
  if (protect) {
    ensureLabels(repo);
    protectMain(repo);
    console.log('\n✅ 브랜치 보호 완료');
  } else {
    await provision();
  }
} catch (error) {
  const hint = protect
    ? ' — 비공개 리포의 브랜치 규칙은 GitHub Pro(개인)/Team(조직) 이상이 필요합니다. docs/bootstrap/SETUP.md 참고.'
    : '';
  console.error(`::error::${error.message}${hint}`);
  process.exitCode = 1;
}
