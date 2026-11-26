// =====================================================================
// Affective Echoes — project overview interactions
// =====================================================================
(function () {
  document.documentElement.classList.add("js");
  const C = window.STUDY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const labelFor = window.affectLabelFor;
  const clean = (s) => s.replace(/\u2753/g, "?").replace(/\s*[\u{1F300}-\u{1FAFF}☀-➿❓❗]/gu, "").replace(/\s+([.?!])/g, "$1").trim();

  // ---------------- Condition preview ----------------
  const LINE = "Is it better to study alone or in a group?";
  const ECHO = {
    tense: (adv) => `You sound ${adv}tense about this.`,
    irritated: (adv) => `You seem ${adv}bothered by this.`,
    subdued: (adv) => `You seem ${adv}low on this one.`,
    upbeat: (adv) => `You sound ${adv}energized about this.`,
    warm: (adv) => `You seem ${adv}relaxed about it.`,
    calm: (adv) => `You seem ${adv}calm about this.`,
    alert: (adv) => `You seem ${adv}alert to this.`,
  };
  const NOTES = {
    other_mediated: "Alex folds its impression into what it says, and the subtitle window shifts colour. The participant never sees a label or a number.",
    direct: "The participant sees the estimate itself: a label and two readings. Alex's words never mention it.",
    none: "The same conversation. The estimate is still recorded for analysis, but it's never shown.",
  };
  const pv = { v: 0, a: 0, cond: "other_mediated", touched: false };

  function render() {
    const { v, a, cond } = pv;
    const label = labelFor(v, a);
    const intensity = Math.min(1, Math.hypot(v, a));
    const adv = intensity > 0.6 ? "quite " : intensity > 0.3 ? "a little " : "slightly ";
    $("padDot").style.left = `${50 + v * 40}%`;
    $("padDot").style.top = `${50 - a * 40}%`;
    const sgn = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);
    $("padRead").textContent = `pleasant ${sgn(v)}   activated ${sgn(a)}`;
    $("pad").setAttribute("aria-valuetext", `${label}. Pleasantness ${sgn(v)}, activation ${sgn(a)}`);

    const sub = $("pvSub");
    const line = $("pvLine");
    if (cond === "other_mediated") {
      // same mapping the participant app uses
      const hue = v < 0 ? 8 : v > 0 ? 38 : 205;
      sub.style.setProperty("--sub-hue", hue);
      sub.style.setProperty("--sub-sat", (12 + Math.min(1, Math.abs(v)) * 60).toFixed(0) + "%");
      sub.style.setProperty("--sub-light", (97 - Math.abs(v) * 6).toFixed(1) + "%");
      sub.style.setProperty("--sub-border", (0.12 + Math.max(0, a) * 0.7).toFixed(2));
      const echo = label !== "neutral" && ECHO[label] ? ECHO[label](adv) + " " : "";
      line.innerHTML = (echo ? `<span class="echo">${echo}</span>` : "") + LINE;
    } else {
      ["--sub-hue", "--sub-sat", "--sub-light", "--sub-border"].forEach((p) => sub.style.removeProperty(p));
      line.textContent = LINE;
    }
    $("pvDirect").classList.toggle("hidden", cond !== "direct");
    if (cond === "direct") {
      $("pvdLabel").textContent = label;
      const bar = (el, x) => { const w = Math.abs(x) * 50; el.style.left = x >= 0 ? "50%" : 50 - w + "%"; el.style.width = w + "%"; };
      bar($("pvdV"), v); bar($("pvdA"), a);
    }
    $("pvNote").textContent = NOTES[cond];
  }

  const pad = $("pad");
  function setFromPointer(e) {
    const r = pad.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    pv.v = Math.max(-1, Math.min(1, (x - 0.5) / 0.4));
    pv.a = Math.max(-1, Math.min(1, (0.5 - y) / 0.4));
    render();
  }
  pad.addEventListener("pointerdown", (e) => {
    pv.touched = true; pad.setPointerCapture(e.pointerId); pad.classList.add("dragging"); setFromPointer(e);
  });
  pad.addEventListener("pointermove", (e) => { if (pad.hasPointerCapture(e.pointerId)) setFromPointer(e); });
  pad.addEventListener("pointerup", () => pad.classList.remove("dragging"));
  pad.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.25 : 0.1;
    const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!k) return;
    e.preventDefault(); pv.touched = true;
    pv.v = Math.max(-1, Math.min(1, pv.v + k[0]));
    pv.a = Math.max(-1, Math.min(1, pv.a + k[1]));
    render();
  });

  function wireTabs(id, onSelect) {
    const root = $(id);
    const select = (b) => {
      root.querySelectorAll("button").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
      onSelect(b);
    };
    root.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) select(b); });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const tabs = [...root.querySelectorAll("button")];
      const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(n); n.focus();
    });
  }
  wireTabs("pvTabs", (b) => { pv.cond = b.dataset.cond; render(); });

  // One orchestrated moment: the point glides from neutral to "tense" so the change is visible at a glance.
  render();
  if (!reduce) {
    const from = { v: 0, a: 0 }, to = { v: -0.55, a: 0.6 }, dur = 2600;
    let t0 = null;
    const ease = (x) => 1 - Math.pow(1 - x, 4);
    const step = (ts) => {
      if (pv.touched) return;
      t0 = t0 ?? ts;
      const k = ease(Math.min(1, (ts - t0) / dur));
      pv.v = from.v + (to.v - from.v) * k; pv.a = from.a + (to.a - from.a) * k;
      render();
      if (k < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 700);
  } else { pv.v = -0.55; pv.a = 0.6; render(); }

  // ---------------- Strategies ----------------
  const RULES = {
    neutral: "Restates the opinion and asks a factual follow-up. No praise, no criticism, no comfort.",
    anger: "A direct challenge to the participant's argument and its evidence. Never the person, their intelligence or their character.",
    pride: "Specific praise for a reason or a contribution. Never a comparison with other people.",
  };
  const EXAMPLE = { neutral: 1, anger: 1, pride: 1 };
  wireTabs("stratTabs", (b) => {
    const s = b.dataset.s;
    $("stratLine").textContent = clean(C.strategies[s].fallback[EXAMPLE[s]]);
    $("stratRule").textContent = RULES[s];
  });
  $("stratLine").textContent = clean(C.strategies.neutral.fallback[EXAMPLE.neutral]);
  $("stratRule").textContent = RULES.neutral;

  // ---------------- Session flow bar (proportional, from config) ----------------
  const T = C.timing, segs = [["rest", T.restingBaseline], ["practice", T.practice]];
  C.blockStrategies.forEach((_, i) => {
    segs.push(["neutral", T.blockNeutralBaseline], ["cond", T.blockCondition], ["neutral", T.blockNeutralRecovery]);
    if (i < C.blockStrategies.length - 1) segs.push(["break", T.blockBreak]);
  });
  $("flowBar").innerHTML = segs.map(([k, d]) => `<span class="fb-${k}" style="flex:${d} 1 0"></span>`).join("");

  // ---------------- Scroll reveal (each section once) ----------------
  const io = "IntersectionObserver" in window && !reduce ? new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }) : null;
  document.querySelectorAll(".reveal").forEach((el) => (io ? io.observe(el) : el.classList.add("in")));
})();
