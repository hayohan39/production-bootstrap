import { afterEach, describe, expect, it, vi } from "vitest";
import { aliasJobState, deploymentRef, moveProduction } from "../scripts/release.mjs";

describe("deploymentRef", () => {
  it("URL 은 호스트만, dpl_ ID 는 그대로", () => {
    expect(deploymentRef("https://app-abc123-team.vercel.app/")).toBe("app-abc123-team.vercel.app");
    expect(deploymentRef("app-abc123-team.vercel.app")).toBe("app-abc123-team.vercel.app");
    expect(deploymentRef("dpl_123")).toBe("dpl_123");
    expect(() => deploymentRef("")).toThrow();
  });
});

describe("aliasJobState", () => {
  const job = (over: object) => ({ lastAliasRequest: { toDeploymentId: "dpl_new", requestedAt: 2000, type: "promote", ...over } });

  it("이 배포로 끝났으면 done, 진행 중이거나 이전 작업이면 pending", () => {
    expect(aliasJobState(job({ jobStatus: "succeeded" }), "dpl_new", 1000)).toBe("done");
    expect(aliasJobState(job({ jobStatus: "in-progress" }), "dpl_new", 1000)).toBe("pending");
    expect(aliasJobState(job({ jobStatus: "succeeded", toDeploymentId: "dpl_old" }), "dpl_new", 1000)).toBe("pending");
    expect(aliasJobState(job({ jobStatus: "succeeded", requestedAt: 500 }), "dpl_new", 1000)).toBe("pending");
    expect(aliasJobState({}, "dpl_new", 1000)).toBe("pending");
  });

  it("작업 기록과 상관없이 프로덕션이 이 배포를 가리키면 done", () => {
    expect(aliasJobState({ targets: { production: { id: "dpl_new" } } }, "dpl_new", 1000)).toBe("done");
  });

  it("실패는 바로 알린다", () => {
    expect(() => aliasJobState(job({ jobStatus: "failed" }), "dpl_new", 1000)).toThrow(/failed/);
  });
});

describe("moveProduction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubVercel(deployment: object) {
    vi.stubEnv("VERCEL_TOKEN", "t");
    vi.stubEnv("VERCEL_ORG_ID", "team_x");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    const calls: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: URL, init: { method?: string } = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url.pathname}${url.search}`);
      let body: object = {};
      if (url.pathname.startsWith("/v13/deployments/")) body = deployment;
      else if (url.pathname === "/v9/projects/prj_1") {
        polls++;
        body = { lastAliasRequest: { toDeploymentId: "dpl_new", requestedAt: Date.now(), jobStatus: polls > 1 ? "succeeded" : "in-progress" } };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return calls;
  }

  it("승격은 REST API 로 요청하고 끝날 때까지 기다린다(팀 범위)", async () => {
    const calls = stubVercel({ id: "dpl_new", url: "app-new.vercel.app", projectId: "prj_1", target: "production" });
    const result = await moveProduction("promote", "https://app-new.vercel.app", { intervalMs: 1 });
    expect(result.id).toBe("dpl_new");
    expect(calls).toEqual([
      "GET /v13/deployments/app-new.vercel.app?teamId=team_x",
      "POST /v10/projects/prj_1/promote/dpl_new?teamId=team_x",
      "GET /v9/projects/prj_1?teamId=team_x",
      "GET /v9/projects/prj_1?teamId=team_x",
    ]);
  });

  it("롤백은 rollback 엔드포인트", async () => {
    const calls = stubVercel({ id: "dpl_new", url: "app-old.vercel.app", projectId: "prj_1", target: "production" });
    await moveProduction("rollback", "app-old.vercel.app", { intervalMs: 1 });
    expect(calls[1]).toBe("POST /v9/projects/prj_1/rollback/dpl_new?teamId=team_x");
  });

  it("프리뷰 빌드나 다른 프로젝트의 배포는 옮기지 않는다", async () => {
    stubVercel({ id: "dpl_new", url: "p.vercel.app", projectId: "prj_1", target: null });
    await expect(moveProduction("promote", "p.vercel.app")).rejects.toThrow(/프로덕션 빌드가 아니라/);
    stubVercel({ id: "dpl_new", url: "o.vercel.app", projectId: "prj_other", target: "production" });
    await expect(moveProduction("promote", "o.vercel.app")).rejects.toThrow(/이 프로젝트의 것이 아닙니다/);
  });

  it("조회 중 일시적 오류(5xx)는 다시 시도한다", async () => {
    vi.stubEnv("VERCEL_TOKEN", "t");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    let projectCalls = 0;
    vi.stubGlobal("fetch", async (url: URL) => {
      if (url.pathname.startsWith("/v13/")) return new Response(JSON.stringify({ id: "dpl_new", url: "a", projectId: "prj_1", target: "production" }));
      if (url.pathname === "/v9/projects/prj_1" && ++projectCalls === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ targets: { production: { id: "dpl_new" } } }));
    });
    await expect(moveProduction("promote", "a", { intervalMs: 1, retryDelayMs: 1 })).resolves.toMatchObject({ id: "dpl_new" });
    expect(projectCalls).toBe(2);
  });

  it("승격 요청(POST)은 다시 보내지 않는다", async () => {
    vi.stubEnv("VERCEL_TOKEN", "t");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    let posts = 0;
    vi.stubGlobal("fetch", async (url: URL, init: { method?: string } = {}) => {
      if (init.method === "POST") {
        posts++;
        return new Response("{}", { status: 500 });
      }
      return new Response(JSON.stringify({ id: "dpl_new", url: "a", projectId: "prj_1", target: "production" }));
    });
    await expect(moveProduction("promote", "a", { intervalMs: 1, retryDelayMs: 1 })).rejects.toThrow(/HTTP 500/);
    expect(posts).toBe(1);
  });

  it("시간 안에 끝나지 않으면 실패", async () => {
    vi.stubEnv("VERCEL_TOKEN", "t");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    vi.stubGlobal("fetch", async (url: URL) =>
      new Response(JSON.stringify(url.pathname.startsWith("/v13/") ? { id: "dpl_new", url: "a", projectId: "prj_1", target: "production" } : {}), { status: 200 }),
    );
    await expect(moveProduction("promote", "a", { timeoutMs: 5, intervalMs: 1 })).rejects.toThrow(/끝나지 않았습니다/);
  });
});
