(() => {
  const fine = window.matchMedia("(pointer: fine)").matches;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduce) return;

  const root = document.createElement("div");
  root.className = "fx-root";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="fx-ambient"></div>
    <div class="fx-scan"></div>
    <div class="fx-dot"></div>
    <div class="fx-ring"></div>
  `;
  document.body.prepend(root);

  const dot = root.querySelector(".fx-dot");
  const ring = root.querySelector(".fx-ring");
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let rx = x;
  let ry = y;
  let visible = false;

  const onMove = (e) => {
    x = e.clientX;
    y = e.clientY;
    if (!visible) {
      visible = true;
      root.classList.add("on");
    }
  };
  const onLeave = () => {
    visible = false;
    root.classList.remove("on");
  };
  const onDown = () => root.classList.add("press");
  const onUp = () => root.classList.remove("press");

  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });
  document.documentElement.addEventListener("mouseleave", onLeave);

  const tick = () => {
    rx += (x - rx) * 0.18;
    ry += (y - ry) * 0.18;
    dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
