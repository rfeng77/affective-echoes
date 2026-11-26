// =====================================================================
// Affect detection layer
// Fuses face (face-api.js expressions), voice (energy + pitch) and
// language (lexicon sentiment) into a coarse valence/arousal estimate.
// An external model (e.g. fine-tuned on CMU-MOSEI) can stream estimates
// over a WebSocket; when it is live, it takes priority.
// Valence and arousal are both on [-1, 1].
// =====================================================================

(function () {
  // Circumplex coordinates for face-api's 7 expression classes (Russell, 1980)
  const EXPR_VA = {
    neutral:   [0.0, 0.0],
    happy:     [0.8, 0.5],
    sad:       [-0.7, -0.4],
    angry:     [-0.6, 0.8],
    fearful:   [-0.6, 0.7],
    disgusted: [-0.7, 0.3],
    surprised: [0.2, 0.8],
  };

  // Small sentiment lexicon for live transcripts (valence, arousal)
  const LEXICON = {
    love: [0.9, 0.5], great: [0.8, 0.5], good: [0.6, 0.2], nice: [0.6, 0.1], like: [0.4, 0.1],
    enjoy: [0.7, 0.3], fun: [0.7, 0.5], happy: [0.8, 0.4], glad: [0.6, 0.2], awesome: [0.9, 0.6],
    agree: [0.4, 0.0], interesting: [0.5, 0.3], excited: [0.7, 0.8], relaxed: [0.5, -0.6], calm: [0.4, -0.6],
    easy: [0.4, -0.2], better: [0.4, 0.1], best: [0.7, 0.3], thanks: [0.5, 0.0], thank: [0.5, 0.0],
    bad: [-0.6, 0.2], hate: [-0.9, 0.7], annoying: [-0.7, 0.6], annoyed: [-0.7, 0.6], unfair: [-0.6, 0.6],
    wrong: [-0.5, 0.4], stupid: [-0.8, 0.6], ridiculous: [-0.6, 0.6], angry: [-0.8, 0.8], mad: [-0.7, 0.7],
    frustrating: [-0.7, 0.6], frustrated: [-0.7, 0.6], stress: [-0.6, 0.7], stressed: [-0.6, 0.7],
    nervous: [-0.5, 0.7], anxious: [-0.6, 0.7], worried: [-0.5, 0.5], embarrassed: [-0.6, 0.5],
    sorry: [-0.3, 0.1], sad: [-0.7, -0.4], tired: [-0.4, -0.6], boring: [-0.5, -0.5], bored: [-0.5, -0.5],
    hard: [-0.3, 0.3], difficult: [-0.3, 0.3], no: [-0.2, 0.2], not: [-0.1, 0.0], whatever: [-0.4, -0.2],
  };
  const NEGATORS = new Set(["not", "never", "no", "don't", "dont", "didn't", "isn't", "wasn't", "can't"]);

  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));

  class AffectEngine {
    constructor(cfg, onLog) {
      this.cfg = cfg;
      this.onLog = onLog || (() => {});
      this.face = { v: 0, a: 0, conf: 0, t: 0, expressions: null, box: null };
      this.voice = { v: 0, a: 0, conf: 0, t: 0, rmsDb: null, pitch: null };
      this.text = { v: 0, a: 0, conf: 0, t: 0 };
      this.external = { v: 0, a: 0, conf: 0, t: 0, label: null, connected: false };
      this.fused = { valence: 0, arousal: 0, intensity: 0, label: "neutral", source: "none" };
      this.history = [];          // [{t, valence, arousal}] for trend detection
      this.voiceBaseline = { mean: -45, sd: 6, n: 0, m2: 0 };
      this.calibratingVoice = false;
      this.faceReady = false;
    }

    // ---------------- Face ----------------
    async initFace(videoEl, modelPath) {
      this.video = videoEl;
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(modelPath);
        await faceapi.nets.faceExpressionNet.loadFromUri(modelPath);
        // Lower detector cutoff to keep smaller/lower-contrast webcam faces in view.
        this.faceOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.2 });
        this.faceReady = true;
        this._faceLoop();
        return true;
      } catch (e) {
        console.error("Face model failed to load", e);
        return false;
      }
    }

    stopFace() {
      this.faceReady = false;
      this.video = null;
      this.face.expressions = null;
      this.face.conf = 0;
      this.face.box = null;
    }

    async _faceLoop() {
      if (!this.faceReady) return;
      try {
        if (this.video.readyState >= 2) {
          const r = await faceapi.detectSingleFace(this.video, this.faceOpts).withFaceExpressions();
          if (r) {
            let v = 0, a = 0;
            for (const [k, p] of Object.entries(r.expressions)) {
              const va = EXPR_VA[k];
              if (va) { v += p * va[0]; a += p * va[1]; }
            }
            const box = r.detection.box;
            this.face = {
              v, a, conf: r.detection.score, t: performance.now(), expressions: r.expressions,
              box: { x: box.x, y: box.y, width: box.width, height: box.height, frameWidth: this.video.videoWidth, frameHeight: this.video.videoHeight },
            };
          } else {
            this.face = { ...this.face, conf: 0, t: performance.now(), expressions: null, box: null };
          }
        }
      } catch (e) { /* skip frame */ }
      setTimeout(() => this._faceLoop(), 200);
    }

    // ---------------- Voice ----------------
    initVoice(stream) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an);
        this.audio = { ctx, an, buf: new Float32Array(an.fftSize), pitches: [] };
        this._voiceLoop();
        return true;
      } catch (e) {
        console.error("Audio init failed", e);
        return false;
      }
    }

    startVoiceCalibration() { this.calibratingVoice = true; this.voiceBaseline = { mean: -45, sd: 6, n: 0, m2: 0 }; }
    stopVoiceCalibration() { this.calibratingVoice = false; }

    _voiceLoop() {
      const { an, buf, ctx } = this.audio;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = 20 * Math.log10(rms + 1e-8);
      const speaking = db > this.voiceBaseline.mean + 2 * this.voiceBaseline.sd && db > -55;

      if (this.calibratingVoice || this.voiceBaseline.n < 20) {
        // Welford running mean/sd of ambient level
        const b = this.voiceBaseline;
        b.n++; const d = db - b.mean; b.mean += d / b.n; b.m2 += d * (db - b.mean);
        b.sd = Math.max(3, Math.sqrt(b.m2 / Math.max(1, b.n - 1)));
      }

      if (speaking) {
        const p = autoCorrelatePitch(buf, ctx.sampleRate);
        if (p > 70 && p < 400) {
          this.audio.pitches.push(p);
          if (this.audio.pitches.length > 40) this.audio.pitches.shift();
        }
        const ps = this.audio.pitches;
        const meanP = ps.reduce((x, y) => x + y, 0) / (ps.length || 1);
        const sdP = Math.sqrt(ps.reduce((x, y) => x + (y - meanP) ** 2, 0) / (ps.length || 1));
        // Louder + more pitch variability -> higher arousal. Voice carries little valence.
        const loud = clamp((db - (this.voiceBaseline.mean + 2 * this.voiceBaseline.sd)) / 25, 0, 1);
        const varP = clamp(sdP / 60, 0, 1);
        const a = clamp(-0.4 + 0.9 * loud + 0.6 * varP);
        this.voice = { v: 0, a, conf: 0.6, t: performance.now(), rmsDb: db, pitch: p > 0 ? p : null };
      } else if (performance.now() - this.voice.t > 1500) {
        this.voice.conf = 0;
        this.voice.rmsDb = db;
      }
      setTimeout(() => this._voiceLoop(), 100);
    }

    // ---------------- Language ----------------
    ingestText(text) {
      const words = text.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);
      let v = 0, a = 0, n = 0, neg = false;
      for (const w of words) {
        if (NEGATORS.has(w)) { neg = true; continue; }
        const e = LEXICON[w];
        if (e) { v += neg ? -0.6 * e[0] : e[0]; a += e[1]; n++; }
        neg = false;
      }
      const exclaim = (text.match(/!/g) || []).length;
      if (n > 0 || exclaim) {
        this.text = {
          v: n ? clamp(v / n) : 0,
          a: clamp((n ? a / n : 0) + 0.15 * exclaim),
          conf: Math.min(0.8, 0.3 + 0.15 * n),
          t: performance.now(),
        };
      }
    }

    // ---------------- External model (CMU-MOSEI etc.) ----------------
    connectExternal(url) {
      if (!url) return;
      const attempt = () => {
        let ws;
        try { ws = new WebSocket(url); } catch (e) { return; }
        ws.onopen = () => { this.external.connected = true; this.onLog("external_model_connected", { url }); };
        ws.onclose = () => {
          if (this.external.connected) this.onLog("external_model_disconnected", { url });
          this.external.connected = false;
          setTimeout(attempt, 5000);
        };
        ws.onerror = () => {};
        ws.onmessage = (m) => {
          try {
            const d = JSON.parse(m.data);
            this.external = {
              v: clamp(+d.valence || 0), a: clamp(+d.arousal || 0),
              conf: d.confidence != null ? +d.confidence : 0.9,
              label: d.label || null, t: performance.now(), connected: true,
            };
          } catch (e) {}
        };
        this.ws = ws;
      };
      attempt();
    }

    // Send media-derived features/transcripts to the external model if desired
    sendToExternal(payload) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(payload));
    }

    // ---------------- Fusion ----------------
    update() {
      const now = performance.now();
      const fresh = (ch, maxAge) => (now - ch.t < maxAge ? ch.conf : 0);
      const ext = this.external;
      let v, a, source;

      if (ext.connected && now - ext.t < 2500) {
        v = ext.v; a = ext.a; source = "external";
      } else {
        const W = this.cfg.weights;
        const wf = W.face * fresh(this.face, 1500);
        const wvA = W.voice * fresh(this.voice, 2000);
        const wt = W.text * fresh(this.text, 20000) * Math.max(0, 1 - (now - this.text.t) / 20000);
        const wvV = wf + wt;
        const wA = wf + wvA + wt;
        v = wvV > 0 ? (wf * this.face.v + wt * this.text.v) / wvV : this.fused.valence;
        a = wA > 0 ? (wf * this.face.a + wvA * this.voice.a + wt * this.text.a) / wA : this.fused.arousal;
        source = [wf > 0 && "face", wvA > 0 && "voice", wt > 0 && "text"].filter(Boolean).join("+") || "hold";
      }

      const s = this.cfg.smoothing;
      const valence = s * this.fused.valence + (1 - s) * v;
      const arousal = s * this.fused.arousal + (1 - s) * a;
      const intensity = Math.min(1, Math.hypot(valence, arousal));
      const label = ext.connected && ext.label && source === "external" ? ext.label : labelFor(valence, arousal);
      this.fused = { valence, arousal, intensity, label, source };

      this.history.push({ t: now, valence, arousal });
      while (this.history.length && now - this.history[0].t > 60000) this.history.shift();
      return this.fused;
    }

    // Change over the last `windowMs` (positive = rising)
    trend(windowMs = 20000) {
      const now = performance.now();
      const past = this.history.find((h) => now - h.t <= windowMs);
      if (!past) return { dv: 0, da: 0 };
      return { dv: this.fused.valence - past.valence, da: this.fused.arousal - past.arousal };
    }

    // Natural-language phrase used in the other-mediated echo prompt
    phrase() {
      const f = this.fused;
      const adv = f.intensity > 0.6 ? "quite " : f.intensity > 0.3 ? "a little " : "slightly ";
      let base = adv + f.label;
      if (f.label === "neutral") base = "fairly neutral and even";
      const { dv, da } = this.trend();
      const changes = [];
      if (dv < -0.15) changes.push("more negative");
      if (dv > 0.15) changes.push("more positive");
      if (da > 0.15) changes.push("more activated");
      if (da < -0.15) changes.push("calmer");
      return changes.length ? `${base}, and becoming ${changes.join(" and ")} over the last few seconds` : base;
    }

    snapshot() {
      return {
        valence: +this.fused.valence.toFixed(3),
        arousal: +this.fused.arousal.toFixed(3),
        intensity: +this.fused.intensity.toFixed(3),
        label: this.fused.label,
        source: this.fused.source,
        face_v: +this.face.v.toFixed(3), face_a: +this.face.a.toFixed(3), face_conf: +this.face.conf.toFixed(3),
        voice_a: +this.voice.a.toFixed(3), voice_conf: +this.voice.conf.toFixed(3),
        voice_db: this.voice.rmsDb != null ? +this.voice.rmsDb.toFixed(1) : null,
        pitch_hz: this.voice.pitch ? +this.voice.pitch.toFixed(1) : null,
        text_v: +this.text.v.toFixed(3), text_a: +this.text.a.toFixed(3),
        ext_connected: this.external.connected,
        expressions: this.face.expressions
          ? Object.fromEntries(Object.entries(this.face.expressions).map(([k, p]) => [k, +p.toFixed(3)]))
          : null,
      };
    }
  }

  // Coarse affect labels from the circumplex quadrant
  function labelFor(v, a) {
    const i = Math.hypot(v, a);
    if (i < 0.12) return "neutral";
    if (v < -0.12 && a > 0.12) return i > 0.55 ? "irritated" : "tense";
    if (v < -0.12) return "subdued";
    if (v > 0.12 && a > 0.12) return "upbeat";
    if (v > 0.12) return "warm";
    return a < 0 ? "calm" : "alert";
  }

  // Simple autocorrelation pitch detector
  function autoCorrelatePitch(buf, sampleRate) {
    const SIZE = buf.length;
    let best = -1, bestCorr = 0;
    const minLag = Math.floor(sampleRate / 400), maxLag = Math.floor(sampleRate / 70);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let i = 0; i < SIZE - lag; i += 2) corr += buf[i] * buf[i + lag];
      if (corr > bestCorr) { bestCorr = corr; best = lag; }
    }
    return best > 0 && bestCorr > 0.01 ? sampleRate / best : -1;
  }

  window.AffectEngine = AffectEngine;
  window.affectLabelFor = labelFor;
})();
