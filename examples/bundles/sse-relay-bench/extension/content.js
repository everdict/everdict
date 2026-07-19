// The in-browser client. Runs only on the relay's /client page (which ships no JavaScript of its
// own — a working loop proves the extension really loaded): subscribes to this session's SSE
// stream, renders each dummy agent chat message into the DOM, and on the "done" marker reports the
// collected transcript upstream so the command server can verify it.
(() => {
  if (!location.pathname.startsWith("/client")) return;
  const params = new URLSearchParams(location.search);
  const stream = params.get("stream");
  const report = params.get("report");
  const session = params.get("session");
  if (!stream || !report || !session) return;

  const setStatus = (state) => {
    const el = document.getElementById("status");
    if (el) {
      el.dataset.state = state;
      el.textContent = state;
    }
  };

  const received = [];
  const run = () => {
    setStatus("subscribed");
    const es = new EventSource(`/events/${encodeURIComponent(stream)}`);
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "done") {
        es.close();
        fetch(`/results/${encodeURIComponent(report)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session, received }),
        })
          .then(() => setStatus("reported"))
          .catch(() => setStatus("report-failed"));
        return;
      }
      received.push(msg);
      const box = document.getElementById("messages");
      if (box) {
        const div = document.createElement("div");
        div.className = "msg";
        div.textContent = `${msg.seq}: ${msg.text ?? ""}`;
        box.appendChild(div);
      }
    };
    es.onerror = () => setStatus("sse-error");
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
