import { describe, expect, it } from "vitest";
import { type FetchLike, fetchHfDataFiles, fetchHfFileRows } from "./sources.js";

// 뷰어(datasets-server) 미서빙 데이터셋 폴백 — repo 파일 직접 인출(officeqa 404 회귀).
describe("HF 파일 직접 인출 폴백", () => {
  const fetchOf =
    (body: string, capture?: { url?: string; auth?: string }): FetchLike =>
    async (url, init) => {
      if (capture) {
        capture.url = url;
        if (init?.headers?.Authorization) capture.auth = init.headers.Authorization;
      }
      return { ok: true, status: 200, text: async () => body };
    };

  it("fetchHfDataFiles 는 데이터 파일(csv/jsonl/json)만, 루트 우선 정렬로 돌려준다", async () => {
    const body = JSON.stringify({
      siblings: [
        { rfilename: "README.md" },
        { rfilename: "corpus/parsed_0001.json" }, // 하위 코퍼스 파일은 뒤로(벤치마크 CSV 가 묻히지 않게)
        { rfilename: "officeqa_pro.csv" },
        { rfilename: "officeqa_full.csv" },
        { rfilename: "treasury_bulletin_pdfs/tb_1939_01.pdf" },
        { rfilename: "rows.jsonl" },
      ],
    });
    const files = await fetchHfDataFiles("databricks/officeqa", { fetchImpl: fetchOf(body) });
    expect(files).toEqual(["officeqa_full.csv", "officeqa_pro.csv", "rows.jsonl", "corpus/parsed_0001.json"]);
  });

  it("fetchHfFileRows(csv) 는 resolve URL 로 받아 CSV 를 행으로 파싱하고 토큰을 Authorization 으로 보낸다", async () => {
    const cap: { url?: string; auth?: string } = {};
    const csv = 'uid,question,answer\nOQA-1,"what, sir?",258.7\nOQA-2,q2,269.4\n';
    const rows = await fetchHfFileRows(
      { dataset: "databricks/officeqa", file: "officeqa_pro.csv", token: "hf_x", limit: 1 },
      fetchOf(csv, cap),
    );
    expect(cap.url).toBe("https://huggingface.co/datasets/databricks/officeqa/resolve/main/officeqa_pro.csv");
    expect(cap.auth).toBe("Bearer hf_x");
    expect(rows).toEqual([{ uid: "OQA-1", question: "what, sir?", answer: "258.7" }]); // limit 적용 + 따옴표 CSV
  });

  it("fetchHfFileRows(jsonl/json) 도 행으로 파싱한다(비배열 json 은 친화 에러)", async () => {
    const jsonl = await fetchHfFileRows({ dataset: "d/x", file: "a.jsonl" }, fetchOf('{"id":"r1"}\n{"id":"r2"}\n'));
    expect(jsonl).toEqual([{ id: "r1" }, { id: "r2" }]);
    const json = await fetchHfFileRows({ dataset: "d/x", file: "a.json" }, fetchOf('[{"id":"j1"}]'));
    expect(json).toEqual([{ id: "j1" }]);
    await expect(fetchHfFileRows({ dataset: "d/x", file: "a.json" }, fetchOf('{"id":"nope"}'))).rejects.toThrow(/배열/);
  });
});
