// Sentry 초기화 옵션. 서버·엣지·브라우저가 같은 기준을 쓰도록 한곳에 둔다.
// DSN 이 없으면 아무것도 보내지 않는다(로컬, CI, 아직 Sentry 를 연결하지 않은 프로젝트).
type SentryEnv = Record<string, string | undefined>;

export function sentryOptions(dsn: string | undefined, env: SentryEnv = process.env) {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.VERCEL_ENV ?? "local",
    release: env.APP_COMMIT_SHA || undefined,
    // 성능 추적은 표본만. 트래픽이 늘면 비용을 보고 낮춘다.
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // 개인정보(IP, 쿠키, 요청 본문)는 기본으로 보내지 않는다.
    sendDefaultPii: false,
  };
}
