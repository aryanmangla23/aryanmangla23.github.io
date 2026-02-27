/* ═══════════════════════════════════════════════════════════════════
   raster.js  —  interactive population spike raster
                 with firing-rate projections & joint scatter
   ═══════════════════════════════════════════════════════════════════

   PUBLIC API (attached to window so index.html buttons can call):
     toggleProjections()   — show/hide the rate-bar panel
     toggleScatter()       — show/hide the joint scatter plot
     nudgeSpeed(+1 | -1)  — speed up / slow down playback
*/

(function () {

  // ── CANVAS SETUP ────────────────────────────────────────────────
  const cv = document.getElementById('rasterCanvas');
  const cx = cv.getContext('2d');

  // ── CONFIG ──────────────────────────────────────────────────────
  const N         = 36;   // number of neurons
  const BIN_W     = 180;  // counting-window width (px / timesteps)
  const PROJ_W    = 64;   // firing-rate projection panel width (px)
  const SCATTER_SZ = 120; // scatter plot side length (px)
  const STIM_ROW_H = 18;  // stimulus row height (px)
  const TOP_PAD   = 6;
  const BOT_PAD   = 28;   // enough room for legend text descenders
  const BUF       = 4096; // ring-buffer length (must be > canvas width)

  // ── STATE ────────────────────────────────────────────────────────
  let showProjections  = true;
  let showScatter      = true;
  let speed            = 1;   // timesteps advanced per animation frame
  let mouseIsDown      = false;
  let mouseYpos        = -1;
  let hoveredNeuron    = -1;
  let screensaverTimer = 0;
  let screensaverActive = false;
  let autoStimDur      = 0;
  let autoStimGap      = 0;
  let tGlobal          = 0;
  let scatterA         = 0;
  let scatterB         = 1;
  let scatterPts       = [];  // [{a, b}] rolling history

  // ── NEURON DEFINITIONS ──────────────────────────────────────────
  // Cell types cycle: mostly excitatory, some inhibitory, a few modulatory
  const TYPE_CYCLE = ['E','E','E','E','E','E','E','I','I','I','I','mod'];

  const neurons = Array.from({ length: N }, (_, i) => ({
    type:        TYPE_CYCLE[i % TYPE_CYCLE.length],
    base:        0.006 + Math.random() * 0.012,  // spontaneous firing prob
    sensitivity: 0.04  + Math.random() * 0.09,   // stim response gain
    delay:       Math.floor(1 + Math.random() * 90), // synaptic delay (ticks)
    decay:       0.45  + Math.random() * 0.25,   // drive decay per tick
    burst:       Math.random() < 0.10,            // occasional burst neuron
    ref:         0,                               // refractory counter
    drive:       0,                               // current synaptic drive
    spikes:      new Uint8Array(BUF),             // ring buffer of spike events
  }));

  // ── STIMULUS BUFFER ─────────────────────────────────────────────
  const stimBuf = new Uint8Array(BUF);

  // ── SPIKE-COUNT COLORS ──────────────────────────────────────────
  const COLORS = {
    E:   'rgba(34,197,94,',
    I:   'rgba(239,68,68,',
    mod: 'rgba(167,139,250,',
  };

  // ════════════════════════════════════════════════════════════════
  // LAYOUT HELPERS  (all depend on current canvas dimensions)
  // ════════════════════════════════════════════════════════════════

  function getRowH() {
    // clamp row height to something readable regardless of N
    return Math.max(7, Math.min(14, (cv.height * 0.8) / (N + 1)));
  }

  function rasterLeft()  { return 72; }

  function rasterRight() {
    return cv.width
      - (showProjections ? PROJ_W + 4   : 0)
      - (showScatter     ? SCATTER_SZ + 8 : 0);
  }

  function neuronY(j) {
    return TOP_PAD + STIM_ROW_H + j * getRowH() + getRowH() / 2;
  }

  function stimY() { return TOP_PAD + STIM_ROW_H / 2; }

  function projBaseX() { return rasterRight() + 4; }

  function scatterOriginX() {
    return projBaseX() + (showProjections ? PROJ_W : 0) + 8;
  }

  function scatterOriginY() {
    return TOP_PAD + STIM_ROW_H + (showScatter ? SCATTER_SZ : 0);
  }

  // ════════════════════════════════════════════════════════════════
  // RESIZE
  // ════════════════════════════════════════════════════════════════

  function resize() {
    cv.width = cv.parentElement.clientWidth;

    // seed a real height first so getRowH() has a number to work with
    cv.height = Math.max(340, window.innerHeight * 0.45);
    const rowH    = getRowH();
    cv.height     = STIM_ROW_H + N * rowH + TOP_PAD + BOT_PAD;
    cv.style.height = cv.height + 'px';
  }

  window.addEventListener('resize', resize);

  // ════════════════════════════════════════════════════════════════
  // PUBLIC TOGGLE API
  // ════════════════════════════════════════════════════════════════

  window.toggleProjections = function () {
    showProjections = !showProjections;
    document.getElementById('btnProj').classList.toggle('on', showProjections);
    resize();
  };

  window.toggleScatter = function () {
    showScatter = !showScatter;
    document.getElementById('btnScatter').classList.toggle('on', showScatter);
    resize();
  };

  window.nudgeSpeed = function (dir) {
    speed = Math.max(1, Math.min(4, speed + dir));
  };

  // ════════════════════════════════════════════════════════════════
  // INPUT EVENTS
  // ════════════════════════════════════════════════════════════════

  cv.addEventListener('mousedown', () => {
    mouseIsDown      = true;
    screensaverActive = false;
    screensaverTimer = 0;
  });

  cv.addEventListener('mouseup',    () => { mouseIsDown = false; });

  cv.addEventListener('mouseleave', () => {
    mouseIsDown   = false;
    mouseYpos     = -1;
    hoveredNeuron = -1;
  });

  cv.addEventListener('mousemove', e => {
    const rect   = cv.getBoundingClientRect();
    const scaleY = cv.height / rect.height;
    mouseYpos = (e.clientY - rect.top) * scaleY;

    screensaverActive = false;
    screensaverTimer  = 0;

    // which neuron row is the cursor on?
    const rowH = getRowH();
    const j    = Math.floor((mouseYpos - TOP_PAD - STIM_ROW_H) / rowH);

    if (j >= 0 && j < N) {
      if (j !== hoveredNeuron) {
        // changed row — reset scatter history for the new pair
        hoveredNeuron = j;
        scatterA      = j;
        scatterB      = (j + 1) % N;
        scatterPts    = [];
      }
    } else {
      hoveredNeuron = -1;
    }
  });

  // touch support (mobile)
  cv.addEventListener('touchstart', e => {
    mouseIsDown      = true;
    screensaverActive = false;
    screensaverTimer  = 0;
    e.preventDefault();
  }, { passive: false });

  cv.addEventListener('touchend', () => { mouseIsDown = false; });

  // ════════════════════════════════════════════════════════════════
  // SIMULATION — STIMULUS
  // ════════════════════════════════════════════════════════════════

  function updateStimulus() {
    let s = 0;

    if (mouseIsDown) {
      // user is holding the canvas
      s = 1;

    } else if (screensaverActive) {
      // auto-stimulation screensaver
      if (autoStimDur > 0) {
        s = 1;
        autoStimDur--;
      } else {
        autoStimGap--;
        if (autoStimGap <= 0) {
          autoStimDur = 80 + Math.floor(Math.random() * 200);
          autoStimGap = 100 + Math.floor(Math.random() * 300);
        }
      }

    } else {
      // idle — count down to screensaver
      screensaverTimer++;
      if (screensaverTimer > 420) {
        screensaverActive = true;
        autoStimDur       = 0;
        autoStimGap       = 20;
      }
    }

    stimBuf[tGlobal % BUF] = s;
    return s;
  }

  // ════════════════════════════════════════════════════════════════
  // SIMULATION — NEURONS
  // ════════════════════════════════════════════════════════════════

  function updateNeurons() {
    for (let j = 0; j < N; j++) {
      const n = neurons[j];

      // delayed stimulus input
      const tDelayed = ((tGlobal - n.delay) % BUF + BUF) % BUF;
      if (stimBuf[tDelayed]) n.drive = 1;
      else n.drive *= n.decay;

      // refractory period
      if (n.ref > 0) {
        n.ref--;
        n.spikes[tGlobal % BUF] = 0;
        continue;
      }

      // stochastic firing
      let rate = n.base + n.drive * n.sensitivity;
      if (n.burst && Math.random() < 0.006) rate *= 6;

      const fired = Math.random() < rate;
      n.spikes[tGlobal % BUF] = fired ? 1 : 0;
      if (fired) n.ref = 3 + Math.floor(Math.random() * 6);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // COUNT SPIKES in the current bin window
  // ════════════════════════════════════════════════════════════════

  function countBin() {
    const counts = new Array(N).fill(0);
    for (let j = 0; j < N; j++) {
      for (let dt = 0; dt < BIN_W; dt++) {
        const ti = ((tGlobal - dt) % BUF + BUF) % BUF;
        counts[j] += neurons[j].spikes[ti];
      }
    }
    return counts;
  }

  // ════════════════════════════════════════════════════════════════
  // DRAW
  // ════════════════════════════════════════════════════════════════

  function draw() {
    const W      = cv.width;
    const H      = cv.height;
    const rl     = rasterLeft();
    const rr     = rasterRight();
    const usable = rr - rl;
    const rowH   = getRowH();

    // ── background ──
    cx.fillStyle = '#020a14';
    cx.fillRect(0, 0, W, H);

    // ── counting-window highlight ──
    const binScreenX = rr - BIN_W;
    cx.fillStyle = 'rgba(34,197,94,0.04)';
    cx.fillRect(binScreenX, TOP_PAD, BIN_W, STIM_ROW_H + N * rowH);
    cx.strokeStyle = 'rgba(34,197,94,0.12)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(binScreenX, TOP_PAD);
    cx.lineTo(binScreenX, TOP_PAD + STIM_ROW_H + N * rowH);
    cx.stroke();

    // ── hover highlight (two rows) ──
    if (hoveredNeuron >= 0) {
      cx.fillStyle = 'rgba(34,197,94,0.07)';
      cx.fillRect(rl, neuronY(hoveredNeuron) - rowH / 2, rr - rl, rowH);

      if (hoveredNeuron + 1 < N) {
        cx.fillStyle = 'rgba(59,130,246,0.06)';
        cx.fillRect(rl, neuronY(hoveredNeuron + 1) - rowH / 2, rr - rl, rowH);
      }
    }

    // ── spike raster ──
    for (let j = 0; j < N; j++) {
      const n      = neurons[j];
      const y      = neuronY(j);
      const col    = COLORS[n.type];
      const isHov  = (j === hoveredNeuron || j === hoveredNeuron + 1);
      const spikeH = rowH * 0.72;

      for (let dx = 0; dx < usable; dx++) {
        const ti = ((tGlobal - (usable - 1 - dx)) % BUF + BUF) % BUF;
        if (!n.spikes[ti]) continue;

        const screenX = rl + dx;
        const inBin   = screenX >= binScreenX;
        let alpha, lw;

        if (inBin) {
          alpha = isHov ? 1.0 : 0.9;
          lw    = isHov ? 2   : 1.5;
        } else {
          const age = (usable - 1 - dx) / usable;
          alpha = isHov ? (0.35 + (1 - age) * 0.45) : (0.12 + (1 - age) * 0.25);
          lw    = isHov ? 1.5 : 1;
        }

        // glow halo
        cx.strokeStyle = col + (alpha * 0.25) + ')';
        cx.lineWidth   = lw + 3;
        cx.beginPath();
        cx.moveTo(screenX, y - spikeH / 2 - 1);
        cx.lineTo(screenX, y + spikeH / 2 + 1);
        cx.stroke();

        // core tick
        cx.strokeStyle = col + alpha + ')';
        cx.lineWidth   = lw;
        cx.beginPath();
        cx.moveTo(screenX, y - spikeH / 2);
        cx.lineTo(screenX, y + spikeH / 2);
        cx.stroke();
      }
    }

    // ── stimulus row ──
    const sy = stimY();
    for (let dx = 0; dx < usable; dx++) {
      const ti = ((tGlobal - (usable - 1 - dx)) % BUF + BUF) % BUF;
      if (!stimBuf[ti]) continue;
      const screenX = rl + dx;
      cx.strokeStyle = (screenX >= binScreenX)
        ? 'rgba(251,191,36,0.9)'
        : 'rgba(251,191,36,0.3)';
      cx.lineWidth = 2;
      cx.beginPath();
      cx.moveTo(screenX, sy - STIM_ROW_H * 0.38);
      cx.lineTo(screenX, sy + STIM_ROW_H * 0.38);
      cx.stroke();
    }

    // ── left-side labels ──
    cx.font         = '9px Space Mono, monospace';
    cx.textAlign    = 'right';
    cx.textBaseline = 'middle';
    const labelX    = rl - 5;

    cx.fillStyle = 'rgba(251,191,36,0.55)';
    cx.fillText('stim', labelX, stimY());

    for (let j = 0; j < N; j++) {
      const isHov = (j === hoveredNeuron || j === hoveredNeuron + 1);
      if (isHov) {
        cx.fillStyle = COLORS[neurons[j].type] + '0.8)';
        cx.fillText('n' + (j + 1), labelX, neuronY(j));
      } else if (j % 5 === 0) {
        cx.fillStyle = 'rgba(136,150,170,0.25)';
        cx.fillText('n' + (j + 1), labelX, neuronY(j));
      }
    }

    // ── firing-rate projection panel ──
    const counts = countBin();

    if (showProjections) {
      const px       = projBaseX();
      const maxBarW  = PROJ_W - 8;
      const panelH   = STIM_ROW_H + N * rowH;
      const maxCount = Math.max(...counts, 1);

      cx.fillStyle = 'rgba(4,8,16,0.85)';
      cx.fillRect(px, TOP_PAD, PROJ_W, panelH);
      cx.strokeStyle = 'rgba(255,255,255,0.04)';
      cx.lineWidth = 1;
      cx.strokeRect(px, TOP_PAD, PROJ_W, panelH);

      cx.fillStyle    = 'rgba(136,150,170,0.4)';
      cx.font         = '8px Space Mono, monospace';
      cx.textAlign    = 'center';
      cx.textBaseline = 'middle';
      cx.fillText('rate', px + PROJ_W / 2, stimY());

      // vertical zero-line
      cx.strokeStyle = 'rgba(136,150,170,0.1)';
      cx.lineWidth   = 1;
      cx.beginPath();
      cx.moveTo(px + 2, TOP_PAD + STIM_ROW_H);
      cx.lineTo(px + 2, TOP_PAD + STIM_ROW_H + N * rowH);
      cx.stroke();

      for (let j = 0; j < N; j++) {
        const y      = neuronY(j);
        const rate   = counts[j] / BIN_W;
        const barW   = (counts[j] / maxCount) * maxBarW;
        const isHov  = (j === hoveredNeuron || j === hoveredNeuron + 1);
        const col    = COLORS[neurons[j].type];
        const alpha  = isHov ? 0.85 : 0.4;

        // track
        cx.fillStyle = 'rgba(255,255,255,0.03)';
        cx.fillRect(px + 2, y - rowH / 2 + 1, maxBarW, rowH - 2);

        // bar
        cx.fillStyle = col + alpha + ')';
        cx.fillRect(px + 2, y - rowH / 2 + 1, barW, rowH - 2);

        // Hz label on hover
        if (isHov) {
          cx.fillStyle    = col + '0.9)';
          cx.font         = '8px Space Mono, monospace';
          cx.textAlign    = 'right';
          cx.textBaseline = 'middle';
          cx.fillText((rate * 1000).toFixed(0) + 'Hz', px + PROJ_W - 1, y);
        }
      }
    }

    // ── population rate summary bar ──
    {
      const popRate  = counts.reduce((a, b) => a + b, 0) / (N * BIN_W);
      const barAreaY = TOP_PAD + STIM_ROW_H + N * rowH + 4;
      const barAreaH = 10;
      const barAreaW = rr - rl;

      cx.fillStyle = 'rgba(34,197,94,0.07)';
      cx.fillRect(rl, barAreaY, barAreaW, barAreaH);
      cx.fillStyle = 'rgba(34,197,94,0.55)';
      cx.fillRect(rl, barAreaY, barAreaW * popRate * 12, barAreaH);

      cx.font         = '8px Space Mono, monospace';
      cx.textBaseline = 'middle';

      cx.fillStyle  = 'rgba(136,150,170,0.3)';
      cx.textAlign  = 'left';
      cx.fillText('population rate', rl, barAreaY + barAreaH + 9);

      cx.fillStyle  = 'rgba(136,150,170,0.3)';
      cx.textAlign  = 'right';
      cx.fillText((popRate * 1000).toFixed(1) + ' Hz/n', rr, barAreaY + barAreaH + 9);
    }

    // ── joint scatter plot ──
    if (showScatter) {
      const sox = scatterOriginX();
      const soy = scatterOriginY();
      const sz  = SCATTER_SZ;

      // collect snapshot every 30 ticks
      if (tGlobal % 30 === 0) {
        scatterPts.push([counts[scatterA], counts[scatterB]]);
        if (scatterPts.length > 80) scatterPts.shift();
      }

      const maxC = Math.max(
        BIN_W * 0.25,
        ...scatterPts.map(p => Math.max(p[0], p[1])),
        1
      );

      // background
      cx.fillStyle   = 'rgba(4,8,16,0.9)';
      cx.fillRect(sox, soy - sz, sz, sz);
      cx.strokeStyle = 'rgba(255,255,255,0.06)';
      cx.lineWidth   = 1;
      cx.strokeRect(sox, soy - sz, sz, sz);

      // grid lines
      cx.strokeStyle = 'rgba(136,150,170,0.12)';
      [0.25, 0.5, 0.75].forEach(f => {
        cx.beginPath(); cx.moveTo(sox + f * sz, soy - sz); cx.lineTo(sox + f * sz, soy); cx.stroke();
        cx.beginPath(); cx.moveTo(sox, soy - f * sz);      cx.lineTo(sox + sz, soy - f * sz); cx.stroke();
      });

      // identity line
      cx.strokeStyle = 'rgba(136,150,170,0.08)';
      cx.beginPath(); cx.moveTo(sox, soy); cx.lineTo(sox + sz, soy - sz); cx.stroke();

      // history cloud
      scatterPts.forEach((pt, i) => {
        const alpha = 0.08 + (i / scatterPts.length) * 0.35;
        const x     = sox + (pt[0] / maxC) * sz;
        const y     = soy - (pt[1] / maxC) * sz;
        cx.beginPath(); cx.arc(x, y, 3, 0, Math.PI * 2);
        cx.fillStyle = `rgba(239,68,68,${alpha})`; cx.fill();
      });

      // current point
      const cpx = sox + (counts[scatterA] / maxC) * sz;
      const cpy = soy - (counts[scatterB] / maxC) * sz;
      cx.beginPath(); cx.arc(cpx, cpy, 5, 0, Math.PI * 2);
      cx.fillStyle = 'rgba(239,68,68,0.9)'; cx.fill();
      cx.beginPath(); cx.arc(cpx, cpy, 9, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(239,68,68,0.25)'; cx.lineWidth = 2; cx.stroke();

      // axis labels
      cx.font         = '8px Space Mono, monospace';
      cx.fillStyle    = 'rgba(136,150,170,0.4)';
      cx.textAlign    = 'center';
      cx.textBaseline = 'top';
      cx.fillText('n' + (scatterA + 1) + ' rate', sox + sz / 2, soy + 3);

      cx.save();
      cx.translate(sox - 3, soy - sz / 2);
      cx.rotate(-Math.PI / 2);
      cx.textBaseline = 'bottom';
      cx.fillText('n' + (scatterB + 1) + ' rate', 0, 0);
      cx.restore();

      cx.textAlign    = 'center';
      cx.textBaseline = 'top';
      cx.fillStyle    = 'rgba(239,68,68,0.45)';
      cx.fillText('joint rate', sox + sz / 2, soy - sz - 14);
    }

    // ── legend + hint ──
    cx.textAlign    = 'left';
    cx.textBaseline = 'bottom';
    cx.font         = '9px Space Mono, monospace';
    const ly        = H - 8;

    [
      ['▪ E',   COLORS.E   + '0.6)', 0  ],
      ['▪ I',   COLORS.I   + '0.6)', 30 ],
      ['▪ mod', COLORS.mod + '0.6)', 60 ],
    ].forEach(([label, color, offsetX]) => {
      cx.fillStyle = color;
      cx.fillText(label, rasterLeft() + offsetX, ly);
    });

    cx.fillStyle = 'rgba(136,150,170,0.28)';
    cx.fillText(
      'hold to stimulate  ·  hover to highlight  ·  ' + speed + '× speed',
      rasterLeft() + 110, ly
    );
  }

  // ════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ════════════════════════════════════════════════════════════════

  function frame() {
    for (let i = 0; i < speed; i++) {
      updateStimulus();
      updateNeurons();
      tGlobal++;
    }
    draw();
    requestAnimationFrame(frame);
  }

  // ════════════════════════════════════════════════════════════════
  // BOOT  — pre-fill history so the raster looks full on load
  // ════════════════════════════════════════════════════════════════

  function boot() {
    screensaverActive = true;
    autoStimDur       = 0;
    autoStimGap       = 10;

    for (let i = 0; i < 2000; i++) {
      updateStimulus();
      updateNeurons();
      tGlobal++;
    }

    screensaverTimer = 0;
    resize();
    requestAnimationFrame(frame);
  }

  // defer slightly so Google Fonts have time to load
  setTimeout(boot, 80);

})();