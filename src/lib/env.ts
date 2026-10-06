// 환경변수 접근은 여기로 모은다. 필수 값이 없으면 "무엇이, 어디서 발급받는지" 를 담은
// 오류를 낸다. 새 환경변수를 추가하면 이 표에 한 줄 넣고 PR 본문 "배포 영향" 에 적는다.
export const ENV_DOCS = {
  DATABASE_URL: "Neon pooled 연결 문자열 (Vercel 환경변수, new-project 가 설정)",
  DATABASE_URL_UNPOOLED: "Neon direct 연결 문자열 (Vercel 환경변수, new-project 가 설정)",
  SENTRY_DSN: "Sentry 프로젝트 DSN (Sentry → Settings → Client Keys)",
  NEXT_PUBLIC_SENTRY_DSN: "브라우저용 Sentry DSN (보통 SENTRY_DSN 과 같은 값)",
} as const;

export type EnvName = keyof typeof ENV_DOCS;

export function optionalEnv(name: EnvName, env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[name];
  return value ? value : undefined;
}

export function requireEnv(name: EnvName, env: Record<string, string | undefined> = process.env): string {
  const value = optionalEnv(name, env);
  if (!value) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다 — ${ENV_DOCS[name]}`);
  return value;
}
