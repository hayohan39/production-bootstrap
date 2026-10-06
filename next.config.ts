import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

// 모든 응답에 붙는 기본 보안 헤더. CSP 는 앱마다 허용할 출처가 달라 여기서 정하지 않는다
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md 참고, docs/decisions.md 에 기록).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// Sentry 빌드 설정. SENTRY_AUTH_TOKEN 이 없으면(로컬, CI) 소스맵 업로드만 건너뛰고 빌드는 그대로 된다.
// 런타임 수집은 SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN 이 있을 때만 켜진다(src/lib/sentry.ts).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: process.env.SENTRY_AUTH_TOKEN ? false : "disable-upload" },
  silent: !process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
});
