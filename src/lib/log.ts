// 구조화 로그(JSON 한 줄). Vercel 로그에서 필드로 검색할 수 있다.
// 비밀값·개인정보가 들어갈 만한 키는 자동으로 가린다. 그래도 사용자 입력을 통째로 남기지 않는다.
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|email|phone|ssn/i;

export function redactFields(fields: Fields, depth = 0): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) out[key] = "[redacted]";
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
      out[key] = redactFields(value as Fields, depth + 1);
    } else out[key] = value;
  }
  return out;
}

export function formatLog(level: Level, msg: string, fields: Fields = {}, now = new Date()): string {
  return JSON.stringify({ level, msg, time: now.toISOString(), ...redactFields(fields) });
}

function write(level: Level, msg: string, fields?: Fields) {
  const line = formatLog(level, msg, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
