/**
 * Reactive voice blob — canvas 2D, no dependencies.
 *
 * A luminous sphere whose radius, surface wobble and rim colour respond to a
 * live audio level (0..1). Used for both directions of the conversation: the
 * microphone drives it while the shopper talks, the TTS output drives it while
 * Kaira answers.
 */

// Wobble stays small on purpose: this reads as a luminous sphere that breathes,
// not an amoeba. Audio moves the radius, the rim brightness and the sheen.
// Warm-glass palette: the orb reads as a lit orb on a light ground, so the body
// is luminous rather than dark and the rim carries the brand wash.
const PALETTES = {
  idle:      { a: "#F9873F", b: "#A5AFF5", glow: 0.55, spin: 0.16, wobble: 0.012 },
  listening: { a: "#F26B1D", b: "#6E7BE8", glow: 1.00, spin: 0.42, wobble: 0.022 },
  thinking:  { a: "#FFB067", b: "#6E7BE8", glow: 0.80, spin: 1.30, wobble: 0.018 },
  speaking:  { a: "#6E7BE8", b: "#F26B1D", glow: 1.20, spin: 0.34, wobble: 0.030 },
};

export class VoiceBlob {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = "idle";
    this.level = 0;      // target, set externally
    this.smooth = 0;     // eased actual
    this.t = 0;
    this.raf = null;
    this._resize();
    addEventListener("resize", () => this._resize());
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.w = r.width || 300; this.h = r.height || 300;
    this.c.width = this.w * dpr; this.c.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(s) { if (PALETTES[s]) this.state = s; }
  setLevel(v) { this.level = Math.max(0, Math.min(1, v)); }

  start() { if (!this.raf) this._loop(); }
  stop()  { cancelAnimationFrame(this.raf); this.raf = null; }

  _loop = () => {
    this.raf = requestAnimationFrame(this._loop);
    const p = PALETTES[this.state];
    this.t += 0.016 * (1 + p.spin);
    // Fast attack, slow release - feels responsive without jitter.
    const k = this.level > this.smooth ? 0.35 : 0.06;
    this.smooth += (this.level - this.smooth) * k;
    this._draw(p, this.smooth);
  };

