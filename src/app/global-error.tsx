"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// 루트 레이아웃까지 깨졌을 때의 마지막 화면. 오류는 Sentry 로 보낸다.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ko">
      <body>
        <h1>문제가 발생했습니다</h1>
        <p>잠시 후 다시 시도해 주세요.{error.digest ? ` (오류 코드 ${error.digest})` : null}</p>
        <button onClick={() => retry()}>다시 시도</button>
      </body>
    </html>
  );
}
