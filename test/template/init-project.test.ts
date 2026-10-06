// 템플릿 전용 테스트. 새 프로젝트에서는 init-project 가 이 디렉터리를 지운다.
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, TEMPLATE_ONLY } from "../../scripts/init-project.mjs";

const ROOT = path.resolve(__dirname, "..", "..");
const COPY = ["src", "scripts", "docs", ".github", ".claude", "test", "CLAUDE.md", "README.md", "package.json", "package-lock.json"];

describe("init-project", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function copyTemplate() {
    dir = await mkdtemp(path.join(os.tmpdir(), "init-"));
    for (const entry of COPY) {
      if (existsSync(path.join(ROOT, entry))) {
        await cp(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
      }
    }
    return dir;
  }

  it("플레이스홀더를 채우고 템플릿 전용 파일을 지운다", async () => {
    const root = await copyTemplate();
    const changed = await initProject(root, { name: "my-app", description: 'He said "hi"' });
    expect(changed).toBe(true);

    const projectTs = await readFile(path.join(root, "src/lib/project.ts"), "utf8");
    expect(projectTs).toContain('name: "my-app"');
    expect(projectTs).toContain('description: "He said \\"hi\\""');

    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    expect(lock.name).toBe("my-app");
    expect(lock.packages[""].name).toBe("my-app");

    for (const rel of TEMPLATE_ONLY) expect(existsSync(path.join(root, rel)), rel).toBe(false);

    for (const rel of ["CLAUDE.md", "README.md", "src/lib/project.ts"]) {
      const text = await readFile(path.join(root, rel), "utf8");
      expect(text, rel).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(text, rel).not.toContain("template-only");
    }
  });

  it("두 번째 실행은 아무것도 하지 않는다", async () => {
    const root = await copyTemplate();
    await initProject(root, { name: "my-app" });
    expect(await initProject(root, { name: "other" })).toBe(false);
  });

  it("잘못된 이름을 거부한다", async () => {
    const root = await copyTemplate();
    await expect(initProject(root, { name: "My_App" })).rejects.toThrow();
  });
});
