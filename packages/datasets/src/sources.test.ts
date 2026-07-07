import { describe, expect, it } from "vitest";
import { type FetchLike, fetchHfDataFiles, fetchHfFileRows, fetchHfRows } from "./sources.js";

// Fallback for datasets the viewer (datasets-server) doesn't serve — direct repo file fetch (officeqa 404 regression).
describe("HF direct file-fetch fallback", () => {
  const fetchOf =
    (body: string, capture?: { url?: string; auth?: string }): FetchLike =>
    async (url, init) => {
      if (capture) {
        capture.url = url;
        if (init?.headers?.Authorization) capture.auth = init.headers.Authorization;
      }
      return { ok: true, status: 200, text: async () => body };
    };

  it("fetchHfDataFiles returns only data files (csv/jsonl/json), sorted root-first", async () => {
    const body = JSON.stringify({
      siblings: [
        { rfilename: "README.md" },
        { rfilename: "corpus/parsed_0001.json" }, // sub-corpus files go last (so the benchmark CSV isn't buried)
        { rfilename: "officeqa_pro.csv" },
        { rfilename: "officeqa_full.csv" },
        { rfilename: "treasury_bulletin_pdfs/tb_1939_01.pdf" },
        { rfilename: "rows.jsonl" },
      ],
    });
    const files = await fetchHfDataFiles("databricks/officeqa", { fetchImpl: fetchOf(body) });
    expect(files).toEqual(["officeqa_full.csv", "officeqa_pro.csv", "rows.jsonl", "corpus/parsed_0001.json"]);
  });

  it("fetchHfFileRows(csv) fetches via the resolve URL, parses the CSV into rows, and sends the token as Authorization", async () => {
    const cap: { url?: string; auth?: string } = {};
    const csv = 'uid,question,answer\nOQA-1,"what, sir?",258.7\nOQA-2,q2,269.4\n';
    const rows = await fetchHfFileRows(
      { dataset: "databricks/officeqa", file: "officeqa_pro.csv", token: "hf_x", limit: 1 },
      fetchOf(csv, cap),
    );
    expect(cap.url).toBe("https://huggingface.co/datasets/databricks/officeqa/resolve/main/officeqa_pro.csv");
    expect(cap.auth).toBe("Bearer hf_x");
    expect(rows).toEqual([{ uid: "OQA-1", question: "what, sir?", answer: "258.7" }]); // limit applied + quoted CSV
  });

  it("fetchHfFileRows(jsonl/json) also parses into rows (a non-array json gives a friendly error)", async () => {
    const jsonl = await fetchHfFileRows({ dataset: "d/x", file: "a.jsonl" }, fetchOf('{"id":"r1"}\n{"id":"r2"}\n'));
    expect(jsonl).toEqual([{ id: "r1" }, { id: "r2" }]);
    const json = await fetchHfFileRows({ dataset: "d/x", file: "a.json" }, fetchOf('[{"id":"j1"}]'));
    expect(json).toEqual([{ id: "j1" }]);
    await expect(fetchHfFileRows({ dataset: "d/x", file: "a.json" }, fetchOf('{"id":"nope"}'))).rejects.toThrow(
      /array/,
    );
  });
});

// Import truncation regression — an import with no explicit limit must fetch the FULL dataset
// (docs/datasets.md: "import is always the full dataset"); the old default silently capped at one page (100 rows).
describe("fetchHfRows full-dataset paging", () => {
  const pagedFetch =
    (total: number): FetchLike =>
    async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const length = Number(new URL(url).searchParams.get("length"));
      const count = Math.max(0, Math.min(length, total - offset));
      const rows = Array.from({ length: count }, (_, i) => ({ row: { id: offset + i } }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ rows, num_rows_total: total }) };
    };

  it("fetches every page when no limit is given (no silent 100-row cap)", async () => {
    const rows = await fetchHfRows({ dataset: "osunlp/Online-Mind2Web" }, pagedFetch(250));
    expect(rows).toHaveLength(250);
    expect(rows[249]).toEqual({ id: 249 });
  });

  it("an explicit limit still caps the fetch", async () => {
    const rows = await fetchHfRows({ dataset: "osunlp/Online-Mind2Web", limit: 30 }, pagedFetch(250));
    expect(rows).toHaveLength(30);
  });
});
