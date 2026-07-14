// The site masks the access code (shows only bullets); the real value is in data-code. This extension "unlocks" it:
// it reads data-code and surfaces the plaintext into a stable element the agent reads (#__ext_extracted). Without the
// extension loaded, that element does not exist and the code stays masked — so the task genuinely requires it.
(() => {
  function reveal() {
    const el = document.querySelector("[data-code]");
    if (!el) return;
    const code = el.getAttribute("data-code");
    el.textContent = code; // unmask on screen
    if (!document.getElementById("__ext_extracted")) {
      const out = document.createElement("div");
      out.id = "__ext_extracted";
      out.setAttribute("data-code", code);
      out.textContent = `EXT-EXTRACTED:${code}`;
      document.body.appendChild(out);
    }
  }
  reveal();
  // in case the page renders late
  new MutationObserver(reveal).observe(document.documentElement, { childList: true, subtree: true });
})();
