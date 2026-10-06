import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

// 브라우저 쪽. NEXT_PUBLIC_ 값은 빌드 때 박히므로 Vercel 환경변수에 넣고 다시 배포해야 반영된다.
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, { ...process.env, VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV }));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
