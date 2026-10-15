// Synthetic cursor for the demo recordings (headless Chromium draws no pointer). Injected with page.addInitScript, so
// it runs in every document: SPA navigations keep it, full page loads re-create it at the last known position
// (kept in sessionStorage, which survives same-tab navigations). A fixed-position arrow follows real mousemove
// events (the ones page.mouse.move dispatches); mousedown adds a short expanding ring.
(() => {
  if (window.__demoCursorInstalled || window !== window.top) return;
  window.__demoCursorInstalled = true;
  const KEY = "__demoCursorPos";
  let x = 960;
  let y = 540;
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) ({ x, y } = saved);
  } catch {}

  const ARROW =
    "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'>" +
    "<path d='M3 2 L3 20 L8 15.5 L11.5 23 L15 21.4 L11.6 14 L18.5 14 Z' fill='white' stroke='#111' stroke-width='1.8' stroke-linejoin='round'/></svg>";

  const root = document.createElement("div");
  root.id = "__demo-cursor";
  root.setAttribute("aria-hidden", "true");
  root.style.cssText =
    "position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;will-change:transform;" +
    "filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));";
  root.innerHTML = ARROW;
  const place = () => {
    root.style.transform = `translate(${x - 3}px, ${y - 2}px)`; // the arrow tip is at (3, 2) in the 26 px box
  };
  place();

  // The init script can run before <html> exists: mount as soon as it does, and re-attach if something removes us
  // (the cursor lives on <html>, so rebuilding <body> does not touch it).
  const mount = () => {
    if (document.documentElement && !root.isConnected) document.documentElement.appendChild(root);
  };
  mount();
  const mo = new MutationObserver(mount);
  mo.observe(document, { childList: true });
  if (document.documentElement) mo.observe(document.documentElement, { childList: true });
  else document.addEventListener("readystatechange", () => document.documentElement && mo.observe(document.documentElement, { childList: true }), { once: true });

  const save = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ x, y }));
    } catch {}
  };

  window.addEventListener(
    "mousemove",
    (e) => {
      x = e.clientX;
      y = e.clientY;
      place();
      save();
    },
    { capture: true, passive: true },
  );

  window.addEventListener(
    "mousedown",
    (e) => {
      x = e.clientX;
      y = e.clientY;
      place();
      save();
      const ring = document.createElement("div");
      ring.setAttribute("aria-hidden", "true");
      ring.style.cssText =
        `position:fixed;left:${x - 6}px;top:${y - 6}px;width:12px;height:12px;border-radius:50%;box-sizing:border-box;` +
        "border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 1.5px rgba(17,17,17,.6);z-index:2147483646;pointer-events:none;";
      (document.documentElement || document).appendChild(ring);
      const anim = ring.animate(
        [
          { transform: "scale(1)", opacity: 0.95 },
          { transform: "scale(3.6)", opacity: 0 },
        ],
        { duration: 520, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      anim.onfinish = () => ring.remove();
    },
    { capture: true, passive: true },
  );
})();
