// 배포·롤백 보조. deploy.yml / rollback.yml 이 쓴다.
//
//   node scripts/release.mjs production-domain
//       Vercel 프로젝트의 프로덕션 도메인(커스텀 도메인 우선)을 출력한다.
//   node scripts/release.mjs last-good [--skip <n>]
//       GitHub 의 production 환경 배포 기록에서 성공한 배포 URL 을 최근 순으로 찾아 출력한다.
//       --skip 1 이면 바로 이전 것(= 롤백 대상).
//   node scripts/release.mjs promote <배포 URL|ID>
//   node scripts/release.mjs rollback <배포 URL|ID>
//       프로덕션 트래픽을 그 배포로 옮기고 끝날 때까지(최대 5분) 기다린다.
//       `vercel promote/rollback` CLI 대신 REST API 를 쓴다 — CLI 는 먼저 토큰의 "사용자" 를 조회하는데,
//       팀 범위 토큰 등에서는 그 조회가 `User not found` 로 실패한다(배포 자체는 같은 토큰으로 된다).
//
// 필요한 환경변수: production-domain·promote·rollback → VERCEL_TOKEN, VERCEL_PROJECT_ID, (VERCEL_ORG_ID)
//                  last-good → GITHUB_TOKEN, GITHUB_REPOSITORY
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gh, repo } from './risk/github.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 조회(GET)는 일시적 오류(네트워크, 429, 5xx)면 몇 번 다시 시도한다. 변경 요청(POST)은 한 번만 보낸다. */
async function vercel(apiPath, { method = 'GET', retries = method === 'GET' ? 3 : 0, retryDelayMs = 2_000 } = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN 이 없습니다.');
  const url = new URL(`https://api.vercel.com${apiPath}`);
  // 팀 계정이면 팀 범위로 조회해야 한다(개인 계정의 orgId 는 team_ 로 시작하지 않는다).
  if (process.env.VERCEL_ORG_ID?.startsWith('team_')) url.searchParams.set('teamId', process.env.VERCEL_ORG_ID);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1));
      continue;
    }
    throw new Error(`Vercel ${method} ${apiPath} → HTTP ${res.status}: ${data.error?.message ?? ''}`);
  }
}

function projectId() {
  const project = process.env.VERCEL_PROJECT_ID;
  if (!project) throw new Error('VERCEL_PROJECT_ID 가 없습니다.');
  return project;
}

export function pickDomain(domains) {
  const usable = (domains ?? []).filter((d) => d.verified !== false && !d.redirect);
  return (usable.find((d) => !d.name.endsWith('.vercel.app')) ?? usable[0])?.name ?? '';
}

export async function productionDomain() {
  const { domains } = await vercel(`/v9/projects/${encodeURIComponent(projectId())}/domains?production=true`);
  return pickDomain(domains);
}

/** 배포 URL(https://… 또는 호스트) 이나 dpl_ ID → API 가 받는 식별자 */
export function deploymentRef(urlOrId) {
  const value = String(urlOrId ?? '').trim();
  if (!value) throw new Error('배포 URL 또는 ID 가 없습니다.');
  return value.startsWith('dpl_') ? value : value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/**
 * 프로젝트의 마지막 별칭 작업(promote/rollback)이 이 배포로 끝났는지.
 * 'done' | 'pending' | 실패면 Error 를 던진다.
 */
export function aliasJobState(project, deploymentId, requestedAfter) {
  // 작업 기록 모양과 상관없이, 프로덕션이 이미 이 배포를 가리키면 끝난 것이다.
  if (project?.targets?.production?.id === deploymentId) return 'done';
  const job = project?.lastAliasRequest;
  if (!job || job.toDeploymentId !== deploymentId || (job.requestedAt ?? 0) < requestedAfter) return 'pending';
  if (job.jobStatus === 'succeeded') return 'done';
  if (job.jobStatus === 'pending' || job.jobStatus === 'in-progress') return 'pending';
  throw new Error(`${job.type ?? '전환'} 작업이 ${job.jobStatus ?? '알 수 없는 상태'} 로 끝났습니다.`);
}

/**
 * 프로덕션 트래픽을 그 배포로 옮기고 끝날 때까지 기다린다.
 * @param {'promote' | 'rollback'} kind
 * @param {string} urlOrId
 * @param {{ timeoutMs?: number, intervalMs?: number, retryDelayMs?: number }} [options]
 */
export async function moveProduction(kind, urlOrId, { timeoutMs = 300_000, intervalMs = 5_000, retryDelayMs } = {}) {
  const get = (apiPath) => vercel(apiPath, { retryDelayMs });
  const deployment = await get(`/v13/deployments/${encodeURIComponent(deploymentRef(urlOrId))}`);
  const project = projectId();
  // VERCEL_PROJECT_ID 가 이름일 수도 있어서 ID(prj_)일 때만 비교한다.
  const owner = deployment.projectId ?? deployment.project?.id;
  if (project.startsWith('prj_') && owner && owner !== project) {
    throw new Error(`배포 ${deployment.url} 는 이 프로젝트의 것이 아닙니다.`);
  }
  if (kind === 'promote' && deployment.target !== 'production') {
    throw new Error(`배포 ${deployment.url} 는 프로덕션 빌드가 아니라 승격할 수 없습니다(vercel deploy --prod 로 만든 것만).`);
  }
  const requestedAfter = Date.now() - 60_000; // 시계 차이 여유
  await vercel(`/${kind === 'promote' ? 'v10' : 'v9'}/projects/${encodeURIComponent(project)}/${kind}/${deployment.id}`, { method: 'POST' });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = aliasJobState(await get(`/v9/projects/${encodeURIComponent(project)}`), deployment.id, requestedAfter);
    if (state === 'done') return deployment;
    if (Date.now() >= deadline) throw new Error(`${kind} 가 ${timeoutMs / 1000}초 안에 끝나지 않았습니다(Vercel 대시보드에서 상태 확인).`);
    await sleep(intervalMs);
  }
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
    } else if (command === 'promote' || command === 'rollback') {
      const deployment = await moveProduction(command, rest[0]);
      console.log(`${command === 'promote' ? '승격' : '롤백'} 완료: https://${deployment.url} (${deployment.id})`);
    } else {
      throw new Error(`알 수 없는 명령: ${command ?? '(없음)'} — production-domain | last-good | promote | rollback`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
