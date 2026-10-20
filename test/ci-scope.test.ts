import { describe, expect, it } from "vitest";
import { isDocsOnly } from "../scripts/ci-scope.mjs";

describe("ci scope", () => {
  it("문서만 바뀌면 true", () => {
    expect(isDocsOnly(["README.md", "docs/runbook.md", "docs/img/flow.png", "CLAUDE.md", ".claude/skills/x/SKILL.md"])).toBe(true);
  });

  it("코드·설정이 하나라도 섞이면 false", () => {
    expect(isDocsOnly(["README.md", "src/app/page.tsx"])).toBe(false);
    expect(isDocsOnly(["docs/runbook.md", "package.json"])).toBe(false);
  });

  it("파이프라인·앱에 영향이 있는 .md 는 문서로 보지 않는다", () => {
    expect(isDocsOnly([".github/review/quality.md"])).toBe(false);
    expect(isDocsOnly(["public/notice.md"])).toBe(false);
    expect(isDocsOnly(["src/content/about.md"])).toBe(false);
    expect(isDocsOnly(["migrations/README.md"])).toBe(false);
  });

  it("빈 목록은 false (확실하지 않으면 전체 CI)", () => {
    expect(isDocsOnly([])).toBe(false);
    expect(isDocsOnly(["", "  "])).toBe(false);
  });
});