  _draw(p, amp) {
    const { ctx, w, h, t } = this;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * (0.30 + amp * 0.045);

    ctx.clearRect(0, 0, w, h);

    // contact shadow - without it the orb floats off a light surface
    ctx.save();
    ctx.fillStyle = "rgba(22,22,43,0.16)";
    ctx.filter = "blur(7px)";
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.92, R * 0.72, R * 0.13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // outer bloom
    const bloom = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.55);
    bloom.addColorStop(0, this._rgba(p.a, 0.42 * p.glow * (0.6 + amp)));
    bloom.addColorStop(0.4, this._rgba(p.b, 0.20 * p.glow * (0.6 + amp)));
    bloom.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, w, h);

    // wobbly outline
    const path = new Path2D();
    const wob = p.wobble + amp * 0.035;
    for (let i = 0; i <= 180; i++) {
      const a = (i / 180) * Math.PI * 2;
      const r = R * (1
        + wob * Math.sin(3 * a + t * 0.9)
        + wob * 0.6 * Math.sin(5 * a - t * 1.3)
        + wob * 0.45 * Math.sin(2 * a + t * 2.1));
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i ? path.lineTo(x, y) : path.moveTo(x, y);
    }
    path.closePath();

    // dark glassy body
    const body = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.05, cx, cy, R * 1.1);
    // Dark, glassy body: on a light panel the orb has to be the dark object or
    // the rim has nothing to sit against.
    body.addColorStop(0, "rgba(46,44,78,0.97)");
    body.addColorStop(0.62, "rgba(24,23,48,0.99)");
    body.addColorStop(1, "rgba(14,13,32,1)");
    ctx.fillStyle = body;
    ctx.fill(path);

    // rim light - conic where supported, two arcs otherwise
    ctx.save();
    ctx.clip(path);
    ctx.lineWidth = R * (0.19 + amp * 0.06);
    let rim;
    if (ctx.createConicGradient) {
      rim = ctx.createConicGradient(t * 0.5, cx, cy);
      rim.addColorStop(0.00, this._rgba(p.a, 1));
      rim.addColorStop(0.18, this._rgba(p.a, 0.92));
      rim.addColorStop(0.38, this._rgba(p.b, 0.95));
      rim.addColorStop(0.52, this._rgba(p.b, 1));
      rim.addColorStop(0.66, "rgba(255,255,255,0.16)");   // quiet quadrant
      rim.addColorStop(0.80, "rgba(255,255,255,0.10)");
      rim.addColorStop(1.00, this._rgba(p.a, 1));
    } else {
      rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      rim.addColorStop(0, this._rgba(p.a, 0.9));
      rim.addColorStop(1, this._rgba(p.b, 0.9));
    }
    ctx.strokeStyle = rim;
    ctx.globalAlpha = 0.95;
    ctx.shadowBlur = R * 0.7 * p.glow;
    ctx.shadowColor = this._rgba(p.a, 0.95);
    ctx.stroke(path);
    ctx.stroke(path);                       // second pass deepens the bloom
    ctx.globalAlpha = 1;
    ctx.restore();

    // crisp outer edge so the sphere reads as a solid object
    ctx.save();
    ctx.lineWidth = Math.max(1, R * 0.012);
    ctx.strokeStyle = this._rgba(p.a, 0.30 + amp * 0.3);
    ctx.shadowBlur = R * 0.5 * p.glow;
    ctx.shadowColor = this._rgba(p.b, 0.7);
    ctx.stroke(path);
    ctx.restore();

    // inner sheen drifting with the audio
    const hx = cx - R * 0.10 + Math.sin(t * 0.7) * R * 0.09;
    const hy = cy + R * 0.02 + Math.cos(t * 0.9) * R * 0.09;
    const hr = R * (0.30 + amp * 0.20);
    const sheen = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    sheen.addColorStop(0, `rgba(255,255,255,${Math.min(1, 0.82 + amp * 0.45)})`);
    sheen.addColorStop(0.35, `rgba(255,226,196,${0.5 * (0.5 + amp)})`);
    sheen.addColorStop(0.7, `rgba(214,216,255,${0.16 * (0.5 + amp)})`);
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();
  }

  _rgba(hex, a) {
    const [r, g, b] = hex.slice(1).match(/../g).map((v) => parseInt(v, 16));
    return `rgba(${r},${g},${b},${a})`;
  }
}

/**
 * Smoothed 0..1 loudness from a MediaStream or an <audio> element.
 * One shared AudioContext - browsers cap how many you may create.
 */
let AC = null;
const ctx = () => (AC ??= new (window.AudioContext || window.webkitAudioContext)());

export class Level {
  constructor() { this.analyser = null; this.data = null; this.srcNode = null; }

  _mk() {
    const a = ctx().createAnalyser();
    a.fftSize = 512;
    a.smoothingTimeConstant = 0.75;
    this.analyser = a;
    this.data = new Uint8Array(a.frequencyBinCount);
    return a;
  }

  fromStream(stream) {
    this.detach();
    this.srcNode = ctx().createMediaStreamSource(stream);
    this.srcNode.connect(this._mk());          // not routed to output: no echo
    return this;
  }

  /** Element audio must still reach the speakers, so tap and pass through. */
  fromElement(el) {
    this.detach();
    el._srcNode ??= ctx().createMediaElementSource(el);
    this.srcNode = el._srcNode;
    const a = this._mk();
    this.srcNode.connect(a);
    this.srcNode.connect(ctx().destination);
    return this;
  }

  read() {
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    const rms = Math.sqrt(sum / this.data.length) / 255;
    return Math.min(1, rms * 3.2);           // speech sits low in the range
  }

  detach() { try { this.srcNode?.disconnect(); } catch {} this.analyser = null; }
  static resume() { const c = ctx(); if (c.state === "suspended") c.resume(); }
}
