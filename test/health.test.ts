import { describe, expect, it } from "vitest";
import { redact, summarize } from "@/lib/health";

describe("summarize", () => {
  it("DB 미설정은 장애가 아니다", () => {
    const health = summarize({ state: "not-configured" }, {});
    expect(health.ok).toBe(true);
    expect(health.environment).toBe("local");
    expect(health.commit).toBeNull();
  });

  it("DB 오류는 장애다", () => {
    expect(summarize({ state: "error", message: "boom" }, {}).ok).toBe(false);
  });

  it("Vercel 환경 정보를 읽는다", () => {
    const health = summarize(
      { state: "ok", latencyMs: 3, migrations: 1 },
      { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "0123456789abcdef" },
    );
    expect(health).toMatchObject({ ok: true, environment: "preview", commit: "0123456" });
  });
});

describe("redact", () => {
  it("연결 문자열을 가린다", () => {
    const message = 'connect failed: postgresql://user:secret@ep-x.neon.tech/db?sslmode=require';
    expect(redact(message)).toBe("connect failed: postgres://***");
    expect(redact(message)).not.toContain("secret");
  });
});
