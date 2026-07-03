// 패키징용 단일 번들 — pnpm 워크스페이스의 symlink node_modules 를 asar 에 담는 대신
// main(ESM)/preload(CJS)를 각각 한 파일로 번들한다(@assay/runner-core 포함). electron 만 external.
// 게이트(turbo build)는 tsc(dist/) 그대로 — 이 스크립트는 `pnpm package` 전용.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "bundle/main.js",
  external: ["electron"],
  // CJS 의존(require 사용)을 ESM 번들에서 살리는 상용구.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // 릴리즈 빌드에 굽는 기본 서버 URL(D8) — CI 가 ASSAY_DESKTOP_DEFAULT_WEB_URL 로 주입(미설정=빈 값 → 설정 화면).
  define: {
    __ASSAY_DEFAULT_WEB_URL__: JSON.stringify(process.env.ASSAY_DESKTOP_DEFAULT_WEB_URL ?? ""),
  },
});

await build({
  entryPoints: ["src/preload.cts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "bundle/preload.cjs",
  external: ["electron"],
});
