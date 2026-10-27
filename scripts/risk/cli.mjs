// Risk Score CLI. pr-review.yml 이 부른다(로컬에서 scan 만 따로 돌려 볼 수도 있다).
//
//   node scripts/risk/cli.mjs scan --base origin/main --head HEAD --out .review
//       diff 를 읽어 .review/facts.json, facts.md, pr.diff 를 만든다. (git 만 필요)
//   node scripts/risk/cli.mjs ci --run-id <id> [--meta ci-meta.json] --out .review/ci.json
//       트리거한 CI 실행의 job 결과와 프리뷰 정보를 모은다.
//   node scripts/risk/cli.mjs report --dir .review --pr <n> --sha <sha> [--review review.json] [--model <id>]
//       최종 점수 계산 → PR 종합 코멘트 갱신 → risk:* 라벨. merge 를 막지는 않는다(판단은 사람이 코멘트를 보고 한다).
//       AI 리뷰는 PR 당 1회: 새로 리뷰했으면 PR 에 `ai-reviewed` 라벨을 붙이고, 이번에 리뷰하지 않았으면(PR 당 1회로
//       건너뜀·CI 실패·draft) 직전 종합 코멘트의 AI 평가를 이어 쓴다(규칙 스캔·CI 는 이번 커밋 것).
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

const repoUrl = () => `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo()}`;

async function publish({ pr, prData, assessment, ci, previous, existing }) {
  const checks = applyPolicy(assessment, { prBody: prData.body ?? '', ciOk: ci.ok });
  const body = renderSummary({ assessment, checks, ci, previous, repoUrl: repoUrl() });
  await upsertSummary(pr, existing, body);
  await setRiskLabel(pr, checks.level, (prData.labels ?? []).map((l) => l.name));
  return checks;
}

// ---------------------------------------------------------------------------
// report

const REVIEWED_LABEL = 'ai-reviewed';

/** 저장된 평가(assessment)에서 AI 리뷰 결과를 다시 만든다 — finalize 에 그대로 넣으면 같은 factor 점수가 나온다. */
export function previousReview(assessment) {
  if (!assessment?.review) return null;
  const factors = {};
  for (const [name, f] of Object.entries(assessment.factors ?? {})) {
    if (f.llm != null) factors[name] = { score: f.llm, evidence: f.evidence, confidence: f.confidence };
  }
  // AI 가 건 hard override 도 되살린다(빠지면 이어 쓰는 push 마다 등급이 내려간다).
  const overrides = (assessment.overrides ?? [])
    .filter((o) => o.source === 'review')
    .map(({ level, condition, evidence }) => ({ level, condition, evidence }));
  const r = assessment.review;
  return {
    summary: r.summary,
    verdict: r.verdict,
    findings: r.findings,
    risk: { factors, overrides, drivers: r.drivers, mitigations: r.mitigations, unknowns: r.unknowns, affected: r.affected },
  };
}

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

  // AI 리뷰는 PR 당 1회. 이번에 리뷰하지 않았으면 이유(PR 당 1회·CI 실패·draft)와 상관없이 직전 AI 평가를 이어 쓰고
  // 어느 커밋을 본 것인지 남긴다 — CI 가 한 번 실패한 push 가 AI 평가를 덮어써 잃지 않게.
  // 라벨은 리뷰가 통과(approve)했을 때만 붙인다 — "수정 필요" 면 지적을 고친 다음 push 에서 다시 리뷰해야 하므로.
  let reviewSha = review ? sha : null;
  const labeled = (prData.labels ?? []).some((l) => l.name === REVIEWED_LABEL);
  if (review && review.verdict === 'approve') {
    await ensureLabel(REVIEWED_LABEL, 'c5def5', 'AI 리뷰를 마침 (떼고 push 하면 다시 리뷰)');
    await gh(`/repos/${repo()}/issues/${pr}/labels`, { method: 'POST', body: { labels: [REVIEWED_LABEL] } });
  } else if (review) {
    if (labeled) await gh(`/repos/${repo()}/issues/${pr}/labels/${REVIEWED_LABEL}`, { method: 'DELETE', allow404: true });
  } else if (prev?.assessment?.review) {
    review = previousReview(prev.assessment);
    model = prev.assessment.model;
    reviewSha = prev.assessment.reviewSha ?? prev.assessment.sha;
  } else if (labeled) {
    // 라벨은 있는데 이어 쓸 AI 평가가 없다(코멘트가 지워졌거나 사람이 붙임) → 떼어서 다음 push 에 다시 리뷰한다.
    await gh(`/repos/${repo()}/issues/${pr}/labels/${REVIEWED_LABEL}`, { method: 'DELETE', allow404: true });
  }

  const assessment = { ...finalize({ scan: facts, review, sha, ci, model: review ? model : null }), reviewSha };
  const checks = await publish({ pr, prData, assessment, ci, previous, existing });
  console.log(`Risk ${assessment.total}/100 ${checks.level}: ${checks.description}`);
  return { assessment, checks };
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
    } else {
      throw new Error(`알 수 없는 명령: ${command ?? '(없음)'} — scan | ci | report`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
