// Risk Score CLI. pr-review.yml / risk-gate.yml 이 부른다(로컬에서 scan 만 따로 돌려 볼 수도 있다).
//
//   node scripts/risk/cli.mjs scan --base origin/main --head HEAD --out .review
//       diff 를 읽어 .review/facts.json, facts.md, pr.diff 를 만든다. (git 만 필요)
//   node scripts/risk/cli.mjs ci --run-id <id> [--meta ci-meta.json] --out .review/ci.json
//       트리거한 CI 실행의 job 결과와 프리뷰 정보를 모은다.
//   node scripts/risk/cli.mjs report --dir .review --pr <n> --sha <sha> [--review review.json] [--model <id>]
//       최종 점수 계산 → PR 종합 코멘트 갱신 → risk:* 라벨 → risk-gate 상태.
//   node scripts/risk/cli.mjs gate --pr <n> --sha <sha> --action <labeled|unlabeled|edited|synchronize> [--label x --actor login --actor-type User]
//       라벨·본문 변경 때 저장된 평가로 게이트만 다시 계산한다(LLM 호출 없음).
//
// 보안: 이 스크립트는 항상 main(기준 브랜치)의 코드로 실행된다. PR 의 코드는 git 데이터로만 읽고
// 실행하지 않는다. 그래서 PR 이 자기 평가 규칙을 바꿔 자기를 통과시킬 수 없다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gh, paginate, repo } from './github.mjs';
import { LEVELS, LEVEL_SLUGS } from './levels.mjs';
import { decodeData, renderFacts, renderSummary, SUMMARY_MARKER } from './render.mjs';
import { parseUnifiedDiff, scanChanges, sourceRoots } from './scan.mjs';
import { applyPolicy, finalize } from './score.mjs';

const ACCEPT_LABEL = 'risk-accepted';
const STATUS_CONTEXT = 'risk-gate';
const LABEL_COLORS = { low: '2da44e', medium: 'd4a72c', high: 'e16f24', 'very-high': 'cf222e', critical: '6e0b0b' };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  return out;
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

async function output(values) {
  const file = process.env.GITHUB_OUTPUT;
  for (const [k, v] of Object.entries(values)) {
    console.log(`${k}=${v}`);
    if (file) writeFileSync(file, `${k}=${v}\n`, { flag: 'a' });
  }
}

// ---------------------------------------------------------------------------
// scan

export function runScan({ base, head, out, configPath = path.join('.github', 'risk', 'config.json') }) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const mergeBase = git('merge-base', base, head).trim();
  const nameStatus = git('diff', '--name-status', '-M', '--no-color', mergeBase, head)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      return { status: status[0], path: b ?? a };
    });
  const diff = git('diff', '--no-color', '-U0', '-M', '--no-ext-diff', mergeBase, head, '--', '.', ':(exclude)package-lock.json');
  const files = parseUnifiedDiff(diff);

  const cache = new Map();
  const scan = scanChanges({
    files,
    changedPaths: nameStatus,
    readBase: (p) => tryGit('show', `${mergeBase}:${p}`),
    readHead: (p) => tryGit('show', `${head}:${p}`),
    baseReferences: (word) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return false;
      if (!cache.has(word)) {
        cache.set(word, tryGit('grep', '-q', '-w', '-i', '-e', word, mergeBase, '--', ...sourceRoots(config)) !== null);
      }
      return cache.get(word);
    },
    config,
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'facts.json'), JSON.stringify({ base: mergeBase, head: git('rev-parse', head).trim(), ...scan }, null, 2));
  writeFileSync(path.join(out, 'facts.md'), renderFacts(scan));
  // LLM 이 읽을 diff (lockfile 제외, 주변 5줄).
  writeFileSync(
    path.join(out, 'pr.diff'),
    git('diff', '--no-color', '-U5', '-M', mergeBase, head, '--', '.', ':(exclude)package-lock.json'),
  );
  return { mergeBase, scan };
}

// ---------------------------------------------------------------------------
// ci

const VERCEL_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app\/?$/;
const INSPECT_URL = /^https:\/\/vercel\.com\/[A-Za-z0-9._~\/-]+$/;

