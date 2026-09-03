// The six modules `scripts/live/evolution-campaign.mjs --claude` evolves a scaffold against. Each `solve.js`
// is plausibly wrong and each `test.js` pins a spec whose EDGE is the point: a fix written from a glance at the
// implementation satisfies most assertions and breaks one, and which one is not visible without running it.
//
// Authoring headroom is the hard part. A first attempt at this set was solved 6/6 by every scaffold — including
// one that could not run the test at all — and measured nothing. These six, against a two-turn budget, sit at
// 11/42; against six turns, 42/42.
const T = (id, wrong, asserts) => ({ id, wrong, asserts });

const TASKS = [
  T(
    "format-duration",
    'module.exports = (ms) => { const s = Math.floor(ms / 1000); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; return Math.floor(m / 60) + "h " + (m % 60) + "m"; };',
    [
      ["f(0)", '"0s"'],
      ["f(999)", '"0s"'],
      ["f(1000)", '"1s"'],
      ["f(59999)", '"59s"'],
      ["f(60000)", '"1m 0s"'],
      ["f(61000)", '"1m 1s"'],
      ["f(3599000)", '"59m 59s"'],
      ["f(3600000)", '"1h 0m"'],
      ["f(3661000)", '"1h 1m"'],
      ["f(86400000)", '"24h 0m"'],
    ],
  ),
  T("parse-query", 'module.exports = (q) => Object.fromEntries(q.split("&").map((p) => p.split("=")));', [
    ['f("a=1")', '{a:"1"}'],
    ['f("a=1&b=2")', '{a:"1",b:"2"}'],
    ['f("")', "{}"],
    ['f("a")', "{a:true}"],
    ['f("a=")', '{a:""}'],
    ['f("a=1&a=2")', '{a:["1","2"]}'],
    ['f("a=1&a=2&a=3")', '{a:["1","2","3"]}'],
    ['f("a=%20b")', '{a:" b"}'],
    ['f("a=b=c")', '{a:"b=c"}'],
  ]),
  T(
    "word-wrap",
    'module.exports = (s, w) => { const out = []; let line = ""; for (const word of s.split(" ")) { if ((line + " " + word).trim().length > w) { out.push(line.trim()); line = word; } else line += " " + word; } out.push(line.trim()); return out; };',
    [
      ['f("a b c", 5)', '["a b c"]'],
      ['f("aa bb cc", 5)', '["aa bb","cc"]'],
      ['f("", 5)', "[]"],
      ['f("abcdefgh", 3)', '["abc","def","gh"]'],
      ['f("ab abcdefgh", 4)', '["ab","abcd","efgh"]'],
      ['f("a  b", 5)', '["a  b"]'],
    ],
  ),
  T("compare-versions", "module.exports = (a, b) => (a === b ? 0 : a > b ? 1 : -1);", [
    ['f("1.0.0","1.0.0")', "0"],
    ['f("1.0.1","1.0.0")', "1"],
    ['f("1.0.0","1.0.1")', "-1"],
    ['f("1.10.0","1.9.0")', "1"],
    ['f("2.0.0","10.0.0")', "-1"],
    ['f("1.0.0-alpha","1.0.0")', "-1"],
    ['f("1.0.0","1.0.0-alpha")', "1"],
    ['f("1.0.0-alpha","1.0.0-beta")', "-1"],
    ['f("1.0.0-alpha.2","1.0.0-alpha.10")', "-1"],
  ]),
  T("csv-split", 'module.exports = (line) => line.split(",");', [
    ['f("a,b,c")', '["a","b","c"]'],
    ['f("a,,c")', '["a","","c"]'],
    ['f("")', '[""]'],
    ["f('\"a,b\",c')", '["a,b","c"]'],
    ['f(\'"a""b",c\')', '[\'a"b\',"c"]'],
    ["f('a,\"\",c')", '["a","","c"]'],
    ["f('\" a \",b')", '[" a ","b"]'],
  ]),
  T(
    "toposort",
    "module.exports = (edges) => { const out = []; for (const [a, b] of edges) { if (!out.includes(a)) out.push(a); if (!out.includes(b)) out.push(b); } return out; };",
    [
      ['f([["a","b"],["b","c"]])', '["a","b","c"]'],
      ['f([["b","c"],["a","b"]])', '["a","b","c"]'],
      ["f([])", "[]"],
      ['f([["a","b"],["a","c"],["b","d"],["c","d"]])', '["a","b","c","d"]'],
      ['(() => { try { f([["a","b"],["b","a"]]); return "no-throw"; } catch (e) { return e.message; } })()', '"cycle"'],
    ],
  ),
];

const testFor = (t) =>
  `const f = require("./solve");\nconst show = (v) => JSON.stringify(v, (_k, x) => (x === undefined ? "\\u0000undef" : x));\nconst eq = (a, b) => show(a) === show(b);\nlet failed = 0;\n${t.asserts
    .map(
      ([expr, want]) =>
        // The label is produced by JSON.stringify at GENERATION time, so an expression containing quotes
        // becomes a correct JS string literal instead of hand-escaped guesswork.
        `try { const got = ${expr}; if (!eq(got, ${want})) { console.error("FAIL " + ${JSON.stringify(expr)} + " -> " + show(got)); failed++; } }\n` +
        `catch (e) { console.error("THREW " + ${JSON.stringify(expr)} + ": " + e.message); failed++; }`,
    )
    .join(
      "\n",
    )}\nif (failed > 0) { console.error(failed + " assertion(s) failed"); process.exit(1); }\nconsole.log("PASS");\n`;

export const CC_CASES = TASKS.map((t) => ({
  id: t.id,
  task: "solve.js does not satisfy test.js. Edit solve.js so that `node test.js` prints PASS. Do not edit test.js.",
  env: { kind: "repo", source: { files: { "solve.js": `${t.wrong}\n`, "test.js": testFor(t) } } },
  graders: [{ id: "tests-pass", config: { cmd: "node test.js" } }],
  timeoutSec: 420,
  placement: { target: "devhost" },
  tags: ["cc2"],
}));
