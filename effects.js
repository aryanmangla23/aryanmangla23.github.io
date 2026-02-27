/* ═══════════════════════════════════════════════
   effects.js  —  cursor glow & scroll fade-ins
   ═══════════════════════════════════════════════ */

// ── CURSOR GLOW ──────────────────────────────────
const glowEl = document.getElementById('cursorGlow');

document.addEventListener('mousemove', e => {
  glowEl.style.left = e.clientX + 'px';
  glowEl.style.top  = e.clientY + 'px';
});

// ── SCROLL FADE-IN ───────────────────────────────
const fadeObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('fade-in-visible');
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.fade-in').forEach(el => fadeObserver.observe(el));