import { describe, expect, it } from "vitest";
import { kst, MARKER, renderPreview } from "../scripts/preview-comment.mjs";

const now = new Date("2026-10-06T03:06:00Z");
const base = { project: "my-app", sha: "abcdef1234", runUrl: "https://github.com/o/r/actions/runs/1", now };

describe("preview comment", () => {
  it("한국 시간으로 표시한다", () => {
    expect(kst(now)).toBe("10/6 12:06 KST");
    expect(kst(new Date("2026-12-31T15:30:00Z"))).toBe("1/1 00:30 KST");
  });

  it("배포 중", () => {
    const text = renderPreview({ ...base, pending: true });
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("### 🔎 프리뷰 · my-app · `abcdef1`");
    expect(text).toContain("| ⏳ 배포 중 | — | ⏳ 준비 중 | 10/6 12:06 KST |");
  });

  it("성공: Preview·Inspect 링크와 마이그레이션 결과", () => {
    const text = renderPreview({
      ...base,
      url: "https://my-app-abc.vercel.app",
      inspect: "https://vercel.com/me/my-app/dpl1",
      branch: "preview/pr-3-abcdef1",
      branchStep: "success",
      migrate: "success",
      deploy: "success",
    });
    expect(text).toContain(
      "| ✅ Ready ([Inspect](https://vercel.com/me/my-app/dpl1)) | [Preview](https://my-app-abc.vercel.app) | ✅ 적용 | 10/6 12:06 KST |",
    );
    expect(text).toContain("DB 브랜치 `preview/pr-3-abcdef1`");
    expect(text).toContain("종합 코멘트");
    expect(text).not.toContain("⚠️");
  });

  it("마이그레이션 실패면 배포는 건너뛰고 이유를 적는다", () => {
    const text = renderPreview({ ...base, branchStep: "success", migrate: "failure", deploy: "skipped" });
    expect(text).toContain("| ⏭️ 건너뜀 | — | ❌ 실패 |");
    expect(text).toContain("프로덕션 데이터에서 실패");
  });

  it("빌드 실패면 Inspect 로 안내한다", () => {
    const text = renderPreview({ ...base, migrate: "success", deploy: "failure", inspect: "https://vercel.com/x" });
    expect(text).toContain("❌ Error ([Inspect](https://vercel.com/x))");
    expect(text).toContain("빌드 로그");
  });

  it("스모크 결과를 배포 칸에 붙인다", () => {
    expect(renderPreview({ ...base, migrate: "success", deploy: "success", smoke: "success" })).toContain("| ✅ Ready · 스모크 ✅ |");
    const failed = renderPreview({ ...base, migrate: "success", deploy: "success", smoke: "failure" });
    expect(failed).toContain("⚠️ 배포됨 · 스모크 ❌");
    expect(failed).toContain("/api/health");
  });

  it("DB 브랜치를 못 만들었으면 그렇게 적는다", () => {
    expect(renderPreview({ ...base, branchStep: "failure" })).toContain("❌ DB 브랜치 생성 실패");
  });
});
