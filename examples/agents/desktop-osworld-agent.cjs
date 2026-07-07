// Reference desktop agent — for OSWorld-style text tasks (multi-step). The everdict command harness runs it inside an os-use env-container as
// `node /agent-osworld.cjs {{task}}` (workDir=/tmp, DISPLAY=:99). The env (OsUseEnvironment.seed) brings up Xvfb+openbox,
// and the agent opens a real app (mousepad) and types the instruction's quoted text via the real OS keyboard (xdotool).
// If the instruction contains a filename (e.g. note.txt), it goes multi-step: type → Ctrl+S (save dialog) → type absolute path → Enter to save.
// Scoring is by everdict: a VLM judge (screenshot) + (if row.verify is present) a command grader verifies the actual file state.
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
  const content = (task.match(/["']([^"']+)["']/) || [])[1] || "Hello from OSWorld"; // text inside the quotes
  const fn = (task.match(/([\w.\-/]+\.\w{1,5})\b/) || [])[1] || ""; // filename (e.g. note.txt)
  const filename = fn ? (fn.startsWith("/") ? fn : `/root/${fn}`) : ""; // a relative name goes under home (/root)
  console.error("[osworld-agent] content:", content, "| filename:", filename || "(none)");

  // 1) Launch the text editor (mousepad) — cwd=home to align the save dialog's default location.
  spawn("mousepad", [], { env: { ...process.env, DISPLAY }, cwd: "/root", detached: true, stdio: "ignore" }).unref();
  let wid = "";
  for (let i = 0; i < 30 && !wid; i++) {
    await sleep(500);
    wid = shq(`DISPLAY=${DISPLAY} xdotool search --onlyvisible --class mousepad 2>/dev/null`).split(/\s+/)[0] || "";
  }
  if (!wid) throw new Error("mousepad window did not appear");
  sh(`DISPLAY=${DISPLAY} xdotool windowactivate --sync ${wid} windowfocus ${wid} windowraise ${wid}`);
  await sleep(600);

  // 2) Type the body (real OS keyboard).
  typeText(content);
  await sleep(800);

  // 3) If there is a filename, save multi-step: Ctrl+S → select all in the dialog's name entry → type the absolute path → Enter.
  if (filename) {
    key("ctrl+s");
    await sleep(1600); // wait for the save dialog
    key("ctrl+a"); // select the name entry's existing value
    await sleep(200);
    typeText(filename); // GtkFileChooser accepts an absolute path
    await sleep(400);
    key("Return"); // default action = Save
    await sleep(1600); // let the save settle
  }
  console.error("[osworld-agent] done");
})().catch((e) => {
  console.error("[osworld-agent] error", e?.stack || e);
  process.exit(1);
});
