// 배포·롤백 보조. deploy.yml / rollback.yml 이 쓴다.
//
//   node scripts/release.mjs production-domain
//       Vercel 프로젝트의 프로덕션 도메인(커스텀 도메인 우선)을 출력한다.
//   node scripts/release.mjs last-good [--skip <n>]
//       GitHub 의 production 환경 배포 기록에서 성공한 배포 URL 을 최근 순으로 찾아 출력한다.
//       --skip 1 이면 바로 이전 것(= 롤백 대상).
//
// 필요한 환경변수: production-domain → VERCEL_TOKEN, VERCEL_PROJECT_ID, (VERCEL_ORG_ID)
//                  last-good → GITHUB_TOKEN, GITHUB_REPOSITORY
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gh, repo } from './risk/github.mjs';

async function vercel(apiPath) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN 이 없습니다.');
  const url = new URL(`https://api.vercel.com${apiPath}`);
  // 팀 계정이면 팀 범위로 조회해야 한다(개인 계정의 orgId 는 team_ 로 시작하지 않는다).
  if (process.env.VERCEL_ORG_ID?.startsWith('team_')) url.searchParams.set('teamId', process.env.VERCEL_ORG_ID);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vercel GET ${apiPath} → HTTP ${res.status}: ${data.error?.message ?? ''}`);
  return data;
}

export function pickDomain(domains) {
  const usable = (domains ?? []).filter((d) => d.verified !== false && !d.redirect);
  return (usable.find((d) => !d.name.endsWith('.vercel.app')) ?? usable[0])?.name ?? '';
}

export async function productionDomain() {
  const project = process.env.VERCEL_PROJECT_ID;
  if (!project) throw new Error('VERCEL_PROJECT_ID 가 없습니다.');
  const { domains } = await vercel(`/v9/projects/${encodeURIComponent(project)}/domains?production=true`);
  return pickDomain(domains);
}

/** production 환경에서 성공으로 끝난 배포의 URL 들(최근 순). */
export async function goodDeployments(limit = 20) {
  const deployments = await gh(`/repos/${repo()}/deployments?environment=production&per_page=${limit}`);
  const urls = [];
  for (const d of deployments) {
    const [status] = await gh(`/repos/${repo()}/deployments/${d.id}/statuses?per_page=1`);
    if (status?.state === 'success' && status.environment_url?.startsWith('https://')) urls.push(status.environment_url);
  }
  return [...new Set(urls)];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'production-domain') {
      process.stdout.write(await productionDomain());
    } else if (command === 'last-good') {
      const skip = Number(rest[rest.indexOf('--skip') + 1] ?? 0) || 0;
      process.stdout.write((await goodDeployments())[skip] ?? '');
    } else {
      throw new Error(`알 수 없는 명령: ${command ?? '(없음)'} — production-domain | last-good`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
