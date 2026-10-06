// Risk Score 의 공통 상수와 등급 계산. 기준은 .github/risk/rubric.md.

export const FACTORS = ['security', 'scope', 'compatibility', 'testing', 'migration'];

export const FACTOR_LABELS = {
  security: 'Security',
  scope: 'Scope',
  compatibility: 'Compatibility',
  testing: 'Testing',
  migration: 'Migration/Rollback',
};

export const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'CRITICAL'];

export const LEVEL_LABELS = {
  LOW: '🟢 LOW',
  MEDIUM: '🟡 MEDIUM',
  HIGH: '🟠 HIGH',
  VERY_HIGH: '🔴 VERY HIGH',
  CRITICAL: '⛔ CRITICAL',
};

export const LEVEL_SLUGS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  VERY_HIGH: 'very-high',
  CRITICAL: 'critical',
};

/** 0/5/10/15/20 만 쓴다. 중간값을 허용하면 같은 PR 의 점수가 실행마다 흔들린다. */
export const ANCHORS = [0, 5, 10, 15, 20];

export const rank = (level) => LEVELS.indexOf(level);

export function maxLevel(...levels) {
  return levels.filter(Boolean).reduce((a, b) => (rank(b) > rank(a) ? b : a), 'LOW');
}

/** 총점 → 등급 (0–20 LOW, 21–40 MEDIUM, 41–60 HIGH, 61–80 VERY HIGH, 81–100 CRITICAL). */
export function bandLevel(total) {
  if (total <= 20) return 'LOW';
  if (total <= 40) return 'MEDIUM';
  if (total <= 60) return 'HIGH';
  if (total <= 80) return 'VERY_HIGH';
  return 'CRITICAL';
}

/** 임의의 값을 가장 가까운 기준값으로 올림한다(위험을 낮추는 쪽으로 반올림하지 않는다). */
export function toAnchor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return ANCHORS.find((a) => a >= n) ?? 20;
}
