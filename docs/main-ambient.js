(() => {
  'use strict';
  const canvas = document.querySelector('#ambientCanvas');
  if (!canvas) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = Boolean(navigator.connection?.saveData);
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let running = !document.hidden;
  const pointer = { x: .5, y: .5, tx: .5, ty: .5 };
  const count = saveData ? 16 : window.innerWidth < 700 ? 28 : 54;
  const stars = Array.from({ length: count }, (_, index) => ({
    x: ((index * 47) % 101) / 101,
    y: ((index * 73 + 17) % 103) / 103,
    r: .45 + (index % 5) * .16,
    drift: .00003 + (index % 7) * .000008,
    alpha: .12 + (index % 4) * .045,
  }));

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(time = 0) {
    if (!running) return;
    context.clearRect(0, 0, width, height);
    pointer.x += (pointer.tx - pointer.x) * .025;
    pointer.y += (pointer.ty - pointer.y) * .025;
    stars.forEach((star, index) => {
      const x = ((star.x + (reducedMotion ? 0 : time * star.drift)) % 1) * width + (pointer.x - .5) * (index % 3) * 7;
      const y = star.y * height + (pointer.y - .5) * (index % 4) * 5;
      context.beginPath();
      context.fillStyle = `rgba(38, 105, 78, ${star.alpha})`;
      context.arc(x, y, star.r, 0, Math.PI * 2);
      context.fill();
    });
    if (!reducedMotion) frame = requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', (event) => {
    pointer.tx = event.clientX / Math.max(1, width);
    pointer.ty = event.clientY / Math.max(1, height);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (!running) cancelAnimationFrame(frame);
    else if (!reducedMotion) frame = requestAnimationFrame(draw);
  });
  resize();
  draw();
})();
