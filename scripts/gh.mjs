// Claude 클라우드 세션용 GitHub 헬퍼 (REST 만 사용).
//
// 클라우드 세션의 GitHub 프록시는 GraphQL 을 막는다. `gh pr create`, `gh pr list`,
// `gh pr checks`, `gh workflow run` 은 GraphQL 을 쓰므로 403 이 난다.
// 이 스크립트는 같은 일을 `gh api`(REST)로 한다. 로컬에서도 그대로 동작한다.
//
//   node scripts/gh.mjs pr-create --title "feat: ..." --body-file /tmp/body.md [--draft]
//   node scripts/gh.mjs pr-list                       열린 PR + 각 PR 의 CI 상태
//   node scripts/gh.mjs pr-status [<번호>]             체크 결과 + 프리뷰 코멘트 (번호 없으면 현재 브랜치)
//   node scripts/gh.mjs pr-watch [<번호>]              체크가 끝날 때까지 기다린 뒤 pr-status
//   node scripts/gh.mjs deploys                       최근 main 배포 결과
//   node scripts/gh.mjs risk-history [--limit 20]     merge 된 PR 의 Risk 등급과 배포 결과 (점수 보정용)
//   node scripts/gh.mjs dispatch <workflow.yml> [key=value ...]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}
const api = (path, ...rest) => JSON.parse(gh(['api', path, ...rest]) || 'null');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function repo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git('remote', 'get-url', 'origin');
  const match = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`origin 에서 owner/repo 를 알 수 없습니다: ${url}`);
  return match[1];
}

function currentPr(R) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const [owner] = R.split('/');
  const prs = api(`repos/${R}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`);
  if (!prs.length) throw new Error(`브랜치 ${branch} 에 열린 PR 이 없습니다.`);
  return prs[0].number;
}

function checks(R, sha) {
  const { check_runs: runs } = api(`repos/${R}/commits/${sha}/check-runs?per_page=100`);
  return runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url }));
}

const icon = (c) =>
  c.status !== 'completed' ? '⏳' : ({ success: '✅', skipped: '⏭️', neutral: '➖' })[c.conclusion] ?? '❌';

function summarizeChecks(list) {
  if (!list.length) return '체크 없음';
  return list.map((c) => `${icon(c)} ${c.name}`).join('  ');
}

function statuses(R, sha) {
  const { statuses: list = [] } = api(`repos/${R}/commits/${sha}/status`) ?? {};
  return list.map((s) => ({ name: s.context, status: s.state === 'pending' ? 'in_progress' : 'completed', conclusion: s.state, description: s.description }));
}

