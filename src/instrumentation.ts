import * as Sentry from "@sentry/nextjs";

// 서버 인스턴스가 뜰 때 한 번 실행된다. 런타임별 Sentry 설정을 불러온다.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

// 서버 컴포넌트·라우트 핸들러·서버 액션에서 난 오류를 Sentry 로 보낸다.
export const onRequestError = Sentry.captureRequestError;
