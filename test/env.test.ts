import { describe, expect, it } from "vitest";
import { optionalEnv, requireEnv } from "@/lib/env";
import { sentryOptions } from "@/lib/sentry";
import { summarize } from "@/lib/health";

describe("env", () => {
  it("없으면 무엇을 어디서 받는지 알려 준다", () => {
    expect(() => requireEnv("SENTRY_DSN", {})).toThrow(/SENTRY_DSN.*Sentry/);
    expect(optionalEnv("SENTRY_DSN", { SENTRY_DSN: "" })).toBeUndefined();
    expect(requireEnv("DATABASE_URL", { DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });
});

describe("sentryOptions", () => {
  it("DSN 이 없으면 꺼진다", () => {
    expect(sentryOptions(undefined, {})).toMatchObject({ enabled: false, environment: "local", sendDefaultPii: false });
  });

  it("배포 환경과 릴리스(커밋)를 붙인다", () => {
    const options = sentryOptions("https://k@o.ingest.sentry.io/1", { VERCEL_ENV: "production", APP_COMMIT_SHA: "abc" });
    expect(options).toMatchObject({ enabled: true, environment: "production", release: "abc", tracesSampleRate: 0.1 });
  });
});

describe("health commit", () => {
  it("deploy.yml 이 주입한 APP_COMMIT_SHA 를 쓴다", () => {
    expect(summarize({ state: "not-configured" }, { APP_COMMIT_SHA: "0123456789" }).commit).toBe("0123456");
  });
});
