// 규칙 기반 스캔(floor·override)과 LLM 리뷰(factor 점수·근거)를 합쳐 최종 Risk Score 를 낸다.
// 그리고 PR 본문·수락 여부를 보고 merge 게이트(risk-gate 상태)를 정한다.
//
// 원칙(.github/risk/rubric.md):
// - LLM 은 floor 보다 낮게 매길 수 없다. override 도 내릴 수 없다(올리는 것만 된다).
// - 확인할 수 없는 factor(confidence=unknown)는 낮게 두지 않는다(최소 10).
// - LLM 평가가 없으면(장애, 시크릿 없음, Dependabot) 런타임 변경은 최소 MEDIUM 으로 본다.
import { FACTORS, bandLevel, maxLevel, rank, toAnchor } from './levels.mjs';

const ASSESSMENT_VERSION = 1;

export function finalize({ scan, review, sha, ci = null, model = null }) {
  /** @type {Record<string, {score:number, floor:number, llm:number|null, evidence:string|null, confidence:string|null, notes:string[]}>} */
  const factors = {};
  for (const f of FACTORS) {
    const floor = scan.floors[f] ?? 0;
    const llm = review?.risk?.factors?.[f] ?? null;
    let llmScore = llm ? toAnchor(llm.score) : null;
    const notes = [];
    if (llm && llm.confidence === 'unknown' && llmScore < 10) {
      llmScore = 10;
      notes.push('확인 불가 → 최소 10');
    }
    const score = Math.max(llmScore ?? 0, floor);
    if (llmScore !== null && score > llmScore) notes.push(`규칙 기반 최저치 ${floor} 적용`);
    factors[f] = {
      score,
      floor,
      llm: llmScore,
      evidence: llm?.evidence ?? null,
      confidence: llm?.confidence ?? null,
      notes,
    };
  }
  const total = FACTORS.reduce((sum, f) => sum + factors[f].score, 0);

  const overrides = [];
  for (const s of scan.signals) {
    if (s.level) overrides.push({ level: s.level, source: 'scan', condition: s.message, evidence: s.where.slice(0, 3).join(', ') });
  }
  for (const o of review?.risk?.overrides ?? []) {
    // 근거 없는 override 는 받지 않는다(올리는 방향이라도 근거는 남겨야 한다).
    if (o?.level && rank(o.level) >= 0 && String(o.evidence ?? '').trim()) {
      overrides.push({ level: o.level, source: 'review', condition: o.condition, evidence: o.evidence });
    }
  }

  const band = bandLevel(total);
  let level = maxLevel(band, ...overrides.map((o) => o.level));
  const llmAssessed = Boolean(review?.risk?.factors);
  if (!llmAssessed && scan.runtimeChanged && rank(level) < rank('MEDIUM')) {
    level = 'MEDIUM';
    overrides.push({ level: 'MEDIUM', source: 'policy', condition: 'AI 평가 없음 — 확인하지 못한 것을 안전하다고 보지 않는다', evidence: '' });
  }

  return {
    version: ASSESSMENT_VERSION,
    sha,
    model,
    llmAssessed,
    factors,
    total,
    band,
    level,
    overrides,
    signals: scan.signals,
    files: scan.files.length,
    runtimeChanged: scan.runtimeChanged,
    ci,
    review: review
      ? {
          summary: review.summary ?? '',
          verdict: review.verdict ?? null,
          findings: review.findings ?? [],
          drivers: review.risk?.drivers ?? [],
          mitigations: review.risk?.mitigations ?? [],
          unknowns: review.risk?.unknowns ?? [],
          affected: review.risk?.affected ?? [],
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// PR 본문

/** "## 롤백 계획" 같은 섹션의 본문(주석 제외). 없으면 ''. */
export function sectionText(body, heading) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*${heading}\\s*$`).test(l.trim()));
  if (start === -1) return '';
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim()) || /^---\s*$/.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
}

const EMPTY_ANSWERS = /^(없음|해당\s*없음|n\/?a|-|tbd|todo|미정)$/i;

export function sectionFilled(body, heading) {
  const text = sectionText(body, heading).replace(/\s+/g, ' ').trim();
  return text.length >= 10 && !EMPTY_ANSWERS.test(text);
}

// ---------------------------------------------------------------------------
// 게이트 (risk-gate 커밋 상태)

/**
 * @param assessment finalize() 결과
 * @param {object} ctx
 * @param {string} ctx.prBody
 * @param {{by:string, sha:string}|null} ctx.acceptance  관리자가 risk-accepted 를 붙인 기록
 * @param {boolean} ctx.ciOk  CI(test·preview) 통과 여부
 */
export function applyPolicy(assessment, { prBody, acceptance, ciOk }) {
  const reasons = [];
  let level = assessment.level;
  const rollback = sectionFilled(prBody, '롤백 계획');
  const verify = sectionFilled(prBody, '배포 후 확인');

  const destructive = assessment.signals.some((s) => s.id === 'migration.destructive');
  if (destructive && !rollback && rank(level) < rank('CRITICAL')) {
    level = 'CRITICAL';
    reasons.push('파괴적 마이그레이션인데 롤백 계획이 없다 → CRITICAL');
  }

  const requirements = [];
  if (!ciOk) requirements.push({ id: 'ci', label: 'CI(test·preview) 통과', met: false });
  if (rank(level) >= rank('HIGH')) requirements.push({ id: 'rollback', label: 'PR 본문 "롤백 계획"', met: rollback });
  if (rank(level) >= rank('VERY_HIGH')) requirements.push({ id: 'verify', label: 'PR 본문 "배포 후 확인"', met: verify });
  const needsAcceptance = level === 'CRITICAL' || (!assessment.llmAssessed && rank(level) >= rank('HIGH'));
  if (needsAcceptance) {
    requirements.push({
      id: 'accept',
      label: '관리자의 `risk-accepted` 라벨 (현재 커밋 기준)',
      met: Boolean(acceptance && acceptance.sha === assessment.sha),
    });
  }

  const unmet = requirements.filter((r) => !r.met);
  const state = unmet.length ? 'failure' : 'success';
  const head = `${level.replace('_', ' ')} ${assessment.total}/100`;
  const description = unmet.length
    ? `${head} — 필요: ${unmet.map((r) => r.label.replace(/`/g, '')).join(', ')}`
    : `${head} — 통과`;

  return {
    level,
    reasons,
    requirements,
    state,
    description: description.length > 140 ? `${description.slice(0, 137)}...` : description,
  };
}
