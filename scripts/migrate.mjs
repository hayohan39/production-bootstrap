// 최소한의 Postgres 마이그레이션 러너.
//
//   node scripts/migrate.mjs            적용되지 않은 마이그레이션을 실행
//   node scripts/migrate.mjs status     대기 중인 것만 보여주고 아무것도 실행하지 않음
//   node scripts/migrate.mjs new <이름>  타임스탬프가 붙은 빈 .sql 파일 생성
//
// migrations/*.sql 을 파일명 순서대로 적용하고, 적용 내역을 schema_migrations 에
// 기록한다. 각 마이그레이션은 하나의 트랜잭션으로 실행되므로 중간에 실패하면
// 그 파일의 변경은 전부 되돌아간다.
//
// 운영 DB 보호:
// - lock_timeout(기본 5s): 잠금을 못 잡으면 기다리지 않고 실패한다. 마이그레이션이 잠금 대기열
//   맨 앞에서 기다리는 동안 그 테이블의 모든 읽기/쓰기가 뒤에 줄 서는 장애를 막는다.
// - statement_timeout(기본 5min): 예상보다 오래 걸리는 문장을 끊는다.
//   MIGRATION_LOCK_TIMEOUT / MIGRATION_STATEMENT_TIMEOUT 으로 바꿀 수 있다.
// - 파일 맨 위 주석에 `-- migrate:no-transaction` 이 있으면 트랜잭션 밖에서 실행한다.
//   `CREATE INDEX CONCURRENTLY` 처럼 트랜잭션 안에서 안 되는 문장 하나만 담는다.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
// 같은 순간에 두 배포가 겹쳐도 한 쪽만 적용하도록 잡는 자문 잠금 키.
const LOCK_KEY = 8_927_413_550_117n;

const LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT || '5s';
const STATEMENT_TIMEOUT = process.env.MIGRATION_STATEMENT_TIMEOUT || '5min';

/** 파일 머리 주석(처음 나오는 주석 줄들)에 지시어가 있는지. */
export function wantsNoTransaction(sql) {
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) return false;
    if (/^--\s*migrate:no-transaction\s*$/.test(trimmed)) return true;
  }
  return false;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function listMigrations() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

async function createMigration(name) {
  if (!name) throw new Error('이름이 필요합니다: node scripts/migrate.mjs new <이름>');
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error(`이름에 쓸 수 있는 문자가 없습니다: "${name}"`);

  // 파일명 순서가 곧 적용 순서다. 초 단위로만 찍으면 같은 초에 만든 두 파일이
  // 같은 접두사를 받아 이름순으로 밀리면서 생성 순서와 다르게 적용된다.
  // 밀리초까지 쓰고, 그래도 겹치면 기존 최대값 다음으로 밀어 단조 증가를 보장한다.
  let stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const existing = await listMigrations();
  const highest = existing.map((name) => name.split('_')[0]).sort().at(-1);
  if (highest && highest >= stamp) {
    stamp = (BigInt(highest) + 1n).toString();
  }

  const file = path.join(MIGRATIONS_DIR, `${stamp}_${slug}.sql`);
  await mkdir(MIGRATIONS_DIR, { recursive: true });
  await writeFile(
    file,
    `-- ${slug}\n-- 이 파일은 하나의 트랜잭션으로 실행됩니다(lock_timeout ${LOCK_TIMEOUT}).\n` +
      '-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.\n' +
      '-- 배포 중에는 이전 버전 코드가 새 스키마 위에서 돈다: 삭제·이름 변경은 코드가 더 이상\n' +
      '-- 쓰지 않게 된 뒤 별도 PR 로 (expand → contract).\n\n',
  );
  console.log(`생성됨: ${path.relative(process.cwd(), file)}`);
}

