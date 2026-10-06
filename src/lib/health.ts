export type DatabaseStatus =
  | { state: "not-configured" }
  | { state: "ok"; latencyMs: number; migrations: number }
  | { state: "error"; message: string };

export type Health = {
  ok: boolean;
  database: DatabaseStatus;
  commit: string | null;
  environment: string;
};

/** 시크릿이 섞일 수 있는 오류 메시지에서 연결 문자열을 가린다. */
export function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://***");
}

export function summarize(
  database: DatabaseStatus,
  env: Record<string, string | undefined> = process.env,
): Health {
  return {
    // DB 를 아직 연결하지 않은 것은 장애가 아니다. 연결했는데 실패한 것만 장애로 본다.
    ok: database.state !== "error",
    database,
    // deploy.yml 이 배포마다 APP_COMMIT_SHA 를 주입한다(Vercel 을 Git 에 연결하지 않으므로
    // VERCEL_GIT_COMMIT_SHA 는 없다). 배포 후 스모크 테스트가 이 값으로 새 버전인지 확인한다.
    commit: (env.APP_COMMIT_SHA || env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 7) ?? null,
    environment: env.VERCEL_ENV ?? "local",
  };
}
