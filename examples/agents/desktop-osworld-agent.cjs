// 레퍼런스 데스크탑 에이전트 — OSWorld 류 텍스트 태스크용(멀티스텝). everdict command 하니스가 os-use env-container 안에서
// `node /agent-osworld.cjs {{task}}` 로 실행(workDir=/tmp, DISPLAY=:99). env(OsUseEnvironment.seed)가 Xvfb+openbox 를
// 띄우고, 에이전트는 실제 앱(mousepad)을 열어 instruction 의 따옴표 텍스트를 실 OS 키보드(xdotool)로 입력한다.
// instruction 에 파일명(예: note.txt)이 있으면 멀티스텝으로: 입력 → Ctrl+S(저장 다이얼로그) → 절대경로 입력 → Enter 저장.
// 채점은 everdict: VLM judge(스크린샷) + (row.verify 있으면) command grader 가 실제 파일 상태 검증.
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
const key = (k) => sh(`DISPLAY=${DISPLAY} xdotool key --clearmodifiers ${k}`);
const typeText = (t) => sh(`DISPLAY=${DISPLAY} xdotool type --clearmodifiers --delay 40 -- ${JSON.stringify(t)}`);

(async () => {
  const task = process.argv.slice(2).join(" ");
  const content = (task.match(/["']([^"']+)["']/) || [])[1] || "Hello from OSWorld"; // 따옴표 안 텍스트
  const fn = (task.match(/([\w.\-/]+\.\w{1,5})\b/) || [])[1] || ""; // 파일명(예: note.txt)
  const filename = fn ? (fn.startsWith("/") ? fn : `/root/${fn}`) : ""; // 상대명은 home(/root) 로
  console.error("[osworld-agent] content:", content, "| filename:", filename || "(none)");

  // 1) 텍스트 에디터(mousepad) 실행 — cwd=home 으로 저장 다이얼로그 기본 위치 정렬.
  spawn("mousepad", [], { env: { ...process.env, DISPLAY }, cwd: "/root", detached: true, stdio: "ignore" }).unref();
  let wid = "";
  for (let i = 0; i < 30 && !wid; i++) {
    await sleep(500);
    wid = shq(`DISPLAY=${DISPLAY} xdotool search --onlyvisible --class mousepad 2>/dev/null`).split(/\s+/)[0] || "";
  }
  if (!wid) throw new Error("mousepad window did not appear");
  sh(`DISPLAY=${DISPLAY} xdotool windowactivate --sync ${wid} windowfocus ${wid} windowraise ${wid}`);
  await sleep(600);

  // 2) 본문 입력(실 OS 키보드).
  typeText(content);
  await sleep(800);

  // 3) 파일명이 있으면 멀티스텝 저장: Ctrl+S → 다이얼로그 name 엔트리 전체선택 → 절대경로 입력 → Enter.
  if (filename) {
    key("ctrl+s");
    await sleep(1600); // 저장 다이얼로그 대기
    key("ctrl+a"); // name 엔트리 기존값 선택
    await sleep(200);
    typeText(filename); // GtkFileChooser 는 절대경로 입력을 수용
    await sleep(400);
    key("Return"); // 기본 동작=Save
    await sleep(1600); // 저장 정착
  }
  console.error("[osworld-agent] done");
})().catch((e) => {
  console.error("[osworld-agent] error", e?.stack || e);
  process.exit(1);
});