async function connect() {
  // pg 는 여기서만 필요하다. 최상위에서 import 하면 DB 가 필요 없는
  // `migrate.mjs new` 조차 의존성 없이는 못 돌아간다.
  const { default: pg } = await import('pg');
  // 마이그레이션은 direct(비풀링) 연결로 돌려야 한다. PgBouncer 의 transaction
  // 모드에서는 세션 단위 advisory lock 이 보장되지 않는다. Neon 은 호스트 이름에
  // -pooler 가 붙은 것이 풀링 연결이다.
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  }
  if (/-pooler\./.test(connectionString)) {
    console.warn('주의: 풀링 연결(-pooler)로 마이그레이션합니다. direct 연결을 권장합니다.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function run({ dryRun }) {
  const files = await listMigrations();
  if (files.length === 0) {
    console.log('마이그레이션 파일이 없습니다.');
    return;
  }

  const client = await connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()]);

    const { rows } = await client.query('SELECT id, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));

    const pending = [];
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);
      const previous = applied.get(file);

      if (previous === undefined) {
        pending.push({ file, sql, checksum });
      } else if (previous !== checksum) {
        // 이미 적용된 파일이 바뀌었다. 조용히 넘어가면 환경마다 스키마가 갈라진다.
        throw new Error(
          `이미 적용된 마이그레이션이 수정되었습니다: ${file}\n` +
            '되돌리거나, 변경 사항을 새 마이그레이션으로 추가하세요.',
        );
      }
    }

    if (pending.length === 0) {
      console.log(`최신 상태입니다 (적용됨 ${applied.size}개).`);
      return;
    }

    console.log(`대기 중 ${pending.length}개:`);
    for (const { file } of pending) console.log(`  - ${file}`);
    if (dryRun) return;

    const record = (file, checksum) =>
      client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [file, checksum]);
    const timeouts = (local) =>
      client.query("SELECT set_config('lock_timeout', $1, $3), set_config('statement_timeout', $2, $3)", [
        LOCK_TIMEOUT,
        STATEMENT_TIMEOUT,
        local,
      ]);

    for (const { file, sql, checksum } of pending) {
      const noTransaction = wantsNoTransaction(sql);
      process.stdout.write(`적용 중 ${file}${noTransaction ? ' (트랜잭션 없이)' : ''} ... `);
      if (noTransaction) {
        try {
          await timeouts(false);
          await client.query(sql);
          await record(file, checksum);
          await client.query('RESET lock_timeout; RESET statement_timeout');
          console.log('완료');
        } catch (error) {
          throw new Error(
            `${file} 실패 — 트랜잭션 밖에서 실행된 파일이라 일부가 남았을 수 있습니다.\n` +
              'CREATE INDEX CONCURRENTLY 였다면 INVALID 인덱스를 DROP INDEX CONCURRENTLY 로 지운 뒤 다시 실행하세요.\n' +
              hint(error),
          );
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await timeouts(true);
        await client.query(sql);
        await record(file, checksum);
        await client.query('COMMIT');
        console.log('완료');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file} 실패 — 이 파일의 변경은 되돌려졌습니다.\n${hint(error)}`);
      }
    }
    console.log(`${pending.length}개 적용 완료.`);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()]);
    } catch {
      // 연결이 이미 끊긴 경우. 잠금은 세션 종료와 함께 풀린다.
    }
    await client.end();
  }
}

function hint(error) {
  if (error.code === '55P03') {
    return `${error.message}\n잠금을 ${LOCK_TIMEOUT} 안에 잡지 못했습니다(lock_timeout). 그 테이블을 오래 쓰는 요청이 있었습니다. 다시 실행하거나 트래픽이 적을 때 재시도하세요.`;
  }
  if (error.code === '57014') {
    return `${error.message}\n문장이 ${STATEMENT_TIMEOUT} 를 넘겼습니다(statement_timeout). 데이터가 많으면 나눠서 처리하는 마이그레이션으로 바꾸세요.`;
  }
  return error.message;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'new') await createMigration(rest.join(' '));
    else if (command === 'status') await run({ dryRun: true });
    else if (!command) await run({ dryRun: false });
    else throw new Error(`알 수 없는 명령: ${command}`);
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