export async function collectCi({ runId, metaPath }) {
  const res = await gh(`/repos/${repo()}/actions/runs/${runId}/jobs?per_page=100`).catch(() => null);
  const jobList = res?.jobs ?? [];
  const conclusion = (name) => {
    const job = jobList.find((j) => j.name === name);
    if (!job) return 'missing';
    return job.status === 'completed' ? job.conclusion : 'pending';
  };
  const ci = {
    test: conclusion('test'),
    preview: conclusion('preview'),
    autofix: conclusion('Claude auto-fix'),
    previewUrl: null,
    inspectUrl: null,
    previewAt: null,
    deploy: null,
    migrate: null,
    smoke: null,
    runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo()}/actions/runs/${runId}`,
  };
  // 프리뷰 job 이 남긴 메타데이터. PR 쪽 실행이 만든 값이므로 형식을 검증해서만 쓴다.
  if (metaPath && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (typeof meta.preview_url === 'string' && VERCEL_URL.test(meta.preview_url)) ci.previewUrl = meta.preview_url;
      if (typeof meta.inspect_url === 'string' && INSPECT_URL.test(meta.inspect_url)) ci.inspectUrl = meta.inspect_url;
      for (const key of ['deploy', 'migrate', 'smoke']) {
        if (['success', 'failure', 'skipped', 'cancelled'].includes(meta[key])) ci[key] = meta[key];
      }
      if (typeof meta.finished_at === 'string' && !Number.isNaN(Date.parse(meta.finished_at))) ci.previewAt = meta.finished_at;
    } catch {
      // 메타데이터가 깨졌으면 무시한다.
    }
  }
  // test 가 통과했고 preview 가 실패하지 않았으면(건너뜀 포함) CI 통과로 본다.
  ci.ok = ci.test === 'success' && ['success', 'skipped', 'missing'].includes(ci.preview);
  return ci;
}

// ---------------------------------------------------------------------------
// PR 코멘트 · 라벨 · 상태

async function findSummary(pr) {
  const comments = await paginate(`/repos/${repo()}/issues/${pr}/comments`);
  // 우리 워크플로(github-actions[bot])가 쓴 것만 믿는다. 사람이 마커를 흉내 내도 무시된다.
  return comments.findLast((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(SUMMARY_MARKER)) ?? null;
}

async function upsertSummary(pr, existing, body) {
  if (existing) return gh(`/repos/${repo()}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  return gh(`/repos/${repo()}/issues/${pr}/comments`, { method: 'POST', body: { body } });
}

async function ensureLabel(name, color, description) {
  const found = await gh(`/repos/${repo()}/labels/${encodeURIComponent(name)}`, { allow404: true });
  if (!found) await gh(`/repos/${repo()}/labels`, { method: 'POST', body: { name, color, description } }).catch(() => null);
}

async function setRiskLabel(pr, level, current) {
  const want = `risk:${LEVEL_SLUGS[level]}`;
  for (const name of current) {
    if (name.startsWith('risk:') && name !== want) {
      await gh(`/repos/${repo()}/issues/${pr}/labels/${encodeURIComponent(name)}`, { method: 'DELETE', allow404: true });
    }
  }
  if (!current.includes(want)) {
    await ensureLabel(want, LABEL_COLORS[LEVEL_SLUGS[level]], `Risk Score ${level.replace('_', ' ')}`);
    await gh(`/repos/${repo()}/issues/${pr}/labels`, { method: 'POST', body: { labels: [want] } });
  }
}

async function removeLabel(pr, name) {
  await gh(`/repos/${repo()}/issues/${pr}/labels/${encodeURIComponent(name)}`, { method: 'DELETE', allow404: true });
}

async function setStatus(sha, state, description, targetUrl) {
  await gh(`/repos/${repo()}/statuses/${sha}`, {
    method: 'POST',
    body: { state, context: STATUS_CONTEXT, description: description.slice(0, 140), ...(targetUrl ? { target_url: targetUrl } : {}) },
  });
}

const repoUrl = () => `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo()}`;

async function publish({ pr, prData, assessment, ci, previous, acceptance, existing }) {
  const gate = applyPolicy(assessment, { prBody: prData.body ?? '', acceptance, ciOk: ci.ok });
  const body = renderSummary({ assessment, gate, ci, previous, acceptance, repoUrl: repoUrl() });
  const comment = await upsertSummary(pr, existing, body);
  await setRiskLabel(pr, gate.level, (prData.labels ?? []).map((l) => l.name));
  await setStatus(assessment.sha, gate.state, gate.description, comment?.html_url);
  return gate;
}

// ---------------------------------------------------------------------------
// report

export async function runReport({ dir, pr, sha, reviewPath, model }) {
  const facts = JSON.parse(readFileSync(path.join(dir, 'facts.json'), 'utf8'));
  const ci = existsSync(path.join(dir, 'ci.json')) ? JSON.parse(readFileSync(path.join(dir, 'ci.json'), 'utf8')) : { test: 'missing', preview: 'missing', ok: false };
  let review = null;
  if (reviewPath && existsSync(reviewPath)) {
    try {
      const text = readFileSync(reviewPath, 'utf8').trim();
      review = text ? JSON.parse(text) : null;
    } catch (error) {
      console.log(`::warning::AI 리뷰 결과를 읽지 못했습니다: ${error.message}`);
    }
  }

  const prData = await gh(`/repos/${repo()}/pulls/${pr}`);
  if (prData.head.sha !== sha) {
    // 그 사이 새 커밋이 들어왔다. 이 평가는 낡았으니 게시하지 않는다(새 CI 가 다시 평가한다).
    console.log(`PR head 가 ${prData.head.sha.slice(0, 7)} 로 바뀌어 ${sha.slice(0, 7)} 평가는 게시하지 않습니다.`);
    return null;
  }

  const existing = await findSummary(pr);
  const prev = existing ? decodeData(existing.body) : null;
  const previous = prev?.assessment ? { sha: prev.assessment.sha, total: prev.assessment.total, level: prev.assessment.level } : null;

  // 수락은 특정 커밋에 대한 것이다. 새 커밋이 오면 수락을 해제한다.
  let acceptance = prev?.acceptance?.sha === sha ? prev.acceptance : null;
  const labels = (prData.labels ?? []).map((l) => l.name);
  if (!acceptance && labels.includes(ACCEPT_LABEL)) {
    await removeLabel(pr, ACCEPT_LABEL);
    prData.labels = prData.labels.filter((l) => l.name !== ACCEPT_LABEL);
    acceptance = null;
  }

  const assessment = finalize({ scan: facts, review, sha, ci, model: review ? model : null });
  const gate = await publish({ pr, prData, assessment, ci, previous, acceptance, existing });
  console.log(`Risk ${assessment.total}/100 ${gate.level} · gate ${gate.state}: ${gate.description}`);
  return { assessment, gate };
}

