// 규칙 기반 리스크 스캔. diff 에서 기계적으로 확인할 수 있는 사실(신호)을 뽑고, factor 별
// 최저 점수(floor)와 최소 등급(hard override)을 정한다. LLM 리뷰는 이 값보다 낮게 매길 수 없다.
//
// 이 파일은 순수 함수만 담는다(git/네트워크 없음). git 을 읽는 쪽은 cli.mjs.
import { FACTORS, bandLevel, maxLevel } from './levels.mjs';

// ---------------------------------------------------------------------------
// 경로 분류

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function categorize(path, config) {
  const out = new Set();
  for (const [category, globs] of Object.entries(config.paths ?? {})) {
    if (globs.some((g) => globToRegExp(g).test(path))) out.add(category);
  }
  return out;
}

/** 실행 중인 서비스 동작에 영향이 없는 파일인지(문서·테스트·에이전트 설정). */
const isRuntimeFree = (cats) =>
  (cats.has('docs') || cats.has('test') || cats.has('tooling')) && !cats.has('infra') && !cats.has('riskSystem');

// ---------------------------------------------------------------------------
// diff 파싱 (git diff --no-color -U0 -M)

export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = { path: m?.[2] ?? '', oldPath: m?.[1] ?? '', status: 'M', added: [], removed: [], binary: false };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('new file mode')) file.status = 'A';
    else if (raw.startsWith('deleted file mode')) file.status = 'D';
    else if (raw.startsWith('rename from ')) {
      file.status = 'R';
      file.oldPath = raw.slice('rename from '.length);
    } else if (raw.startsWith('rename to ')) file.path = raw.slice('rename to '.length);
    else if (raw.startsWith('Binary files')) file.binary = true;
    else if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    else if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      newLine = m ? Number(m[1]) : 0;
    } else if (raw.startsWith('+')) {
      file.added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      file.removed.push({ text: raw.slice(1) });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// SQL 분류

export function splitSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const ident = (raw) => raw.replace(/"/g, '').split('.').pop().toLowerCase();
const short = (stmt) => (stmt.length > 90 ? `${stmt.slice(0, 87)}...` : stmt);

/** 파일 안에서 새로 만드는 테이블 이름들. */
export function createdTables(sql) {
  const out = new Set();
  for (const stmt of splitSql(sql)) {
    const m = stmt.toLowerCase().match(/^create (?:unlogged |temp(?:orary)? )?table (?:if not exists )?([\w."]+)/);
    if (m) out.add(ident(m[1]));
  }
  return out;
}

/** 파일 안에서 기존 테이블에 새로 더하는 컬럼들("table.column"). 백필 UPDATE 를 구분하는 데 쓴다. */
export function addedColumns(sql) {
  const out = new Set();
  for (const stmt of splitSql(sql)) {
    const m = stmt.toLowerCase().match(/^alter table (?:if exists )?(?:only )?([\w."]+) (.*)$/);
    if (!m) continue;
    for (const c of m[2].matchAll(/(?:^|,)\s*add (?:column )?(?:if not exists )?([\w"]+)/g)) {
      if (!/^(constraint|primary|unique|foreign|check|exclude)$/.test(c[1])) out.add(`${ident(m[1])}.${ident(c[1])}`);
    }
  }
  return out;
}

/** UPDATE ... SET a = .., b = .. 의 대상 컬럼들. */
function updatedColumns(s) {
  const m = s.match(/ set (.*?)(?: where | from | returning |$)/);
  if (!m) return [];
  return m[1]
    .split(/,(?![^()]*\))/)
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean)
    .map((col) => ident(col));
}

function classifyAlter(table, rest, newTable) {
  // 괄호 밖의 쉼표로 action 을 나눈다.
  const actions = [];
  let depth = 0;
  let current = '';
  for (const ch of rest) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      actions.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) actions.push(current.trim());

  return actions.map((a) => {
    let m;
    if (newTable) return { kind: 'additive', table };
    if (/^(enable|disable|force|no force) row level security/.test(a)) return { kind: 'permission', table };
    if ((m = a.match(/^drop (?:column )?(?:if exists )?([\w"]+)/)) && !/^drop (constraint|default|not null|identity|expression)\b/.test(a)) {
      return { kind: 'destructive', table, ident: ident(m[1]), detail: `컬럼 삭제 ${table}.${ident(m[1])}` };
    }
    if (/^rename to /.test(a)) return { kind: 'breaking', table, ident: table, detail: `테이블 이름 변경 ${table}` };
    if ((m = a.match(/^rename (?:column )?([\w"]+) to ([\w"]+)/)) && !/^rename constraint/.test(a)) {
      return { kind: 'breaking', table, ident: ident(m[1]), detail: `컬럼 이름 변경 ${table}.${ident(m[1])} → ${ident(m[2])}` };
    }
    if ((m = a.match(/^alter (?:column )?([\w"]+) (?:set data )?type /))) {
      return { kind: 'breaking', table, ident: ident(m[1]), detail: `컬럼 타입 변경 ${table}.${ident(m[1])} (테이블 재작성)` };
    }
    if ((m = a.match(/^alter (?:column )?([\w"]+) set not null/))) {
      return { kind: 'locking', table, detail: `NOT NULL 추가 ${table}.${ident(m[1])} (전체 스캔, 이전 코드의 NULL 쓰기 실패)` };
    }
    if (/^add (constraint|primary key|unique|foreign key|check|exclude)\b/.test(a)) {
      return / not valid\b/.test(a)
        ? { kind: 'additive', table }
        : { kind: 'locking', table, detail: `제약 추가 ${table} (NOT VALID 없이 전체 검증)` };
    }
    if ((m = a.match(/^add (?:column )?(?:if not exists )?([\w"]+) (.*)$/))) {
      const def = m[2];
      if (/\bnot null\b/.test(def) && !/\bdefault\b/.test(def)) {
        return { kind: 'locking', table, detail: `DEFAULT 없는 NOT NULL 컬럼 ${table}.${ident(m[1])} (기존 행이 있으면 실패)` };
      }
      if (/\bdefault\b/.test(def) && /(now\(\)|random\(\)|gen_random_uuid|uuid_generate|nextval|clock_timestamp)/.test(def)) {
        return { kind: 'locking', table, detail: `휘발성 DEFAULT 컬럼 ${table}.${ident(m[1])} (테이블 재작성)` };
      }
      return { kind: 'additive', table };
    }
    if (/^validate constraint\b/.test(a)) return { kind: 'additive', table };
    if (/^(drop constraint|alter (?:column )?[\w"]+ (drop not null|set default|drop default))/.test(a)) {
      return { kind: 'alter', table, detail: `${table}: ${short(a)}` };
    }
    return { kind: 'locking', table, detail: `${table}: ${short(a)}` };
  });
}

/**
 * 한 문장 → 분류 목록.
 * newTables: 이 PR 에서 새로 만드는 테이블, newColumns: 이 PR 에서 새로 더하는 "table.column".
 */
export function classifyStatement(stmt, newTables = new Set(), newColumns = new Set()) {
  const s = stmt.toLowerCase();
  let m;
  if (/^(begin|commit|rollback|start transaction|end)\b/.test(s)) {
    return [{ kind: 'tx-control', detail: `트랜잭션 제어문 "${short(stmt)}" (러너의 파일 단위 트랜잭션을 깬다)` }];
  }
  if (/^(set|reset) /.test(s) || /^(comment on|analyze)\b/.test(s)) return [];
  if ((m = s.match(/^create (?:unlogged |temp(?:orary)? )?table (?:if not exists )?([\w."]+)/))) {
    return [{ kind: 'additive', table: ident(m[1]) }];
  }
  if ((m = s.match(/^create (?:unique )?index (concurrently )?(?:if not exists )?(?:[\w."]+ )?on (?:only )?([\w."]+)/))) {
    const table = ident(m[2]);
    if (m[1] || newTables.has(table)) return [{ kind: 'additive', table }];
    return [{ kind: 'locking', table, detail: `인덱스 생성 ${table} (CONCURRENTLY 없이 쓰기 잠금)` }];
  }
  if ((m = s.match(/^drop (table|schema|sequence|type|domain)(?: if exists)? ([\w."]+)/))) {
    return [{ kind: 'destructive', table: ident(m[2]), ident: ident(m[2]), detail: `${m[1].toUpperCase()} 삭제 ${ident(m[2])}` }];
  }
  if ((m = s.match(/^drop (materialized view|view|function|procedure|trigger)(?: if exists)? ([\w."]+)/))) {
    return [{ kind: 'breaking', ident: ident(m[2]), detail: `${m[1].toUpperCase()} 삭제 ${ident(m[2])}` }];
  }
  if ((m = s.match(/^drop index (concurrently )?(?:if exists )?([\w."]+)/))) {
    return [m[1] ? { kind: 'alter', detail: `인덱스 삭제 ${ident(m[2])}` } : { kind: 'locking', detail: `인덱스 삭제 ${ident(m[2])} (CONCURRENTLY 없이)` }];
  }
  if (/^(drop (policy|role|owned)|create (policy|role)|alter (policy|role|default privileges)|grant|revoke)\b/.test(s)) {
    return [{ kind: 'permission', detail: short(stmt) }];
  }
  if (/^(create|drop|alter) extension\b/.test(s)) return [{ kind: 'extension', detail: short(stmt) }];
  // 이 PR 이 새로 만든 테이블의 데이터는 아직 프로덕션에 없다.
  if ((m = s.match(/^(?:truncate (?:table )?(?:only )?|delete from (?:only )?|update (?:only )?)([\w."]+)/)) && newTables.has(ident(m[1]))) {
    return [{ kind: 'additive', table: ident(m[1]) }];
  }
  if ((m = s.match(/^truncate (?:table )?(?:only )?([\w."]+)/))) {
    return [{ kind: 'destructive', table: ident(m[1]), detail: `TRUNCATE ${ident(m[1])}` }];
  }
  if ((m = s.match(/^delete from (?:only )?([\w."]+)/))) {
    const table = ident(m[1]);
    return / where /.test(s)
      ? [{ kind: 'data', table, detail: `데이터 삭제 ${table}` }]
      : [{ kind: 'destructive', table, detail: `WHERE 없는 DELETE ${table}` }];
  }
  if ((m = s.match(/^update (?:only )?([\w."]+) /))) {
    const table = ident(m[1]);
    const columns = updatedColumns(s);
    // 이 PR 이 더한 컬럼만 채우는 백필: 기존 값을 덮어쓰지 않지만 전체 행을 건드린다(잠금·시간).
    if (columns.length && columns.every((c) => newColumns.has(`${table}.${c}`))) {
      return [{ kind: 'data', table, detail: `새 컬럼 백필 ${table}(${columns.join(', ')}) — 전체 행` }];
    }
    return / where /.test(s)
      ? [{ kind: 'data', table, detail: `데이터 변경 ${table}` }]
      : [{ kind: 'destructive', table, detail: `WHERE 없는 UPDATE ${table} (기존 값을 덮어씀, 되돌릴 수 없음)` }];
  }
  if ((m = s.match(/^insert into ([\w."]+)/))) {
    const table = ident(m[1]);
    return [newTables.has(table) ? { kind: 'additive', table } : { kind: 'seed', table, detail: `데이터 추가 ${table}` }];
  }
  if ((m = s.match(/^alter table (?:if exists )?(?:only )?([\w."]+) (.*)$/))) {
    const table = ident(m[1]);
    return classifyAlter(table, m[2], newTables.has(table));
  }
  if ((m = s.match(/^alter type ([\w."]+) (.*)$/))) {
    return /^add value/.test(m[2])
      ? [{ kind: 'additive' }]
      : [{ kind: 'breaking', ident: ident(m[1]), detail: `타입 변경 ${ident(m[1])}` }];
  }
  if (/^create or replace (function|view|procedure|trigger)\b/.test(s)) return [{ kind: 'replace', detail: short(stmt) }];
  if (/^create (function|view|materialized view|procedure|trigger|type|sequence|schema|domain)\b/.test(s)) return [{ kind: 'additive' }];
  if (/^(vacuum full|cluster|reindex|lock table|refresh materialized view)\b/.test(s)) {
    return [{ kind: 'locking', detail: short(stmt) }];
  }
  if (/^vacuum\b/.test(s)) return [];
  return [{ kind: 'unclassified', detail: short(stmt) }];
}

export function analyzeMigration(sql, newTables, newColumns) {
  return splitSql(sql).flatMap((stmt) => classifyStatement(stmt, newTables, newColumns));
}

// ---------------------------------------------------------------------------
// 코드 패턴

const SECRET_PATTERNS = [
  ['AWS 액세스 키', /AKIA[0-9A-Z]{16}/],
  ['개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub 토큰', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ['Stripe 라이브 키', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['Anthropic 키', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Slack 토큰', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Google API 키', /AIza[0-9A-Za-z_-]{35}/],
  ['비밀번호가 든 DB 연결 문자열', /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@(?!localhost|127\.0\.0\.1|postgres[:/])[^\s'"`]+/],
];
const GENERIC_SECRET = /\b(secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i;

const SQL_INTERPOLATION = [
  /\b(query|execute|sql|raw)\s*(?:<[^>]*>)?\s*\(\s*`[^`]*\$\{/,
  /`[^`]*\b(select|insert into|update|delete from)\b[^`]*\$\{/i,
  /['"]\s*(select|insert into|update|delete from)\b[^'"]*['"]\s*\+/i,
];
const DANGEROUS_API = /\beval\s*\(|\bnew Function\s*\(|\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(/;
const AUTH_CODE = /\b(jwt|jsonwebtoken|bcrypt|argon2|getServerSession|verifyToken|isAdmin|hasRole|hasPermission|requireAuth|requireUser)\b/;
const SECURITY_BOUNDARY = /Access-Control-Allow-Origin|Content-Security-Policy|\bsameSite\b|\bhttpOnly\b|secure:\s*false|cors\s*\(/;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/;
const TEST_SKIP = /\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|describe)\s*\(/;
const TEST_CASE = /\b(it|test)\s*\(/;
const HTTP_HANDLER = /export\s+(?:async\s+)?(?:function|const)\s+(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ENV_REF = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|(?:requireEnv|optionalEnv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

const major = (range) => {
  const m = String(range ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

function where(file, line) {
  return line ? `${file.path}:${line}` : file.path;
}

/** src 아래 런타임 파일을 "영역" 으로 묶는다(Scope 판단용). */
function area(path) {
  const parts = path.split('/');
  if (parts[0] !== 'src') return parts[0];
  if (parts[1] === 'app') {
    const seg = parts.slice(2).find((p) => !/^\(.*\)$/.test(p));
    if (!seg || /\.(tsx?|css)$/.test(seg)) return 'src/app(root)';
    return `src/app/${seg}`;
  }
  if (parts.length > 3) return `src/${parts[1]}/${parts[2]}`;
  return `src/${parts[1]}/${(parts[2] ?? '').replace(/\.[^.]+$/, '')}`;
}

// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array} input.files          parseUnifiedDiff 결과 (lockfile 내용은 빼도 된다)
 * @param {Array} [input.changedPaths] 이름만 바뀐 것 포함 전체 경로 목록 [{path, status}]
 * @param {(path:string)=>string|null} input.readBase  base 의 파일 내용
 * @param {(path:string)=>string|null} input.readHead  head 의 파일 내용
 * @param {(word:string)=>boolean} input.baseReferences base 의 src/ 에 이 단어가 쓰이는지
 * @param {object} input.config        .github/risk/config.json
 */
export function scanChanges({ files, changedPaths, readBase, readHead, baseReferences, config }) {
  const signals = [];
  const add = (id, floors, level, message, places = []) => {
    const existing = signals.find((s) => s.id === id && s.message === message);
    if (existing) {
      for (const p of places) if (!existing.where.includes(p)) existing.where.push(p);
      return;
    }
    signals.push({ id, floors, level: level ?? null, message, where: [...new Set(places)] });
  };

  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const { path, status } of changedPaths ?? []) {
    if (!byPath.has(path)) byPath.set(path, { path, oldPath: path, status, added: [], removed: [], binary: false });
  }
  const all = [...byPath.values()];
  const entries = all.map((file) => ({ file, cats: categorize(file.path, config) }));

  const runtime = entries.filter(({ cats }) => !isRuntimeFree(cats));
  const srcRuntime = runtime.filter(({ file, cats }) => file.path.startsWith('src/') && !cats.has('test'));
  const testsTouched = entries.some(({ file, cats }) => cats.has('test') && file.status !== 'D');

  // --- 비밀값 (모든 파일, 추가된 줄만, 값은 절대 출력하지 않는다)
  for (const { file, cats } of entries) {
    if (file.path === 'package-lock.json') continue;
    for (const { line, text } of file.added) {
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(text)) add('secret.suspect', { security: 20 }, 'CRITICAL', `비밀값으로 보이는 문자열 (${label})`, [where(file, line)]);
      }
      if (!cats.has('test') && !cats.has('docs') && GENERIC_SECRET.test(text)) {
        add('secret.suspect', { security: 20 }, 'CRITICAL', '하드코딩된 비밀값으로 보이는 대입', [where(file, line)]);
      }
    }
  }

  // --- 범위(Scope)
  const riskSystem = entries.filter(({ cats }) => cats.has('riskSystem')).map(({ file }) => file.path);
  if (riskSystem.length) {
    add('scope.risk-system', { scope: 20 }, 'VERY_HIGH', '리스크 평가·게이트 자체를 바꾼다 (이 PR 은 main 의 규칙으로 평가됨)', riskSystem);
  }
  const infra = entries.filter(({ cats }) => cats.has('infra') && !cats.has('riskSystem')).map(({ file }) => file.path);
  if (infra.length) add('scope.infra', { scope: 20 }, 'HIGH', '배포·CI·런타임 설정(프로덕션 인프라) 변경', infra);
  const core = entries.filter(({ cats }) => cats.has('sharedCore')).map(({ file }) => file.path);
  if (core.length) add('scope.shared-core', { scope: 15 }, 'HIGH', '모든 요청이 거치는 공통 모듈 변경', core);

  const areas = new Set(srcRuntime.map(({ file }) => area(file.path)));
  if (srcRuntime.length === 1) add('scope.areas', { scope: 5 }, null, `런타임 파일 1개 (${[...areas][0]})`, [srcRuntime[0].file.path]);
  else if (areas.size >= 3) add('scope.areas', { scope: 15 }, null, `런타임 영역 ${areas.size}곳: ${[...areas].join(', ')}`);
  else if (srcRuntime.length > 1) add('scope.areas', { scope: 10 }, null, `런타임 영역 ${areas.size}곳: ${[...areas].join(', ')}`);

  // --- 보안 / 호환성 (코드)
  for (const { file, cats } of entries) {
    const isSrc = file.path.startsWith('src/') && !cats.has('test');
    if (cats.has('auth')) add('security.auth-path', { security: 15 }, 'HIGH', '인증·세션·권한 관련 파일 변경', [file.path]);

    if (cats.has('api')) {
      const before = new Set(file.removed.map((r) => r.text.match(HTTP_HANDLER)?.[1]).filter(Boolean));
      const after = new Set(file.added.map((a) => a.text.match(HTTP_HANDLER)?.[1]).filter(Boolean));
      if (file.status === 'D' || file.status === 'R') {
        add('compat.endpoint-removed', { compatibility: 15 }, 'HIGH', 'API 라우트 삭제/경로 변경 (기존 호출자가 깨짐)', [file.oldPath]);
      } else {
        for (const method of before) {
          if (!after.has(method)) add('compat.endpoint-removed', { compatibility: 15 }, 'HIGH', `API 핸들러 ${method} 삭제`, [file.path]);
        }
      }
      for (const method of after) {
        if (WRITE_METHODS.has(method) && !before.has(method)) {
          add('security.write-endpoint', { security: 10 }, null, `쓰기 API ${method} 추가 (인증·입력 검증 확인)`, [file.path]);
        }
      }
    }
    if (cats.has('page') && (file.status === 'D' || file.status === 'R')) {
      add('compat.page-removed', { compatibility: 10 }, null, '페이지 삭제/경로 변경 (북마크·링크가 깨짐)', [file.oldPath]);
    }

    for (const { line, text } of file.added) {
      if (isSrc && /^\s*['"]use server['"]/.test(text)) {
        add('security.write-endpoint', { security: 10 }, null, '서버 액션 추가 (인증·입력 검증 확인)', [where(file, line)]);
      }
      if ((isSrc || file.path.startsWith('scripts/')) && SQL_INTERPOLATION.some((re) => re.test(text))) {
        add('security.sql-interpolation', { security: 15 }, 'HIGH', 'SQL 을 문자열로 조합하는 코드 (파라미터 바인딩 확인)', [where(file, line)]);
      }
      if (isSrc && DANGEROUS_API.test(text)) {
        add('security.dangerous-api', { security: 15 }, 'HIGH', 'eval / 프로세스 실행 API 사용', [where(file, line)]);
      }
      if (isSrc && /dangerouslySetInnerHTML/.test(text)) {
        add('security.raw-html', { security: 10 }, null, 'dangerouslySetInnerHTML (XSS 확인)', [where(file, line)]);
      }
      if (isSrc && AUTH_CODE.test(text)) {
        add('security.auth-code', { security: 15 }, 'HIGH', '인증·권한 판단 코드 변경', [where(file, line)]);
      }
      if ((isSrc || file.path === 'next.config.ts') && SECURITY_BOUNDARY.test(text)) {
        add('security.boundary', { security: 15 }, 'HIGH', 'CORS·CSP·쿠키 속성 등 보안 경계 설정 변경', [where(file, line)]);
      }
      if (/\.(m?[jt]sx?)$/.test(file.path) && SUPPRESSION.test(text)) {
        add('testing.suppression', { testing: 10 }, null, 'lint/타입 검사 억제 주석 추가', [where(file, line)]);
      }
      if (cats.has('test') && TEST_SKIP.test(text)) {
        add('testing.suppression', { testing: 10 }, null, '테스트 skip/only 추가', [where(file, line)]);
      }
    }

    if (cats.has('test')) {
      const removedCases = file.removed.filter((r) => TEST_CASE.test(r.text)).length;
      const addedCases = file.added.filter((a) => TEST_CASE.test(a.text)).length;
      if (file.status === 'D' || removedCases > addedCases) {
        add('testing.tests-removed', { testing: 15 }, null, '테스트 케이스가 줄었다', [file.path]);
      }
    }
  }

  // --- 새 환경변수
  const ignoreEnv = new Set(config.ignoreEnv ?? []);
  const newEnv = new Map();
  for (const { file, cats } of entries) {
    if (!file.path.startsWith('src/') || cats.has('test')) continue;
    for (const { line, text } of file.added) {
      for (const m of text.matchAll(ENV_REF)) {
        const name = m[1] ?? m[2] ?? m[3];
        if (!name || ignoreEnv.has(name) || name.startsWith('VERCEL_')) continue;
        if (!newEnv.has(name)) newEnv.set(name, where(file, line));
      }
    }
  }
  for (const [name, place] of newEnv) {
    if (!baseReferences(name)) {
      add('config.new-env', { compatibility: 10, migration: 10 }, null, `새 환경변수 ${name} (배포 전에 Vercel 에 설정되어 있어야 함)`, [place]);
    }
  }

  // --- 의존성
  const pkgFile = byPath.get('package.json');
  if (pkgFile) {
    const parse = (text) => {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    };
    const base = parse(readBase('package.json'));
    const head = parse(readHead('package.json'));
    for (const [section, isProd] of [
      ['dependencies', true],
      ['devDependencies', false],
    ]) {
      const b = base[section] ?? {};
      const h = head[section] ?? {};
      for (const [name, range] of Object.entries(h)) {
        if (!(name in b)) {
          add(isProd ? 'deps.added' : 'deps.dev', { security: 5 }, null, `${isProd ? '' : '개발 '}의존성 추가 ${name}@${range}`, ['package.json']);
        } else if (major(b[name]) !== null && major(range) !== null && major(range) > major(b[name])) {
          add('deps.major', { compatibility: isProd ? 10 : 5 }, null, `메이저 업그레이드 ${name} ${b[name]} → ${range}`, ['package.json']);
        }
      }
      for (const name of Object.keys(b)) {
        if (!(name in h) && isProd) add('deps.removed', { compatibility: 5 }, null, `의존성 제거 ${name}`, ['package.json']);
      }
    }
    for (const key of ['scripts', 'engines', 'type', 'overrides']) {
      if (JSON.stringify(base[key] ?? null) !== JSON.stringify(head[key] ?? null)) {
        add('config.package', { scope: 10 }, null, `package.json "${key}" 변경 (빌드·실행 방식)`, ['package.json']);
      }
    }
  } else if (byPath.has('package-lock.json')) {
    add('deps.lockfile', { security: 5 }, null, 'lockfile 만 변경 (간접 의존성 버전 변경)', ['package-lock.json']);
  }

  // --- 마이그레이션
  const migrations = entries.filter(({ cats }) => cats.has('migration'));
  for (const { file } of migrations) {
    if (file.status !== 'A') {
      add('migration.edited', { migration: 20 }, 'VERY_HIGH', '이미 있는 마이그레이션 파일을 수정/삭제/이름 변경 (체크섬 불일치·환경 간 스키마 분기)', [file.oldPath]);
    }
  }
  const newMigrations = migrations.filter(({ file }) => file.status === 'A');
  const newTables = new Set();
  const newColumns = new Set();
  const sqlByFile = new Map();
  for (const { file } of newMigrations) {
    const sql = readHead(file.path) ?? file.added.map((a) => a.text).join('\n');
    sqlByFile.set(file.path, sql);
    for (const t of createdTables(sql)) newTables.add(t);
    for (const c of addedColumns(sql)) newColumns.add(c);
  }
  const MIGRATION_RULES = {
    destructive: ['migration.destructive', { migration: 20 }, 'VERY_HIGH', '파괴적 마이그레이션 (데이터 손실, 되돌릴 수 없음)'],
    breaking: ['migration.breaking', { migration: 15, compatibility: 15 }, 'VERY_HIGH', '이전 버전 코드와 호환되지 않는 스키마 변경 (배포 중·롤백 시 장애)'],
    locking: ['migration.locking', { migration: 15 }, 'HIGH', '기존 테이블 잠금·재작성이 필요한 변경'],
    data: ['migration.data', { migration: 15 }, 'HIGH', '기존 데이터 변경 (되돌리는 방법 필요)'],
    'tx-control': ['migration.tx-control', { migration: 15 }, 'HIGH', '파일 안의 트랜잭션 제어문'],
    permission: ['security.db-permission', { security: 15 }, 'HIGH', 'DB 권한·RLS 정책 변경'],
    extension: ['security.db-extension', { security: 10 }, null, 'Postgres 확장 추가/변경'],
    replace: ['migration.replace', { migration: 10, compatibility: 10 }, null, '함수/뷰 교체 (동작 변경)'],
    seed: ['migration.seed', { migration: 10 }, null, '기존 테이블에 데이터 추가'],
    alter: ['migration.alter', { migration: 10, compatibility: 5 }, null, '제약·기본값 완화 등 비파괴 변경'],
    additive: ['migration.additive', { migration: 10, compatibility: 5 }, null, '추가형 스키마 변경 (새 테이블·nullable 컬럼·인덱스)'],
    unclassified: ['migration.unclassified', { migration: 10 }, null, '자동 분류하지 못한 문장 (사람이 확인)'],
  };
  for (const [path, sql] of sqlByFile) {
    if (/^\s*--\s*migrate:no-transaction\s*$/m.test(sql)) {
      add('migration.no-transaction', { migration: 10 }, null, '트랜잭션 밖에서 실행되는 마이그레이션 (중간 실패 시 일부 적용)', [path]);
    }
    for (const item of analyzeMigration(sql, newTables, newColumns)) {
      const [id, floors, level, message] = MIGRATION_RULES[item.kind];
      add(id, floors, level, message, [item.detail ? `${path} — ${item.detail}` : path]);
      if ((item.kind === 'destructive' || item.kind === 'breaking') && item.ident && item.ident.length > 1 && baseReferences(item.ident)) {
        add(
          'migration.referenced',
          { migration: 20, compatibility: 20 },
          'CRITICAL',
          '현재 배포된 코드가 아직 쓰는 이름을 지우거나 바꾼다 — 마이그레이션 직후부터 새 코드가 뜨기 전까지, 그리고 앱 롤백 시 장애 (expand → contract 로 나눌 것)',
          [`${path} — ${item.detail} (main 의 src/ 에서 "${item.ident}" 참조)`],
        );
      }
    }
  }

  // --- 테스트
  if (srcRuntime.length && !testsTouched) {
    add('testing.untested', { testing: 10 }, null, '런타임 코드가 바뀌었는데 테스트 변경이 없다', srcRuntime.map(({ file }) => file.path));
  }

  const runtimeChanged = runtime.length > 0;
  if (!runtimeChanged) add('scope.no-runtime', {}, null, '런타임 영향 없음 (문서·테스트·에이전트 설정만)');

  // --- 집계
  const floors = Object.fromEntries(FACTORS.map((f) => [f, 0]));
  for (const s of signals) for (const [f, v] of Object.entries(s.floors)) floors[f] = Math.max(floors[f], v);
  const overrideLevel = maxLevel(...signals.map((s) => s.level));
  const floorTotal = FACTORS.reduce((sum, f) => sum + floors[f], 0);

  return {
    files: entries.map(({ file, cats }) => ({
      path: file.path,
      status: file.status,
      categories: [...cats],
      added: file.added.length,
      removed: file.removed.length,
    })),
    runtimeChanged,
    signals,
    floors,
    floorTotal,
    overrideLevel,
    preliminaryLevel: maxLevel(bandLevel(floorTotal), overrideLevel),
  };
}
