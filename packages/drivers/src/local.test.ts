import { describe, expect, it } from "vitest";
import { LocalDriver } from "./local.js";

describe("LocalDriver", () => {
  it("존재하지 않는 상대 cwd 로 exec 해도 디렉터리를 만들고 실행한다(prompt QA 의 'work' 부재 회귀)", async () => {
    // 회귀: 이전엔 환경이 디렉터리를 만들지 않는 prompt env 에서 하니스 기본 cwd("work")가 없어
    // spawn 이 exit 1 + 빈 출력으로 조용히 죽었다(케이스가 "빈 결과로 성공"처럼 보임).
    const handle = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });
    try {
      const res = await handle.exec("echo hello > out.txt && cat out.txt", { cwd: "work" });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello");
      expect(await handle.readFile("work/out.txt")).toBe("hello\n");
    } finally {
      await handle.dispose();
    }
  });
});
