// PR 종합 코멘트(CI · 리뷰 · Risk Score · merge 전 확인 사항)를 만든다. 사용자는 휴대폰으로 읽는다:
// 첫 두 줄에서 결론이 보이고, 상세는 아래로 내려간다.
import { kst } from '../preview-comment.mjs';
import { FACTORS, FACTOR_LABELS, LEVEL_LABELS } from './levels.mjs';

export const SUMMARY_MARKER = '<!-- pr-summary -->';
const DATA_RE = /<!-- risk-data:([A-Za-z0-9+/=]+) -->/;

export function encodeData(data) {
  return `<!-- risk-data:${Buffer.from(JSON.stringify(data)).toString('base64')} -->`;
}

export function decodeData(body) {
  const m = String(body ?? '').match(DATA_RE);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const CONFIDENCE = { verified: '확인', inferred: '추정', unknown: '모름' };
const SEVERITY = { blocker: '🔴', major: '🟠', minor: '🟡' };
const CATEGORY = {
  correctness: '정확성',
  migration: '마이그레이션',
  security: '보안',
  compatibility: '호환성',
  testing: '테스트',
  complexity: '복잡도',
};
const ciIcon = (c) => ({ success: '✅', skipped: '⏭️', failure: '❌', cancelled: '⏹️', missing: '—' })[c] ?? '⏳';
/** Vercel 봇 코멘트처럼: 상태 · Preview · Inspect · 마이그레이션 · 스모크 · 갱신 시각 */
export function previewCell(ci) {
  const parts = [];
  if (ci.deploy === 'success') parts.push('✅ Ready');
  else if (ci.deploy === 'failure') parts.push('❌ Error');
  else parts.push(ciIcon(ci.preview));
  if (ci.previewUrl) parts.push(`[Preview](${ci.previewUrl})`);
  if (ci.inspectUrl) parts.push(`[Inspect](${ci.inspectUrl})`);
  if (ci.migrate) parts.push(`마이그레이션 ${ciIcon(ci.migrate)}`);
  if (ci.smoke) parts.push(`스모크 ${ciIcon(ci.smoke)}`);
  if (ci.previewAt) parts.push(kst(new Date(ci.previewAt)));
  return parts.join(' · ');
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** AI 리뷰는 PR 당 1회 — 이전 커밋의 리뷰를 이어 쓰고 있으면 그 커밋을 밝힌다. */
function reusedNote(assessment) {
  const at = assessment.reviewSha;
  if (!at || at === assessment.sha) return '';
  return ` — \`${at.slice(0, 7)}\` 기준(PR 당 1회). 이후 커밋은 규칙 스캔만 · 다시 보려면 \`ai-reviewed\` 라벨을 떼고 push`;
}

function verdictText(assessment) {
  if (!assessment.review) return '🤖 AI 리뷰 없음';
  // 이전 커밋의 리뷰를 이어 쓰면 첫 줄에서도 알 수 있게(그 뒤 커밋은 AI 가 보지 않았다).
  const old = assessment.reviewSha && assessment.reviewSha !== assessment.sha ? '(이전 커밋)' : '';
  return assessment.review.verdict === 'approve' ? `✅ 리뷰 통과${old}` : `✋ 리뷰: 수정 필요${old}`;
}

function recommendation(level, checks) {
  if (checks.state === 'failure') return '**merge 전에 아래 "merge 전 확인" 의 빠진 항목을 확인하세요.**';
  switch (level) {
    case 'LOW':
      return '변경이 제한적입니다. 요약만 확인하고 merge 해도 됩니다.';
    case 'MEDIUM':
      return '프리뷰에서 바뀐 화면/동작을 한 번 확인하세요.';
    case 'HIGH':
      return '주요 위험 요인과 지목된 `파일:라인` 을 직접 보고, 프리뷰에서 확인하세요.';
    case 'VERY_HIGH':
      return '롤백 계획과 배포 후 확인 항목을 읽고, 배포를 지켜볼 수 있을 때 merge 하세요.';
    default:
      return '장애·보안·데이터 손상 가능성이 큽니다. 의도한 변경인지, 대안(나눠서 배포)이 없는지 먼저 판단하세요.';
  }
}

/**
 * @param {object} p
 * @param {object} p.assessment  finalize() 결과
 * @param {object} p.checks      applyPolicy() 결과
 * @param {object} p.ci          { test, preview, autofix, previewUrl, migrate, smoke, runUrl }
 * @param {object|null} [p.previous]  직전 평가의 { sha, total, level }
 * @param {string} [p.repoUrl]  https://github.com/owner/repo (기준 문서 링크용)
 */
export function renderSummary({ assessment, checks, ci, previous = null, repoUrl = '' }) {
  const a = assessment;
  const L = [];
  L.push(SUMMARY_MARKER);
  L.push(`## ${LEVEL_LABELS[checks.level]} · Risk ${a.total}/100 · ${verdictText(a)} · CI ${ciIcon(ci.test)}`);
  const delta = previous && previous.sha !== a.sha ? ` (이전 커밋 ${previous.total} → ${a.total})` : '';
  const unmet = checks.requirements.filter((r) => !r.met).length;
  // PR 본문은 이 평가를 낸 시점 기준이다(본문을 고친 뒤에는 다음 push 때 다시 본다).
  L.push(`\`${a.sha.slice(0, 7)}\` 기준${delta} · merge 전 확인 **${unmet ? `${unmet}개 빠짐 ⚠️` : '모두 채움 ✅'}**${unmet ? ' (PR 본문을 고쳤으면 다음 push 때 다시 봄)' : ''}`);
  L.push('');
  L.push(recommendation(checks.level, checks));
  if (a.review?.summary) {
    L.push('');
    L.push(a.review.summary.trim());
  }

  // --- CI
  L.push('');
  L.push('| 단계 | 결과 |');
  L.push('| --- | --- |');
  L.push(`| test (lint·type·test·빈 DB 마이그레이션·build) | ${ciIcon(ci.test)} |`);
  L.push(`| preview (프로덕션 복제 DB) | ${previewCell(ci)} |`);
  if (ci.autofix && ci.autofix !== 'skipped' && ci.autofix !== 'missing') L.push(`| auto-fix | ${ciIcon(ci.autofix)} |`);
  L.push(`| AI 리뷰 | ${a.review ? `${verdictText(a)}${reusedNote(a)}` : '건너뜀 (CI 실패·비활성·장애) — 규칙 기반 점수만'} |`);

  // --- merge 전 확인 (막지 않는다 — merge 는 사람이 판단한다)
  if (checks.requirements.length || checks.reasons.length) {
    L.push('');
    L.push('### merge 전 확인');
    for (const r of checks.reasons) L.push(`- ⚠️ ${r}`);
    for (const r of checks.requirements) L.push(`- ${r.met ? '✅' : '⬜'} ${r.label}`);
  }

  // --- 리뷰 발견 사항
  const findings = a.review?.findings ?? [];
  if (findings.length) {
    L.push('');
    L.push(`### 리뷰 발견 사항 (${findings.length})`);
    findings.forEach((f, i) => {
      L.push(`${i + 1}. ${SEVERITY[f.severity] ?? '•'} **[${CATEGORY[f.category] ?? f.category}]** \`${f.location}\` — ${f.issue}`);
      if (f.suggestion) L.push(`   → ${f.suggestion}`);
    });
  }

  // --- Risk Assessment
  L.push('');
  L.push('### Risk Assessment');
  L.push('');
  L.push('| Factor | 점수 | 근거 | 확신 |');
  L.push('| --- | --- | --- | --- |');
  for (const f of FACTORS) {
    const x = a.factors[f];
    const note = x.notes.length ? ` _(${x.notes.join(', ')})_` : '';
    const evidence = x.evidence ?? (x.floor ? '규칙 기반 최저치' : '—');
    L.push(`| ${FACTOR_LABELS[f]} | ${x.score}/20 | ${cell(evidence)}${note} | ${x.confidence ? CONFIDENCE[x.confidence] ?? x.confidence : '—'} |`);
  }
  L.push(`| **합계** | **${a.total}/100** | 점수 구간 ${LEVEL_LABELS[a.band]} | |`);

  const overrides = a.overrides.filter((o) => o.level !== 'LOW');
  if (overrides.length) {
    L.push('');
    L.push('**Hard override** (총점과 별개로 최소 등급을 올림)');
    for (const o of overrides) {
      const src = { scan: '규칙', review: 'AI', policy: '정책' }[o.source];
      L.push(`- 최소 ${LEVEL_LABELS[o.level]} [${src}] ${o.condition}${o.evidence ? ` — ${o.evidence}` : ''}`);
    }
  }

  const list = (title, items) => {
    if (!items?.length) return;
    L.push('');
    L.push(`**${title}**`);
    for (const item of items) L.push(`- ${item}`);
  };
  list('주요 위험 요인', a.review?.drivers);
  list('영향 받는 곳', a.review?.affected);
  list('완화 방안', a.review?.mitigations);
  list('확인하지 못한 것 — 사람이 확인', a.review?.unknowns);

  // --- 규칙 기반 신호 상세
  const signals = a.signals.filter((s) => Object.keys(s.floors).length);
  if (signals.length) {
    L.push('');
    L.push(`<details><summary>규칙 기반 신호 ${signals.length}개 (factor 최저치의 근거)</summary>`);
    L.push('');
    for (const s of signals) {
      const floors = Object.entries(s.floors)
        .map(([f, v]) => `${FACTOR_LABELS[f]} ≥${v}`)
        .join(', ');
      const places = s.where.slice(0, 5).map((w) => `\`${w}\``).join(', ');
      const more = s.where.length > 5 ? ` 외 ${s.where.length - 5}곳` : '';
      L.push(`- \`${s.id}\` ${s.message} — ${floors}${places ? ` — ${places}${more}` : ''}`);
    }
    L.push('');
    L.push('</details>');
  }

  L.push('');
  const by = a.model ? `AI 리뷰 \`${a.model}\` + ` : '';
  L.push(
    `<sub>${by}규칙 스캔 · 기준: [.github/risk/rubric.md](${repoUrl}/blob/main/.github/risk/rubric.md) · ` +
      `Risk 는 "품질" 이 아니라 "프로덕션에서 문제가 났을 때의 심각도·범위·검증·복구 가능성" 입니다.` +
      `${ci.runUrl ? ` · [실행 로그](${ci.runUrl})` : ''}</sub>`,
  );
  L.push(encodeData({ assessment: a, ci }));

  let body = L.join('\n');
  // GitHub 코멘트 한도(65,536자). 넘으면 상세부터 줄인다.
  if (body.length > 60_000) {
    const slim = { ...a, signals: a.signals.map((s) => ({ ...s, where: s.where.slice(0, 3) })) };
    body = body.replace(/<!-- risk-data:[^>]+-->/, encodeData({ assessment: slim, ci }));
    body = body.replace(/<details>[\s\S]*?<\/details>/, '<details><summary>규칙 기반 신호 (너무 길어 생략)</summary></details>');
  }
  return body;
}

/** LLM 에게 줄 규칙 스캔 요약(마크다운). */
export function renderFacts(scan) {
  const L = [];
  L.push('# 규칙 기반 스캔 결과');
  L.push('');
  L.push('아래 floor 는 factor 별 최저 점수다. 이보다 낮게 매길 수 없다(높게는 된다).');
  L.push('override 는 총점과 별개로 강제되는 최소 등급이다.');
  L.push('');
  L.push(`- 런타임 영향: ${scan.runtimeChanged ? '있음' : '없음 (문서·테스트·에이전트 설정만)'}`);
  L.push(`- floor: ${FACTORS.map((f) => `${FACTOR_LABELS[f]} ${scan.floors[f]}`).join(', ')} (합 ${scan.floorTotal})`);
  L.push(`- override 최소 등급: ${scan.overrideLevel}`);
  L.push('');
  L.push('## 신호');
  for (const s of scan.signals) {
    const floors = Object.entries(s.floors)
      .map(([f, v]) => `${f}≥${v}`)
      .join(', ');
    L.push(`- [${s.id}]${s.level ? ` (최소 ${s.level})` : ''} ${s.message}${floors ? ` — ${floors}` : ''}`);
    for (const w of s.where.slice(0, 10)) L.push(`  - ${w}`);
  }
  L.push('');
  L.push('## 변경 파일');
  for (const f of scan.files) L.push(`- ${f.status} ${f.path} (+${f.added}/-${f.removed}) [${f.categories.join(', ') || 'app'}]`);
  return L.join('\n');
}
