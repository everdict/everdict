// 레퍼런스 데스크탑 에이전트 — OSWorld 류 텍스트-에디터 태스크용. assay command 하니스가 os-use env-container 안에서
// `node /agent-osworld.cjs {{task}}` 로 실행(workDir=/tmp, DISPLAY=:99). env(OsUseEnvironment.seed)가 Xvfb+openbox 를
// 띄우고, 에이전트는 실제 앱(mousepad 텍스트 에디터)을 열어 instruction 의 따옴표 텍스트를 실 OS 키보드(xdotool)로 입력.
// 관측/채점은 assay(OsUseEnvironment.snapshot 스크린샷 → VLM JudgeGrader). VLM 이 "에디터에 그 텍스트가 보이는가" 채점.
const { execFileSync, spawn } = require("node:child_process");
const DISPLAY = process.env.DISPLAY || ":99";
const sh = (c) => execFileSync("bash", ["-lc", c], { encoding: "utf8" }).trim();
const shq = (c) => {
  try {
    return sh(c);
  } catch (e) {
    return String(e?.stdout || "");
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const task = process.argv.slice(2).join(" ");
  // instruction 의 따옴표 안 텍스트를 타이핑 목표로(예: Type 'Hello from OSWorld' → "Hello from OSWorld").
  const m = task.match(/["']([^"']+)["']/);
  const text = m ? m[1] : "Hello from OSWorld";
  console.error("[osworld-agent] task:", task, "→ type:", text);

  // 1) 실제 텍스트 에디터(mousepad) 실행.
  spawn("mousepad", [], { env: { ...process.env, DISPLAY }, detached: true, stdio: "ignore" }).unref();
  // 창이 뜰 때까지 대기(최대 ~15s).
  let wid = "";
  for (let i = 0; i < 30 && !wid; i++) {
    await sleep(500);
    wid = shq(`DISPLAY=${DISPLAY} xdotool search --onlyvisible --class mousepad 2>/dev/null`).split(/\s+/)[0] || "";
  }
  if (!wid) throw new Error("mousepad window did not appear");

  // 2) 포커스/raise 후 실 OS 키보드로 입력.
  sh(`DISPLAY=${DISPLAY} xdotool windowactivate --sync ${wid} windowfocus ${wid} windowraise ${wid}`);
  await sleep(600);
  sh(`DISPLAY=${DISPLAY} xdotool type --clearmodifiers --delay 45 -- ${JSON.stringify(text)}`);
  await sleep(1200); // 렌더 정착
  console.error("[osworld-agent] done");
})().catch((e) => {
  console.error("[osworld-agent] error", e?.stack || e);
  process.exit(1);
});
