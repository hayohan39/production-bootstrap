import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { changedFiles, codeChanged, isDocs } from "../scripts/ci-changes.mjs";

describe("ci-changes", () => {
  it("문서만 바뀌면 앱 코드 변경이 아니다", () => {
    expect(codeChanged(["docs/decisions.md", "README.md", "CLAUDE.md", ".github/pull_request_template.md"])).toBe(false);
    expect(codeChanged(["LICENSE"])).toBe(false);
    expect(codeChanged([])).toBe(false);
  });

  it("코드·설정·워크플로가 하나라도 있으면 앱 코드 변경이다", () => {
    expect(codeChanged(["docs/a.md", "src/app/page.tsx"])).toBe(true);
    expect(codeChanged(["next.config.ts"])).toBe(true);
    expect(codeChanged(["migrations/20261020000000_x.sql"])).toBe(true);
    expect(codeChanged([".github/workflows/ci.yml"])).toBe(true);
    expect(codeChanged(["vercel.json"])).toBe(true);
  });

  it("리뷰 기준(.github/review·risk)의 .md 는 파이프라인에 영향이 있어 문서로 보지 않는다", () => {
    expect(isDocs(".github/review/quality.md")).toBe(false);
    expect(isDocs(".github/risk/rubric.md")).toBe(false);
    expect(isDocs(".github/pull_request_template.md")).toBe(true);
  });

  it("문서 자리가 아닌 .md(앱이 읽을 수 있는 콘텐츠)는 문서로 보지 않는다", () => {
    expect(isDocs("content/terms.md")).toBe(false);
    expect(isDocs("public/notice.md")).toBe(false);
    expect(isDocs(".claude/skills/project-status/SKILL.md")).toBe(true);
  });

  it("src/·assets/ 안의 .md 는 번들에 들어갈 수 있어 문서로 보지 않는다", () => {
    expect(isDocs("src/content/notes.md")).toBe(false);
    expect(isDocs("assets/credits.md")).toBe(false);
    expect(isDocs("migrations/README.md")).toBe(true);
  });

  it("assets/ 의 파일을 docs/ 로 옮기면 옛 경로도 바뀐 파일로 잡는다", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "credits.md"), "# credits\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = String(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
    mkdirSync(path.join(dir, "docs"));
    git("mv", "assets/credits.md", "docs/credits.md");
    git("commit", "-qm", "move");

    const files = changedFiles(base, "HEAD", dir);
    expect(files).toEqual(expect.arrayContaining(["assets/credits.md", "docs/credits.md"]));
    expect(codeChanged(files)).toBe(true);
  });
});