// ---------------------------------------------------------------------------
// gate (라벨·본문 변경)

/** risk-accepted 를 붙일 수 있는 사람인가: 봇이 아니고 admin/maintain 권한. */
export async function canAccept(login, actorType) {
  if (!login || login.endsWith('[bot]') || (actorType && actorType !== 'User')) return false;
  // 개인 리포지토리의 소유자는 항상 admin 이다(권한 API 를 부르지 않아도 된다).
  if (login.toLowerCase() === repo().split('/')[0].toLowerCase()) return true;
  try {
    const res = await gh(`/repos/${repo()}/collaborators/${encodeURIComponent(login)}/permission`, { allow404: true });
    return Boolean(res) && res.user?.type === 'User' && ['admin', 'maintain'].includes(res.permission);
  } catch (error) {
    console.log(`::warning::권한을 확인하지 못했습니다(${error.message}). 수락하지 않습니다.`);
    return false;
  }
}

export async function runGate({ pr, sha, action, label, actor, actorType }) {
  if (action === 'synchronize' || action === 'opened' || action === 'reopened') {
    await setStatus(sha, 'pending', 'CI 와 리뷰가 끝나면 Risk Score 로 평가합니다');
    return;
  }
  if (!['labeled', 'unlabeled', 'edited'].includes(action)) return;

  const prData = await gh(`/repos/${repo()}/pulls/${pr}`);
  const existing = await findSummary(pr);
  const data = existing ? decodeData(existing.body) : null;
  const assessed = data?.assessment?.sha === sha;

  if (action === 'labeled' && label === ACCEPT_LABEL) {
    const allowed = await canAccept(actor, actorType);
    if (!allowed || !assessed) {
      await removeLabel(pr, ACCEPT_LABEL);
      const why = !allowed
        ? `@${actor} 는 수락 권한이 없습니다(관리자·maintainer 사람 계정만, 봇·에이전트 불가).`
        : '이 커밋의 Risk 평가가 아직 끝나지 않았습니다. 평가 코멘트가 갱신된 뒤 다시 붙여 주세요.';
      await gh(`/repos/${repo()}/issues/${pr}/comments`, { method: 'POST', body: { body: `\`${ACCEPT_LABEL}\` 라벨을 떼었습니다 — ${why}` } });
      return;
    }
    data.acceptance = { by: actor, sha };
  } else if (action === 'unlabeled' && label === ACCEPT_LABEL) {
    if (data) data.acceptance = null;
  }

  if (!assessed) {
    console.log('현재 커밋의 평가가 아직 없습니다. 평가가 끝나면 report 가 게이트를 정합니다.');
    return;
  }
  const gate = await publish({
    pr,
    prData,
    assessment: data.assessment,
    ci: data.ci,
    previous: null,
    acceptance: data.acceptance ?? null,
    existing,
  });
  console.log(`gate ${gate.state}: ${gate.description}`);
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  try {
    if (command === 'scan') {
      const { scan } = runScan({ base: a.base ?? 'origin/main', head: a.head ?? 'HEAD', out: a.out ?? '.review' });
      const level = scan.preliminaryLevel;
      await output({
        preliminary_level: level,
        floor_total: scan.floorTotal,
        runtime_changed: scan.runtimeChanged,
        high_risk: LEVELS.indexOf(level) >= LEVELS.indexOf('HIGH'),
      });
      if (!process.env.GITHUB_ACTIONS) console.log(`\n${readFileSync(path.join(a.out ?? '.review', 'facts.md'), 'utf8')}`);
    } else if (command === 'ci') {
      const ci = await collectCi({ runId: a['run-id'], metaPath: a.meta });
      writeFileSync(a.out ?? '.review/ci.json', JSON.stringify(ci, null, 2));
      await output({ ci_ok: ci.ok, test: ci.test, preview: ci.preview });
    } else if (command === 'report') {
      await runReport({ dir: a.dir ?? '.review', pr: a.pr, sha: a.sha, reviewPath: a.review, model: a.model });
    } else if (command === 'gate') {
      await runGate({ pr: a.pr, sha: a.sha, action: a.action, label: a.label, actor: a.actor, actorType: a['actor-type'] });
    } else {
      throw new Error(`알 수 없는 명령: ${command ?? '(없음)'} — scan | ci | report | gate`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