/** pr-review.yml 이 남긴 PR 종합 코멘트에서 Risk 평가를 꺼낸다. */
function riskSummary(R, number) {
  const comments = api(`repos/${R}/issues/${number}/comments?per_page=100`);
  const summary = comments.findLast((c) => c.user?.login === 'github-actions[bot]' && c.body.startsWith('<!-- pr-summary -->'));
  if (!summary) return null;
  const m = summary.body.match(/<!-- risk-data:([A-Za-z0-9+/=]+) -->/);
  let data = null;
  try {
    data = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
  } catch {
    data = null;
  }
  return { url: summary.html_url, headline: summary.body.split('\n')[1]?.replace(/^## /, '') ?? '', data };
}

function prStatus(R, number) {
  const pr = api(`repos/${R}/pulls/${number}`);
  console.log(`#${pr.number} ${pr.title}${pr.draft ? ' (draft)' : ''}\n${pr.html_url}`);
  console.log(`브랜치 ${pr.head.ref} @ ${pr.head.sha.slice(0, 7)} · mergeable: ${pr.mergeable_state}`);
  for (const c of [...checks(R, pr.head.sha), ...statuses(R, pr.head.sha)]) {
    console.log(`  ${icon(c)} ${c.name} — ${c.description ?? c.conclusion ?? c.status}`);
  }
  const risk = riskSummary(R, number);
  if (!risk) {
    console.log('\nPR 종합 코멘트(리뷰 · Risk) 아직 없음 — CI 가 끝나면 붙습니다.');
    return;
  }
  console.log(`\n${risk.headline}`);
  const a = risk.data?.assessment;
  if (a) {
    if (a.sha !== pr.head.sha) console.log(`  (주의: ${a.sha.slice(0, 7)} 기준 평가 — 최신 커밋은 평가 대기 중)`);
    if (a.ci?.previewUrl) console.log(`  프리뷰: ${a.ci.previewUrl}`);
    for (const f of a.review?.findings ?? []) console.log(`  - [${f.severity}] ${f.location} ${f.issue}`);
  }
  console.log(`  ${risk.url}`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else flags[key] = rest[++i];
  } else positional.push(rest[i]);
}

try {
  const R = repo();
  switch (command) {
    case 'pr-create': {
      const head = git('rev-parse', '--abbrev-ref', 'HEAD');
      if (head === 'main') throw new Error('main 에서는 PR 을 만들 수 없습니다. 브랜치를 먼저 만드세요.');
      if (!flags.title) throw new Error('--title 이 필요합니다.');
      const body = flags['body-file'] ? readFileSync(flags['body-file'], 'utf8') : (flags.body ?? '');
      const payload = JSON.stringify({ title: flags.title, head, base: flags.base ?? 'main', body, draft: Boolean(flags.draft) });
      const pr = JSON.parse(gh(['api', '-X', 'POST', `repos/${R}/pulls`, '--input', '-'], { input: payload }));
      console.log(`PR #${pr.number} 생성: ${pr.html_url}`);
      break;
    }
    case 'pr-list': {
      const prs = api(`repos/${R}/pulls?state=open&per_page=50`);
      if (!prs.length) console.log('열린 PR 없음');
      for (const pr of prs) {
        const risk = pr.labels.map((l) => l.name).find((n) => n.startsWith('risk:')) ?? 'risk:평가 전';
        console.log(`#${pr.number} ${pr.title}${pr.draft ? ' (draft)' : ''} — ${risk} — ${summarizeChecks([...checks(R, pr.head.sha), ...statuses(R, pr.head.sha)])}`);
        console.log(`   ${pr.html_url}`);
      }
      break;
    }
    case 'pr-status':
      prStatus(R, positional[0] ?? currentPr(R));
      break;
    case 'pr-watch': {
      const number = positional[0] ?? currentPr(R);
      const deadline = Date.now() + 30 * 60_000;
      for (;;) {
        const { head } = api(`repos/${R}/pulls/${number}`);
        const list = [...checks(R, head.sha), ...statuses(R, head.sha)];
        // risk-gate 는 PR 리뷰가 끝날 때까지 pending 이다. 그것까지 기다린다.
        const pending = list.filter((c) => c.status !== 'completed');
        if (list.length && !pending.length) break;
        if (Date.now() > deadline) {
          console.log('30분이 지나 기다리기를 멈춥니다.');
          break;
        }
        process.stdout.write(`대기 중: ${pending.map((c) => c.name).join(', ') || '체크 시작 전'}\n`);
        await new Promise((r) => setTimeout(r, 20_000));
      }
      prStatus(R, number);
      break;
    }
    case 'deploys': {
      let runs;
      try {
        ({ workflow_runs: runs } = api(`repos/${R}/actions/workflows/deploy.yml/runs?per_page=5`));
      } catch {
        console.log('deploy.yml 실행 기록을 읽지 못했습니다 (워크플로 없음 또는 권한).');
        break;
      }
      for (const run of runs) {
        const mark = run.status !== 'completed' ? '⏳' : run.conclusion === 'success' ? '✅' : '❌';
        console.log(`${mark} ${run.created_at.slice(0, 16).replace('T', ' ')} ${run.head_sha.slice(0, 7)} ${run.display_title}\n   ${run.html_url}`);
      }
      if (!runs.length) console.log('배포 기록 없음');
      break;
    }
    case 'risk-history': {
      // 점수 보정용: merge 된 PR 의 등급과 그 배포가 어떻게 끝났는지 나란히 본다.
      const limit = Number(flags.limit ?? 20);
      const prs = api(`repos/${R}/pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(limit * 2, 100)}`)
        .filter((p) => p.merged_at)
        .slice(0, limit);
      for (const pr of prs) {
        const risk = pr.labels.map((l) => l.name).find((n) => n.startsWith('risk:')) ?? 'risk:?';
        const comments = api(`repos/${R}/issues/${pr.number}/comments?per_page=100`);
        const deploy = comments.findLast((c) => /^(🚀|↩️|🔥|⛔|❌)/.test(c.body))?.body.slice(0, 2) ?? '—';
        console.log(`${pr.merged_at.slice(0, 10)} #${pr.number} ${risk.padEnd(15)} 배포 ${deploy}  ${pr.title}`);
      }
      if (!prs.length) console.log('merge 된 PR 없음');
      break;
    }
    case 'dispatch': {
      const [workflow, ...pairs] = positional;
      if (!workflow) throw new Error('usage: dispatch <workflow.yml> [key=value ...]');
      const inputs = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
      const payload = JSON.stringify({ ref: flags.ref ?? 'main', inputs });
      gh(['api', '-X', 'POST', `repos/${R}/actions/workflows/${workflow}/dispatches`, '--input', '-'], { input: payload });
      console.log(`${workflow} 실행 요청됨. 진행: gh run list --workflow ${workflow} --limit 1`);
      break;
    }
    default:
      console.log('명령: pr-create | pr-list | pr-status | pr-watch | deploys | risk-history | dispatch');
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
}
