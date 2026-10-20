import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isDocsOnly } from "../scripts/ci-scope.mjs";

describe("ci scope", () => {
  it("문서만 바뀌면 true", () => {
    expect(isDocsOnly(["README.md", "docs/runbook.md", "docs/img/flow.png", "CLAUDE.md", ".claude/skills/x/SKILL.md"])).toBe(true);
  });

  it("코드·설정이 하나라도 섞이면 false", () => {
    expect(isDocsOnly(["README.md", "src/app/page.tsx"])).toBe(false);
    expect(isDocsOnly(["docs/runbook.md", "package.json"])).toBe(false);
    expect(isDocsOnly([".claude/settings.json"])).toBe(false);
    expect(isDocsOnly([".claude/hooks/start.mjs"])).toBe(false);
  });

  it("docs/·.claude/·루트 밖의 .md 는 문서로 보지 않는다", () => {
    expect(isDocsOnly(["content/posts/hello.md"])).toBe(false);
    expect(isDocsOnly([".github/review/quality.md"])).toBe(false);
    expect(isDocsOnly(["public/notice.md"])).toBe(false);
    expect(isDocsOnly(["src/content/about.md"])).toBe(false);
    expect(isDocsOnly(["migrations/README.md"])).toBe(false);
  });

  it("빈 목록은 false (확실하지 않으면 전체 CI)", () => {
    expect(isDocsOnly([])).toBe(false);
    expect(isDocsOnly(["", "  "])).toBe(false);
  });

  it("코드 파일을 docs/ 로 옮긴 PR 은 문서로 보지 않는다(이름 변경의 옛 경로도 본다)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-scope-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const x = 1;\n".repeat(20));
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      fs.mkdirSync(path.join(dir, "docs"));
      git("mv", "src/x.ts", "docs/x.md");
      git("commit", "-qm", "move");
      const output = path.join(dir, "out.txt");
      execFileSync(process.execPath, [path.resolve("scripts/ci-scope.mjs")], {
        cwd: dir,
        env: { ...process.env, BASE: base, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
      });
      expect(fs.readFileSync(output, "utf8")).toBe("docs_only=false\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
