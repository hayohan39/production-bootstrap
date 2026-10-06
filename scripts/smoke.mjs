// 배포 스모크 테스트: <url>/api/health 가 200 이고 기대한 커밋인지 확인한다.
//
//   node scripts/smoke.mjs https://my-app-abc.vercel.app [--sha <commit>] [--tries 6]
//
// Vercel 배포 보호(프리뷰·스테이징 URL)는 VERCEL_AUTOMATION_BYPASS_SECRET 으로 우회한다.
// (BYPASS 환경변수로 받는다. 값은 로그에 찍지 않는다.)
import process from 'node:process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function smoke(url, { sha, tries = 6, delayMs = 10_000, bypass = process.env.BYPASS ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET } = {}) {
  const target = `${url.replace(/\/$/, '')}/api/health`;
  const want = sha ? sha.slice(0, 7) : null;
  let last = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(target, {
        headers: bypass ? { 'x-vercel-protection-bypass': bypass } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        // HTML(로그인 화면 등)이면 아래에서 실패로 처리한다.
      }
      if (res.status === 200 && body?.ok && (!want || body.commit === want)) {
        console.log(`✅ ${target} → 200 (commit ${body.commit}, db ${body.database?.state})`);
        return body;
      }
      last = `HTTP ${res.status}${body ? ` ok=${body.ok} commit=${body.commit} db=${body.database?.state}` : ''}`;
      if (res.status === 401 || res.status === 403) last += ' (배포 보호 — 우회 시크릿 확인)';
      if (body && want && body.commit !== want) last += ` (기대한 커밋 ${want})`;
    } catch (error) {
      last = error.message;
    }
    console.log(`… ${attempt}/${tries}: ${last}`);
    if (attempt < tries) await sleep(delayMs);
  }
  throw new Error(`스모크 테스트 실패: ${target} — ${last}`);
}

if (process.argv[1]?.endsWith('smoke.mjs')) {
  const [url, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];
  try {
    if (!url) throw new Error('usage: node scripts/smoke.mjs <url> [--sha <commit>] [--tries 6]');
    await smoke(url, { sha: opts.sha, tries: Number(opts.tries ?? 6) });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
