import { describe, expect, it } from "vitest";
import { formatLog, redactFields } from "@/lib/log";

describe("log", () => {
  it("JSON 한 줄로 쓴다", () => {
    const line = formatLog("info", "created", { id: 3 }, new Date("2026-01-01T00:00:00Z"));
    expect(JSON.parse(line)).toEqual({ level: "info", msg: "created", time: "2026-01-01T00:00:00.000Z", id: 3 });
  });

  it("민감한 키는 가린다(중첩 포함)", () => {
    const out = redactFields({ user: { email: "a@b.c", id: 1 }, token: "x", Authorization: "Bearer y" });
    expect(out).toEqual({ user: { email: "[redacted]", id: 1 }, token: "[redacted]", Authorization: "[redacted]" });
  });

  it("Error 는 이름과 메시지만 남긴다", () => {
    expect(redactFields({ error: new TypeError("bad") })).toEqual({ error: { name: "TypeError", message: "bad" } });
  });
});
