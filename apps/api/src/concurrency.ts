// 동시성 유틸 — 케이스 축 병렬화(judge 스트리밍/병렬 적용)용 최소 세마포어.
// 스트리밍(도착 순서대로 push)과 일괄(mapLimit) 둘 다 이 하나로 구성한다.
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(max: number): Limiter {
  const cap = Math.max(1, max);
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < cap) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
