// =====================================================================
// Affective Echoes — experiment runner
// =====================================================================
(function () {
  const C = window.STUDY_CONFIG;
  const HOSTED = !!window.AE_HOSTED;          // running as the hosted demo (see hosted.js)
  const H = window.AE_HOST || null;
  const CV = C.conversation;
  const TR = C.transitions;
  const $ = (id) => document.getElementById(id);
  const perf = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = (cond, step = 100) => new Promise((res) => { const f = () => (cond() ? res() : setTimeout(f, step)); f(); });
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}☀-➿❓❗]/gu;

  // ------------------------------------------------------------------
  // Session state
  // ------------------------------------------------------------------
  const S = {
    pid: "", condition: "other_mediated", order: [], engine: "llm", tts: true,
    inputMode: "voice", speed: 1,
    startPerf: 0, startEpoch: 0,
    events: [], affect: [], probes: [], transcript: [],
    phases: [], phaseIdx: -1, phaseElapsed: 0, paused: false, lastTick: 0,
    strategy: "neutral", strategyStimulusDelivered: false, topicIdx: 0, topic: "", turnsOnTopic: 0, topicChangePending: false,
    pendingRoundCompletion: false,
    history: [], busy: false,
    // turn-taking
    lastUserAt: 0, lastCommitAt: 0, userSeq: 0,
    voiceActiveUntil: 0,
    botSpeaking: false, botEndAt: 0, echoGuardUntil: 0, currentBotText: "", ttsChar: 0,
    // probes / transitions
    nextProbeAt: null, probeDueAt: null, probeDeferredReason: null, activeProbe: null, probeCount: 0, chatLocked: false,
    phaseEndPending: false, phaseClosingMode: "none",
    notice: null,
    lastFeedbackLabel: null, feedbackEmotionLabel: "neutral", serverOk: false, serverInfo: null,
    pendingLog: [], ended: false, stream: null,
  };
  let engine = null;            // hosted fallback only
  let emotionToken = null, emotionCtx = null, emotionProcessor = null, audioSource = null;
  let sampleQueue = [], sampleCount = 0, sampleQueueStartMs = null, frameTimer = null, submitBusy = false;
  let windowParticipantAnswer = false, inflightEmotionWindows = 0;
  // A ten-second spoken answer gives the multimodal estimate context for
  // next-turn feedback; an explicit Stop remains available throughout.
  const MIN_EMOTION_FEEDBACK_SAMPLES = (C.affect.minFeedbackSeconds || 10) * 16000;
  let participantAnswerSamples = 0, participantSpeechSamples = 0;
  let answerEmotionWindows = [];
  let faceCueEngine = null, faceCueSampler = null, faceCueHistory = [];
  let latestEmotion = { label: "uncertain", emotion_terms: [], transcript: "", status: "waiting" };
  let lastClearEmotion = null, localListening = false, speechBuffer = "", speechTimer = null;
  const curPhase = () => S.phases[S.phaseIdx];
  const userActive = () => perf() < S.voiceActiveUntil;

  // ------------------------------------------------------------------
  // Logging: every event carries epoch ms (for aligning with EmotiBit/EEG
  // recordings on the same machine) plus session-relative seconds.
  // ------------------------------------------------------------------
  function now() {
    const p = perf();
    return {
      t_epoch_ms: +(S.startEpoch + (p - S.startPerf)).toFixed(2),
      t_session_s: +((p - S.startPerf) / 1000).toFixed(3),
    };
  }
  function phaseInfo() {
    const p = curPhase();
    return p ? { phase: p.id, phase_kind: p.kind, block: p.block ?? null, strategy: S.strategy } : {};
  }
  function log(type, data = {}, opts = {}) {
    const ev = { ...now(), pid: S.pid, condition: S.condition, type, ...phaseInfo(), ...data };
    if (type === "affect_sample") S.affect.push(ev);
    else S.events.push(ev);
    S.pendingLog.push(ev);
    if (opts.immediate || type !== "affect_sample") flushLog();
    $("xEvents").textContent = S.events.length;
    return ev;
  }
  let flushing = false;
  async function flushLog() {
    if (!S.serverOk || flushing || !S.pendingLog.length) return;
    flushing = true;
    const batch = S.pendingLog.splice(0);
    try {
      const r = await fetch("/api/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: S.pid, session_start_epoch_ms: S.startEpoch, events: batch }),
      });
      $("xServer").textContent = r.ok ? "ok" : "error " + r.status;
    } catch (e) {
      S.pendingLog.unshift(...batch);
      $("xServer").textContent = "offline (kept in browser)";
    }
    flushing = false;
  }
  setInterval(flushLog, 2000);

  // ------------------------------------------------------------------
  // Setup screen
  // ------------------------------------------------------------------
  const PERMS = [["anger", "pride"], ["pride", "anger"]];
  function computeOrder() {
    const mode = $("orderMode").value;
    if (mode === "manual") {
      const o = $("manualOrder").value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => C.strategies[s]);
      return o.length ? o : [...C.blockStrategies];
    }
    if (mode === "random") return [...C.blockStrategies].sort(() => Math.random() - 0.5);
    const n = parseInt(($("pid").value.match(/\d+/) || ["0"])[0], 10);
    return PERMS[n % PERMS.length];
  }
  let randomCache = null;
  const SEG_LABEL = { rest: "Rest", practice: "Practice", neutral: "Neutral", break: "Break" };

  // Proportional timeline of the protocol, built from config + current options
  function planPhases(order) {
    const T = C.timing, P = [];
    if (!$("skipResting").checked) P.push({ cls: "rest", dur: T.restingBaseline });
    if (!$("skipPractice").checked) P.push({ cls: "practice", dur: T.practice });
    order.forEach((st, i) => {
      P.push({ cls: "neutral", dur: T.blockNeutralBaseline, block: i + 1 });
      P.push({ cls: st, dur: T.blockCondition, label: C.strategies[st].label });
      P.push({ cls: "neutral", dur: T.blockNeutralRecovery });
      if (i < order.length - 1) P.push({ cls: "break", dur: T.blockBreak });
    });
    return P;
  }
  function refreshOrderPreview() {
    if ($("orderMode").value === "random") { randomCache = randomCache || computeOrder(); }
    else randomCache = null;
    const o = randomCache || computeOrder();
    $("manualOrderField").classList.toggle("hidden", $("orderMode").value !== "manual");

    const P = planPhases(o);
    const total = P.reduce((a, p) => a + p.dur, 0);
    const plan = $("plan");
    plan.innerHTML = "";
    P.forEach((p) => {
      const seg = document.createElement("div");
      seg.className = `seg seg-${p.cls}` + (p.block ? " has-block" : "");
      seg.style.flex = `${p.dur} 1 0`;
      const mins = Math.round(p.dur / 60);
      const name = p.label || SEG_LABEL[p.cls] || p.cls;
      seg.title = `${name}, ${mins} min`;
      seg.innerHTML = (p.block ? `<span class="seg-block-label">Part ${p.block}</span>` : "") + `<span>${p.dur >= 240 ? name : ""}</span>`;
      plan.appendChild(seg);
    });
    $("orderPreview").innerHTML = `<strong>${Math.round(total / 60)} minutes</strong> in the app. Block order: ${o.map((s) => C.strategies[s].label).join(", then ")}.`;
    refreshSummary();
  }
  const checklistBoxes = () => [...document.querySelectorAll("#checklist input[type=checkbox]")];
  function checklistState() {
    return Object.fromEntries(checklistBoxes().map((b) => [b.dataset.key, b.checked]));
  }
  let startArmed = false;   // second click on Start when checklist items are still open
  function refreshSummary() {
    const pid = $("pid").value.trim();
    const cond = $("condition").selectedOptions[0].textContent;
    const open = checklistBoxes().filter((b) => !b.checked && b.dataset.key !== "headphones").length;
    const safePid = pid.replace(/[<>&]/g, "");
    $("setupSummary").innerHTML = !pid
      ? "Enter a participant ID to begin."
      : `Ready to start <strong>${safePid}</strong> in <strong>${cond}</strong>.` +
        (open ? ` <span class="open-items">${open} checklist item${open > 1 ? "s" : ""} still open.</span>` : "") + ' <span id="modelNote"></span>';
    updateModelNote();
    startArmed = false;
    $("btnStart").textContent = "Start session";
  }
  ["pid", "orderMode", "manualOrder", "skipResting", "skipPractice", "condition"].forEach((id) => {
    $(id).addEventListener("input", refreshOrderPreview);
    $(id).addEventListener("change", refreshOrderPreview);
  });
  checklistBoxes().forEach((b) => b.addEventListener("change", refreshSummary));
  refreshOrderPreview();
  $("appVersion").textContent = `Version ${C.version}`;

  // Suggest the next participant: least-run condition, next ID number
  async function loadSuggestion() {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) return;
      const { sessions } = await r.json();
      const real = sessions.filter((x) => !x.demo && x.ended === "completed");
      const counts = { other_mediated: 0, direct: 0, none: 0 };
      real.forEach((x) => { if (x.condition in counts) counts[x.condition]++; });
      const nums = sessions.map((x) => parseInt(((x.pid || "").match(/^P(\d+)$/) || [])[1], 10)).filter((n) => !isNaN(n));
      const nextNum = (nums.length ? Math.max(...nums) : 0) + 1;
      const nextPid = "P" + String(nextNum).padStart(3, "0");
      const order = ["other_mediated", "direct", "none"];
      const nextCond = order.reduce((a, b) => (counts[b] < counts[a] ? b : a), order[0]);
      const label = (c) => C.conditions[c].label;
      $("suggestText").innerHTML = `Suggested next: <strong>${nextPid}</strong> in <strong>${label(nextCond)}</strong>. ` +
        `Completed so far: ${order.map((c) => `${label(c)} ${counts[c]}`).join(", ")}.`;
      $("suggest").classList.remove("hidden");
      $("btnSuggest").onclick = () => {
        $("pid").value = nextPid; $("condition").value = nextCond;
        refreshOrderPreview();
      };
    } catch (e) { /* server not running: no suggestion */ }
  }
  loadSuggestion();

  function setCheck(id, state, detail) {
    const li = $(id);
    li.dataset.state = state;
    li.querySelector(".ck-detail").textContent = detail;
    li.querySelector(".ck-detail").title = detail;
  }

  async function checkServer() {
    try {
      const r = await fetch("/api/health");
      const d = await r.json();
      S.serverOk = true; S.serverInfo = d;
      setCheck("chkServer", "ok", d.hosted ? (d.log_dir ? "Hosted on Claude, sessions saved privately" : "Hosted on Claude, sign in to save sessions") : d.lsl ? "Connected, LSL markers on" : "Connected");
      renderModelCheck(d);
    } catch (e) {
      setCheck("chkServer", "bad", "Not reachable. Start python server.py");
      setCheck("chkModel", "warn", "Unavailable without the server");
    }
  }
  // Built-in model: show loading / download progress and keep polling until it's ready
  let modelPoll = null;
  function fmtGB(b) { return (b / 2 ** 30).toFixed(1) + " GB"; }
  function renderModelCheck(d) {
    const L = d.llm;
    const li = $("chkModel");
    li.querySelector(".ck-action")?.remove();
    clearTimeout(modelPoll);
    if (!L) { setCheck("chkModel", "warn", "None set up, scripted lines will be used"); return; }
    if (d.hosted) { setCheck("chkModel", "ok", "Claude, on your account"); return; }
    if (L.provider !== "built-in") { setCheck("chkModel", "ok", `${L.model} (${L.provider})`); return; }
    const again = (ms) => { modelPoll = setTimeout(checkServer, ms); };
    switch (L.state) {
      case "ready":
        setCheck("chkModel", "ok", `${L.model}, built in, on ${L.backend}`); break;
      case "starting": case "idle":
        setCheck("chkModel", "warn", `${L.model}: loading into memory (usually under a minute)…`); again(1500); break;
      case "downloading": {
        const dl = L.download || {}, pct = dl.total ? Math.floor((dl.done / dl.total) * 100) : 0;
        setCheck("chkModel", "warn", `Downloading ${L.model}: ${pct}% of ${fmtGB(dl.total || 0)}`); again(1000); break;
      }
      case "missing_model": {
        setCheck("chkModel", "bad", L.download && L.download.error ? "Download stopped. Click to resume" : "Model not downloaded yet (2 GB, one time)");
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn btn-quiet btn-sm ck-action";
        b.textContent = L.download && L.download.error ? "Resume download" : "Download model";
        b.onclick = async () => {
          b.disabled = true;
          try { await fetch("/api/model/download", { method: "POST" }); } catch (e) {}
          checkServer();
        };
        li.appendChild(b);
        break;
      }
      case "missing_engine":
        setCheck("chkModel", "bad", "Engine files missing. Use the Windows release zip"); break;
      default:
        setCheck("chkModel", "bad", L.detail || "The built-in model couldn't start"); again(5000);
    }
    $("chkModel").querySelector(".ck-detail").title = L.detail || "";
    updateModelNote();
  }
  function updateModelNote() {
    const n = document.getElementById("modelNote"); if (!n) return;
    const L = S.serverInfo && S.serverInfo.llm;
    const show = L && L.provider === "built-in" && L.state !== "ready" && $("engine").value !== "scripted";
    n.className = show ? "open-items" : "";
    n.textContent = show ? "Alex's AI isn't ready yet, so replies use scripted lines until it is." : "";
  }

  checkServer();
  if (HOSTED) {
    setCheck("chkFace", "warn", "Not used in the hosted demo");
    setCheck("chkCamera", "warn", "Not available in the hosted demo");
    H.ready.then(() => {
      setCheck("chkSpeech", H.dict ? "ok" : "bad", H.dict ? "Spoken replies available" : "Voice input unavailable; session cannot start");
      setCheck("chkMic", H.dict ? "ok" : "bad", H.dict ? "Push-to-talk ready" : "Voice input unavailable");
    });
  } else {
    setCheck("chkSpeech", "pending", "Waiting for local Whisper…");
    setCheck("chkFace", "pending", "Loading Light-MER…");
    let emotionHealthTimer = null, emotionHealthBusy = false;
    const checkEmotionHealth = async () => {
      if (emotionHealthBusy) return;
      emotionHealthBusy = true;
      try {
        const r = await fetch("/api/emotion/health", { cache: "no-store" });
        const d = await r.json();
        const ready = r.ok && d.status === "ready" && d.models && d.models.joint === "lightmer_stage2";
        setCheck("chkSpeech", ready ? "ok" : "pending", ready ? "Local Whisper ready" : "Waiting for local Whisper…");
        setCheck("chkFace", ready ? "ok" : "pending", ready ? "Light-MER Stage 2 ready" : "Loading Light-MER…");
        if (ready && emotionHealthTimer) { clearInterval(emotionHealthTimer); emotionHealthTimer = null; }
      } catch (_) {
        setCheck("chkSpeech", "pending", "Waiting for local emotion service…");
        setCheck("chkFace", "pending", "Start the Mac launcher if this continues");
      } finally { emotionHealthBusy = false; }
    };
    checkEmotionHealth();
    emotionHealthTimer = setInterval(checkEmotionHealth, 3000);
  }

  // Live microphone level on the setup screen
  let meterCtx = null, meterRaf = null;
  function startMeter(stream) {
    try {
      meterCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = meterCtx.createAnalyser(); an.fftSize = 1024;
      meterCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-8);
        const lvl = Math.max(0, Math.min(1, (db + 60) / 50));
        $("micMeter").style.width = (lvl * 100).toFixed(0) + "%";
        $("micMeterWrap").setAttribute("aria-valuenow", Math.round(lvl * 100));
        if (lvl > 0.25 && lvl > peak) { peak = lvl; setCheck("chkMic", "ok", "Picking up sound"); }
        meterRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* meter is optional */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRaf);
    if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  }

  $("btnTestDevices").onclick = async () => {
    if (HOSTED) {
      await H.ready;
      toast(H.dict ? "Speech input works by push-to-talk: press the microphone during the conversation, speak, then press it again."
                   : "Spoken input is unavailable here. Use a supported browser before starting; typing is disabled.");
      return;
    }
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true },
      });
      const v = $("previewVideo"); v.srcObject = st;
      document.querySelector(".preview-box").classList.add("live");
      S.stream = st;
      const vt = st.getVideoTracks()[0], s = vt && vt.getSettings();
      setCheck("chkCamera", vt ? "ok" : "bad", vt ? `Working, ${s.width || "?"}×${s.height || "?"}` : "No camera found");
      setCheck("chkMic", st.getAudioTracks().length ? "warn" : "bad", st.getAudioTracks().length ? "Connected. Say something to test" : "No microphone found");
      stopMeter(); startMeter(st);
      $("btnTestDevices").lastChild.textContent = "Test again";
    } catch (e) {
      setCheck("chkCamera", "bad", "Blocked or unavailable");
      setCheck("chkMic", "bad", "Blocked or unavailable");
      toast("Chrome couldn't open the camera or microphone. Allow access in the address bar, then try again.");
    }
  };

  $("btnStart").onclick = async () => {
    if (HOSTED) await H.ready;
    const speechAvailable = HOSTED ? !!(H && H.dict) : await localEmotionReady();
    if (!speechAvailable) {
      toast("The local Light-MER and Whisper service must be ready before this voice-only session can start.");
      return;
    }
    S.pid = $("pid").value.trim();
    if (!S.pid) { toast("Enter a participant ID to start the session."); $("pid").focus(); return; }
    const open = checklistBoxes().filter((b) => !b.checked && b.dataset.key !== "headphones");
    if (open.length && !startArmed) {
      startArmed = true;
      $("btnStart").textContent = "Start anyway";
      toast(`Not checked yet: ${open.map((b) => b.parentElement.querySelector("strong").textContent.toLowerCase()).join(", ")}. Click Start anyway to continue.`);
      return;
    }
    S.condition = $("condition").value;
    S.order = randomCache || computeOrder();
    S.engine = $("engine").value;
    S.tts = $("tts").value === "on";
    S.inputMode = "voice";
    S.speed = parseFloat($("speed").value);

    $("btnStart").disabled = true; $("btnStart").textContent = HOSTED ? "Starting…" : "Loading models…";
    if (HOSTED) H.requestUpfront();           // one consent dialog for Claude replies + voice
    if (!HOSTED) try {
      S.stream = S.stream || await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      toast("The session needs the camera and microphone. Allow access in the address bar, then start again.");
      $("btnStart").disabled = false; $("btnStart").textContent = "Start session"; return;
    }
    stopMeter();
    $("previewVideo").srcObject = null;
    if (S.stream) $("selfVideo").srcObject = S.stream;

    S.startPerf = perf(); S.startEpoch = Date.now();
    if (!HOSTED) {
      await startClientFaceCueDetector();
      try {
        const sr = await fetch("/api/emotion/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const sd = await sr.json();
        if (!sr.ok || !sd.token) throw new Error(sd.error || "session setup failed");
        emotionToken = sd.token; startLocalEmotionCapture();
      } catch (e) {
        toast("Could not start the local emotion detector. Check that Light-MER is running, then restart the session.");
        $("btnStart").disabled = false; $("btnStart").textContent = "Start session"; return;
      }
    }

    log("session_start", {
      order: S.order.join(">"), engine: S.engine, tts: S.tts, input_mode: S.inputMode, speed: S.speed,
      face_model: HOSTED ? "hosted" : "yunet_lightmer + local_face_api_sensitive", voice_features: !HOSTED, emotion_model: HOSTED ? "hosted" : "lightmer_stage2", asr_model: HOSTED ? "hosted dictation" : "local whisper small.en", user_agent: navigator.userAgent,
      llm: S.serverInfo && S.serverInfo.llm ? `${S.serverInfo.llm.provider}/${S.serverInfo.llm.model}` : null,
      start_epoch_ms: S.startEpoch, config_timing: C.timing, config_probes: C.probes, config_affect: C.affect,
      checklist: checklistState(), demo: HOSTED, hosted: HOSTED, app_version: C.version,
      config_conversation: CV, config_transitions: { noticeLeadSec: TR.noticeLeadSec, quietTailSec: TR.quietTailSec },
    });

    buildPhases();
    buildProgress();
    setupConditionUI();
    $("xPid").textContent = S.pid;
    $("xCond").textContent = C.conditions[S.condition].label;
    showScreen("screen-instructions");
  };

  window.addEventListener("beforeunload", (e) => {
    if (S.startPerf && !S.ended) { flushLog(); e.preventDefault(); e.returnValue = ""; }
  });

  $("btnBegin").onclick = () => { log("instructions_acknowledged"); nextPhase(); requestAnimationFrame(tick); };

  // ------------------------------------------------------------------
  // Protocol
  // ------------------------------------------------------------------
  function buildPhases() {
    const T = C.timing, P = [];
    if (!$("skipResting").checked) P.push({ id: "resting_baseline", kind: "rest", dur: T.restingBaseline, strategy: null });
    if (!$("skipPractice").checked) P.push({ id: "practice", kind: "chat", dur: T.practice, strategy: "neutral", label: "Practice conversation" });
    S.order.forEach((st, i) => {
      const b = i + 1;
      P.push({ id: `b${b}_neutral_baseline`, kind: "chat", dur: T.blockNeutralBaseline, strategy: "neutral", block: b, label: `Part ${b} of ${S.order.length}` });
      P.push({ id: `b${b}_condition_${st}`, kind: "chat", dur: T.blockCondition, strategy: st, block: b, label: `Part ${b} of ${S.order.length}`, isCondition: true });
      P.push({ id: `b${b}_neutral_recovery`, kind: "chat", dur: T.blockNeutralRecovery, strategy: "neutral", block: b, label: `Part ${b} of ${S.order.length}` });
      if (i < S.order.length - 1) P.push({ id: `b${b}_break`, kind: "break", dur: T.blockBreak, strategy: null, block: b });
    });
    S.phases = P;
  }

  // Participant-facing progress bar: one segment per phase, sized by duration.
  // No strategy names, so the bar never reveals the manipulation.
  function buildProgress() {
    const bar = $("sessionProgress");
    bar.innerHTML = "";
    S.phases.forEach((p) => {
      const seg = document.createElement("div");
      seg.className = "pseg" + (p.kind === "break" ? " is-break" : "");
      seg.style.flex = `${p.dur} 1 0`;
      seg.appendChild(document.createElement("b"));
      bar.appendChild(seg);
    });
    S.progressTotal = S.phases.reduce((a, p) => a + p.dur, 0);
  }
  function updateProgress() {
    const segs = $("sessionProgress").children;
    let done = 0;
    for (let i = 0; i < segs.length; i++) {
      const p = S.phases[i];
      const f = i < S.phaseIdx ? 1 : i === S.phaseIdx ? Math.min(1, S.phaseElapsed / p.dur) : 0;
      segs[i].firstChild.style.width = (f * 100).toFixed(2) + "%";
      done += f * p.dur;
    }
    $("sessionProgress").setAttribute("aria-valuenow", Math.round((done / S.progressTotal) * 100));
  }

  function nextPhase() {
    const prev = curPhase();
    if (prev) {
      if (prev.kind === "chat") flushUtterance("phase_end");
      log("phase_end", { elapsed_s: +S.phaseElapsed.toFixed(2) });
    }
    clearProbe("phase_end");
    hideNotice();
    S.phaseIdx++;
    S.phaseElapsed = 0;
    S.phaseEndPending = false;
    S.phaseClosingMode = "none";
    S.probeDueAt = null;
    S.probeDeferredReason = null;
    if (S.phaseIdx >= S.phases.length) { endSession("completed"); return; }
    const p = curPhase();
    const previousStrategy = S.strategy;
    S.strategy = p.strategy || "none";
    S.strategyStimulusDelivered = false;
    if (S.strategy !== previousStrategy) {
      const rawLabel = lastClearEmotion?.raw_label;
      S.feedbackEmotionLabel = rawLabel || "neutral";
    }
    log("strategy_condition_started", { previous_strategy: previousStrategy, strategy: S.strategy, condition_target: ["anger", "pride"].includes(S.strategy) ? S.strategy : null, strategy_stimulus_delivered: false, retained_raw_label: lastClearEmotion?.raw_label || null });
    log("phase_start", { duration_s: p.dur, scaled_duration_s: +(p.dur / S.speed).toFixed(2) });
    $("xPhase").textContent = p.id;
    $("xStrat").textContent = S.strategy;

    if (p.kind === "rest") {
      S.nextProbeAt = null;
      showScreen("screen-rest");
      setListening(false);
    } else if (p.kind === "break") {
      S.nextProbeAt = null;
      setListening(false);
      stopSpeaking("phase_change");
      $("breakNext").classList.remove("show");
      $("breakNext").textContent = "";
      showScreen("screen-break");
    } else {
      showScreen("screen-chat");
      $("phaseTag").textContent = p.label || "Conversation";
      S.nextProbeAt = (p.isCondition || !C.probes.onlyDuringCondition) ? randProbeDelay() : null;
      setListening(HOSTED && S.inputMode === "voice");
      if (!S.topic) newTopic(true, "session_start");
      else if (S.topicChangePending) newTopic(false, "minimum_rounds_complete");
      else log("topic_continued", { topic: S.topic, completed_rounds: S.turnsOnTopic, phase_transition: true });
    }
  }
  function randProbeDelay() { return C.probes.minIntervalSec + Math.random() * (C.probes.maxIntervalSec - C.probes.minIntervalSec); }

  function tick(ts) {
    if (S.ended) return;
    const dt = S.lastTick ? (ts - S.lastTick) / 1000 : 0;
    S.lastTick = ts;
    const p = curPhase();
    if (p && !S.paused) {
      S.phaseElapsed += dt * S.speed;
      const left = Math.max(0, p.dur - S.phaseElapsed);
      const txt = fmt(left);
      if (p.kind === "rest") $("restTimer").textContent = txt;
      else if (p.kind === "break") {
        $("breakTimer").textContent = txt;
        if (left <= TR.resumeNoticeSec && !$("breakNext").classList.contains("show")) {
          $("breakNext").textContent = "The next conversation will begin in a few seconds.";
          $("breakNext").classList.add("show");
          log("resume_notice_shown");
        }
      } else {
        $("phaseTimer").textContent = txt;
        updateNotice(left);
        tickProbe(left);
      }
      $("xProbe").textContent = S.activeProbe ? "Open now" : S.nextProbeAt != null ? `in ${fmt(Math.max(0, S.nextProbeAt - S.phaseElapsed))}` : "None this phase";
      if (p.kind === "chat") updateProgress();
      if (S.phaseElapsed >= p.dur) {
        if (!S.phaseEndPending) {
          S.phaseEndPending = true;
          // Finish a participant turn already underway. If Alex just asked a
          // question, leave the mic available for one answer and its response.
          if (userActive() || S.activeProbe || submitBusy || inflightEmotionWindows > 0 || S.busy) {
            S.phaseClosingMode = "finish_turn";
          } else if (S.botSpeaking) {
            S.phaseClosingMode = "allow_answer";
          } else {
            nextPhase();
          }
        }
        if (S.phaseClosingMode === "finish_turn" && !S.busy &&
            !S.botSpeaking && !userActive() && !S.activeProbe && !submitBusy && inflightEmotionWindows === 0) {
          nextPhase();
        }
      }
    }
    updateBotStatus();
    requestAnimationFrame(tick);
  }
  function fmt(s) { s = Math.ceil(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

  // ------------------------------------------------------------------
  // Transition notices (before breaks and before the session ends)
  // ------------------------------------------------------------------
  function upcomingTransition() {
    const p = curPhase();
    if (!p || p.kind !== "chat") return null;
    const n = S.phases[S.phaseIdx + 1];
    if (!n) return "end";
    return n.kind === "break" ? "break" : null;
  }
  function phaseLeft() { const p = curPhase(); return p ? p.dur - S.phaseElapsed : Infinity; }
  function inNoticeWindow() { return !!upcomingTransition() && phaseLeft() <= TR.noticeLeadSec; }
  function inQuietTail() { return !!upcomingTransition() && phaseLeft() <= TR.quietTailSec; }

  function updateNotice(left) {
    const kind = upcomingTransition();
    if (!kind || left > TR.noticeLeadSec) return;
    if (!S.notice) showNotice(kind);
    $("noticeBar").style.width = Math.max(0, (left / TR.noticeLeadSec) * 100).toFixed(1) + "%";
  }
  function showNotice(kind) {
    S.notice = kind;
    const el = $("notice");
    el.setAttribute("aria-hidden", "false");
    el.classList.add("show");
    const text = (kind === "break" ? TR.breakNotice : TR.endNotice).replace("{SEC}", TR.noticeLeadSec);
    requestAnimationFrame(() => { $("noticeText").textContent = text; });   // after un-hiding, so screen readers announce it
    log("transition_notice_shown", { notice: kind, lead_s: TR.noticeLeadSec });
  }
  function hideNotice() {
    if (!S.notice) return;
    S.notice = null;
    $("notice").classList.remove("show");
    $("notice").setAttribute("aria-hidden", "true");
    $("noticeText").textContent = "";
  }

  // ------------------------------------------------------------------
  // Conversation
  // ------------------------------------------------------------------
  function newTopic(isFirst, reason = "minimum_rounds_complete") {
    const previousTopic = S.topic || null;
    const completedRounds = S.turnsOnTopic;
    const minimumRounds = Math.max(1, CV.minTurnsPerTopic || 4);
    if (!isFirst && previousTopic && completedRounds < minimumRounds) {
      log("topic_change_blocked_incomplete", { topic: previousTopic, completed_rounds: completedRounds, minimum_rounds: minimumRounds, reason });
      return false;
    }
    S.topic = C.topics[S.topicIdx % C.topics.length];
    S.topicIdx++;
    S.turnsOnTopic = 0;
    S.topicChangePending = false;
    S.pendingRoundCompletion = false;
    S.lastUserAt = perf();
    const text = isFirst
      ? `Hi, I'm Alex! Let's start with an easy one: ${S.topic}`
      : `Next topic: ${S.topic}`;
    log("topic_start", { topic: S.topic, previous_topic: previousTopic, completed_rounds_on_previous: completedRounds, reason });
    botSay(text, { kind: "opener", engine_used: "fixed" });
    return true;
  }

  function closeTopicReply(text, closingFallback) {
    // Keep the model's response to the participant, remove any last-turn
    // follow-up question, and add a clear close before the next topic opens.
    const statements = String(text || "").match(/[^.!?]+[.!?]*/g) || [];
    const answer = statements.filter((part) => !part.includes("?")).join(" ").trim();
    if (!answer) return closingFallback || "Thanks for sharing your view. Let's leave this topic here.";
    const cleanAnswer = answer.replace(/[.!?…]+\s*$/, "").trim();
    return `${cleanAnswer}. ${closingFallback || "Let's leave this topic here."}`;
  }

  function recordUser(text, extra = {}) {
    if (S.phaseClosingMode === "allow_answer") S.phaseClosingMode = "finish_turn";
    S.lastUserAt = perf();
    addMsg("user", text);
    S.history.push({ role: "user", content: text });
    S.transcript.push({ ...now(), ...phaseInfo(), speaker: "participant", text });
    S.userSeq++;
    log("user_message", { text, affect: getAffectSnapshot(), ...extra });
  }

  function handleUser(text, source) {
    text = (text || "").trim();
    if (!text || S.ended) return;
    const p = curPhase();
    if (!p || p.kind !== "chat") return;
    if (S.activeProbe) { log("input_blocked_checkin", { text, input: source }); return; }
    recordUser(text, { input: source });
    S.lastCommitAt = perf();
    respond();
  }

  // Generate a reply, then hold it until it's polite to speak:
  // the participant isn't speaking, no check-in is open, a short pause
  // has passed, and we're not in the last few seconds before a break.
  async function respond() {
    if (S.busy) return;                  // the running loop notices new input via userSeq
    S.busy = true;
    const phaseIdx = S.phaseIdx;
    let regen = 0;
    try {
      while (true) {
        const seq = S.userSeq;
        // Keep one topic active through the whole conversation phase. Never
        // change topics instead of responding to something the participant said.
        const reply = await generateReply();
        const heldFrom = perf();
        await waitUntil(() => S.ended || S.phaseIdx !== phaseIdx ||
          (!userActive() && !S.activeProbe && !S.botSpeaking && (!inQuietTail() || S.phaseEndPending) &&
           perf() - S.lastCommitAt >= CV.minReplyDelayMs));
        if (S.ended || S.phaseIdx !== phaseIdx) {
          if (reply) log("reply_discarded", { reason: S.ended ? "session_end" : "phase_changed", text: reply.text });
          return;
        }
        if (S.userSeq !== seq && regen < 2) {     // participant added more while we were preparing
          regen++;
          if (reply) log("reply_discarded", { reason: "new_participant_input", text: reply.text });
          continue;
        }
        S.pendingRoundCompletion = true;
        botSay(reply.text, { ...reply.meta, held_ms: Math.round(perf() - heldFrom), regenerations: regen });
        return;
      }
    } finally { S.busy = false; }
  }

  async function generateReply() {
    const strat = C.strategies[S.strategy] || C.strategies.neutral;
    const snapshot = getAffectSnapshot();
    const stratPrompt = strat.prompt;
    const minRounds = Math.max(1, CV.minTurnsPerTopic || 4);
    const topicRound = Math.min(S.turnsOnTopic + 1, minRounds);
    const finalRoundRule = topicRound >= minRounds
      ? "This is the final reply for this topic. Respond specifically to the participant's latest answer, do not ask any question, and end with a brief statement that closes this topic."
      : "Respond specifically to the latest answer and ask one natural follow-up question about this same topic.";
    const system = `${C.sharedRules}\n\n${stratPrompt}\n\nConversation lock: Continue the current topic; this is reply round ${topicRound} of at least ${minRounds}. A topic change happens only after the participant has answered and you have completed your reply. ${finalRoundRule} Do not introduce or ask about another subject.\n\nCurrent topic: "${S.topic}"`;
    const t0 = perf();
    const meta = { kind: "reply", strategy_used: S.strategy, affect_at_generation: snapshot };
    if (S.engine === "llm" && S.serverOk && S.serverInfo && S.serverInfo.llm) {
      try {
        const msgs = trimHistory(S.history.slice(-C.llm.historyTurns * 2));
        const r = await fetch("/api/chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system, messages: msgs, max_tokens: C.llm.maxTokens, temperature: C.llm.temperature }),
        });
        const d = await r.json();
        if (!r.ok || !d.text) throw new Error(d.error || "empty reply");
        const text = topicRound >= minRounds ? closeTopicReply(d.text.trim(), strat.closingFallback) : d.text.trim();
        return { text, meta: { ...meta, engine_used: "llm", latency_ms: Math.round(perf() - t0), system_prompt: system } };
      } catch (e) {
        log("llm_error", { error: String(e.message || e) });
      }
    }
    const bank = strat.fallback;
    let text;
    if (topicRound >= minRounds) text = strat.closingFallback || "Thanks for sharing your view. Let's leave this topic here.";
    else {
      // Keep scripted replies aligned with the same retry progression as the
      // model prompt, regardless of how many topics this strategy has seen.
      const fallbackRound = Math.min(topicRound - 1, bank.length - 1);
      text = bank[Math.max(0, fallbackRound)];
    }
    return { text, meta: { ...meta, engine_used: "scripted", latency_ms: Math.round(perf() - t0) } };
  }

  // Messages must alternate and start with a user turn for most APIs
  function trimHistory(h) {
    const out = [];
    for (const m of h) {
      if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + m.content;
      else out.push({ ...m });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  function emotionStyledCaption(text, emotion) {
    const label = String(emotion || "neutral").toLowerCase().split(/[, +]/)[0].trim();
    const aliases = { joy: "happiness", happy: "happiness", amused: "happiness", amusement: "happiness", frustrated: "anger", frustration: "anger", angry: "anger", annoyed: "anger", annoyance: "anger", disapproval: "anger", anxious: "fear", anxiety: "fear", nervousness: "fear", sad: "sadness", disappointment: "sadness", proud: "pride", admiration: "pride", interested: "interest", curious: "interest", curiosity: "interest" };
    const mood = aliases[label] || label;
    const base = String(text || "").trim();
    const lowerFirst = (s) => s ? s[0].toLowerCase() + s.slice(1) : s;
    const emphatic = (s) => s.replace(/[.!?]+\s*$/, "!");
    if (mood === "happiness") return `${/^wow\b/i.test(base) ? emphatic(base) : `Wow, ${emphatic(lowerFirst(base))}`} 😄😄`;
    if (mood === "interest") return `${/^(ooh|oh)\b/i.test(base) ? base : `Ooh, ${lowerFirst(base)}`} 🤔`;
    if (mood === "pride") return `${/^nice\b/i.test(base) ? emphatic(base) : `Nice! ${lowerFirst(base)}`} ✨`;
    if (mood === "anger") return `${/^oh\b/i.test(base) ? base : `Oh—${lowerFirst(base)}`} 😤`;
    if (mood === "shame") return `${/^well\b/i.test(base) ? base : `Well… ${lowerFirst(base)}`} 😳`;
    if (mood === "sadness") return `${base.replace(/[.!?]+\s*$/, "…")} 😔`;
    if (mood === "fear") return `${/^oh\b/i.test(base) ? base : `Oh… ${lowerFirst(base)}`} 😟`;
    if (mood === "disgust") return `${/^oof\b/i.test(base) ? base : `Oof… ${lowerFirst(base)}`} 😣`;
    if (mood === "surprise") return `${/^whoa\b/i.test(base) ? emphatic(base) : `Whoa! ${lowerFirst(base)}`} 😮`;
    return base;
  }

  function botSay(text, meta = {}) {
    const strategyStimulus = ["anger", "pride"].includes(S.strategy)
      && meta.kind === "reply" && meta.strategy_used === S.strategy && meta.line !== "standard_question";
    if (!HOSTED) setListening(false);
    setMicTurn(false);
    setAiEmotion(S.condition === "other_mediated" ? S.feedbackEmotionLabel : "neutral", true);
    if (S.condition === "other_mediated" && S.feedbackEmotionLabel !== "neutral") renderSubtitleTint(S.feedbackEmotionLabel);
    else clearSubtitleTint();
    const caption = S.condition === "other_mediated"
      ? emotionStyledCaption(text, S.feedbackEmotionLabel)
      : text;
    S.history.push({ role: "assistant", content: text });
    S.transcript.push({ ...now(), ...phaseInfo(), speaker: "bot", text, subtitle_text: caption });
    addMsg("bot", caption);
    $("subtitleText").textContent = caption;
    log("bot_message", { text, subtitle_text: caption, subtitle_emotion: S.condition === "other_mediated" ? S.feedbackEmotionLabel : null, strategy_stimulus: strategyStimulus, ...meta });
    speak(text, strategyStimulus);
  }

  function markStrategyStimulusDelivered(how) {
    if (S.strategyStimulusDelivered || !["anger", "pride"].includes(S.strategy)) return;
    S.strategyStimulusDelivered = true;
    log("strategy_stimulus_delivered", { strategy: S.strategy, delivery: how, source: "completed_ai_reply" });
  }

  // ---------------- TTS ----------------
  let voice = null, ttsId = 0, ttsSafety = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /en-US/i.test(v.lang) && /Google|Samantha|Aria|Jenny|Natural/i.test(v.name))
         || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function speak(text, strategyStimulus = false) {
    const tile = $("botTile");
    if (S.botSpeaking) stopSpeaking("replaced");
    S.currentBotText = text;
    $("voiceOnlyHint").textContent = "Wait for Alex to finish speaking. Then press the microphone, answer aloud, and press it again when you finish.";
    const clean = text.replace(EMOJI_RE, "").trim();
    if (S.tts && HOSTED && H.tts) { speakHosted(text, clean, tile, strategyStimulus); return; }
    if (!S.tts || !window.speechSynthesis) {
      // Subtitles only: treat the reading time as Alex's turn
      const readingMs = Math.min(12000, 1000 + clean.length * 75);
      S.botEndAt = perf() + readingMs;
      S.botSpeaking = true;
      tile.classList.add("talking");
      setTimeout(() => { tile.classList.remove("talking"); S.botSpeaking = false; if (strategyStimulus) markStrategyStimulusDelivered("subtitle_reading_complete"); setAiEmotion("neutral", false); setMicTurn(true, true); }, readingMs);
      return;
    }
    speechSynthesis.cancel();
    const id = ++ttsId;
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) u.voice = voice;
    u.rate = CV.ttsRate;
    S.ttsChar = 0;
    S.botSpeaking = true;
    tile.classList.add("talking");
    if (!CV.bargeIn) pauseRecog(true, "tts");
    const done = (how) => {
      if (id !== ttsId || !S.botSpeaking) return;          // stale callback
      S.botSpeaking = false;
      if (strategyStimulus && ["completed", "timeout"].includes(how)) markStrategyStimulusDelivered(how);
      S.botEndAt = perf();
      S.echoGuardUntil = perf() + CV.echoGuardMs;
      tile.classList.remove("talking");
      setAiEmotion("neutral", false);
      clearTimeout(ttsSafety);
      pauseRecog(false, "tts");
      setMicTurn(true, ["completed", "timeout"].includes(how));
      log("tts_end", { how });
    };
    u.onstart = () => { if (id === ttsId) log("tts_start"); };
    u.onboundary = (e) => { if (id === ttsId) S.ttsChar = e.charIndex; };
    u.onend = () => done("completed");
    u.onerror = (e) => done(e.error === "interrupted" || e.error === "canceled" ? "canceled" : "error");
    clearTimeout(ttsSafety);
    ttsSafety = setTimeout(() => done("timeout"), 5000 + (clean.length * 110) / CV.ttsRate);
    speechSynthesis.speak(u);
  }

  // Hosted demo: Alex speaks with Claude's voice through the `tts` capability
  function speakHosted(text, clean, tile, strategyStimulus = false) {
    const id = ++ttsId;
    S.ttsChar = 0;
    S.botSpeaking = true;
    tile.classList.add("talking");
    const done = (how) => {
      if (id !== ttsId || !S.botSpeaking) return;
      S.botSpeaking = false; S.botEndAt = perf();
      if (strategyStimulus && ["completed", "timeout"].includes(how)) markStrategyStimulusDelivered(how);
      tile.classList.remove("talking"); setAiEmotion("neutral", false); clearTimeout(ttsSafety);
      setMicTurn(true, how === "completed" || how === "timeout");
      log("tts_end", { how });
    };
    log("tts_start");
    H.tts.speak(clean.slice(0, 1900), { rate: CV.ttsRate }).then(() => done("completed"), (e) => done((e && e.code) || "error"));
    clearTimeout(ttsSafety);
    ttsSafety = setTimeout(() => done("timeout"), 8000 + (clean.length * 110) / CV.ttsRate);
  }

  function stopSpeaking(reason) {
    if (!S.botSpeaking) return;
    ttsId++;                                                  // make pending callbacks stale
    clearTimeout(ttsSafety);
    if (HOSTED && H.tts) { try { H.tts.stop(); } catch (e) {} }
    window.speechSynthesis && speechSynthesis.cancel();
    S.botSpeaking = false;
    // A barge-in or pause means the pending AI reply did not finish, so it is
    // not a completed conversation round and cannot trigger a topic change.
    S.pendingRoundCompletion = false;
    S.botEndAt = perf();
    S.echoGuardUntil = reason === "barge_in" ? 0 : perf() + CV.echoGuardMs;
    $("botTile").classList.remove("talking");
    setAiEmotion("neutral", false);
    setMicTurn(true);
    pauseRecog(false, "tts");
    log("tts_end", { how: reason, spoken_chars: S.ttsChar, text_chars: S.currentBotText.length });
  }

  // ---------------- STT ----------------
  let recogWanted = false;
  const recogPauses = new Set();
  let utterBuf = "", interimBuf = "", utterTimer = null, committedInterim = "";

  function setListening(on) {
    if (on) setAiEmotion("neutral", false);
    if (HOSTED) {                       // push-to-talk only: never listens on its own
      $("micBtn").classList.toggle("on", on && !!(H && H.dict));
      if (!on) stopDictation(false);
      return;
    }
    recogWanted = !!on; localListening = !!on;
    $("micBtn").classList.toggle("on", recogWanted);
    $("micBtn").title = recogWanted ? "Finish your spoken answer" : "Start your spoken answer";
    $("micBtn").setAttribute("aria-label", recogWanted ? "Finish your spoken answer" : "Start your spoken answer");
    $("voiceOnlyHint").textContent = recogWanted
      ? `Listening. Please speak for at least ${C.affect.minFeedbackSeconds || 10} seconds before finishing. You can stop the session at any time.`
      : "Alex will ask a question. Press the microphone to answer, then press it again when you finish.";
    if (recogWanted) {
      sampleQueue = []; sampleCount = 0; sampleQueueStartMs = null; windowParticipantAnswer = false;
      participantAnswerSamples = 0; participantSpeechSamples = 0;
      answerEmotionWindows = [];
      faceCueHistory = [];
      S.voiceActiveUntil = perf() + 3600e3;
      $("liveTranscript").textContent = "";
    } else {
      S.voiceActiveUntil = 0;
      $("micBtn").classList.remove("hearing");
    }
  }
  function pauseRecog(on, reason) {
    if (on) recogPauses.add(reason); else recogPauses.delete(reason);
  }
  function setMicTurn(canAnswer, completedBotTurn = false) {
    const phaseAvailable = !S.chatLocked && !S.ended && curPhase()?.kind === "chat";
    if (completedBotTurn && S.pendingRoundCompletion) {
      S.pendingRoundCompletion = false;
      S.turnsOnTopic++;
      S.topicChangePending = S.turnsOnTopic >= Math.max(1, CV.minTurnsPerTopic || 4);
      log("participant_ai_round_completed", { topic: S.topic, completed_rounds: S.turnsOnTopic, topic_change_pending: S.topicChangePending });
      if (S.topicChangePending && phaseAvailable && !S.phaseEndPending) {
        log("topic_advance_after_completed_rounds", { topic: S.topic, completed_rounds: S.turnsOnTopic });
        newTopic(false);
        return;
      }
    }
    if (S.topicChangePending && S.phaseEndPending && S.phaseClosingMode === "allow_answer") {
      // The phase-ending reply completed the required final round. Close this
      // phase now; the next topic opens at the start of the next chat phase.
      S.phaseClosingMode = "finish_turn";
    }
    const ready = canAnswer && phaseAvailable && !(S.topicChangePending && S.phaseEndPending);
    $("micBtn").disabled = !ready;
    $("voiceOnlyHint").textContent = ready
      ? `Alex has finished. Answer aloud for at least ${C.affect.minFeedbackSeconds || 10} seconds, then press the microphone again. You can stop the session at any time.`
      : "Alex is speaking. Please wait; the microphone will be ready when the question is finished.";
  }
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  const INTERRUPT_WORDS = new Set(["wait", "sorry", "hold", "actually", "stop", "excuse", "hang"]);
  function isEcho(heard, botText) {
    const hw = words(heard); if (!hw.length) return true;
    const bw = new Set(words(botText)); return hw.filter(w => bw.has(w)).length / hw.length >= 0.6;
  }
  function looksLikeParticipant(heard) { const w = words(heard); return w.length >= CV.bargeInMinWords || (w.length === 1 && INTERRUPT_WORDS.has(w[0])); }
  function acceptLocalTranscript(text, fromAnswerWindow = false) {
    const heard = (text || "").trim();
    if (!heard || (!localListening && !fromAnswerWindow) || S.chatLocked || S.activeProbe) return;
    if (!fromAnswerWindow && (S.botSpeaking || perf() < S.echoGuardUntil)) {
      if (isEcho(heard, S.currentBotText) || !looksLikeParticipant(heard)) return;
      if (S.botSpeaking) { log("bot_interrupted", { heard, spoken_chars: S.ttsChar, text_chars: S.currentBotText.length }); stopSpeaking("barge_in"); }
      S.echoGuardUntil = 0;
    }
    speechBuffer = (speechBuffer + " " + heard).trim(); utterBuf = speechBuffer;
    $("liveTranscript").textContent = speechBuffer; $("micBtn").classList.add("hearing");
    if (localListening) S.voiceActiveUntil = perf() + 3600e3;
    else if (fromAnswerWindow && inflightEmotionWindows > 0) S.voiceActiveUntil = perf() + 3600e3;
    else {
      S.voiceActiveUntil = perf() + CV.endOfUtteranceMs;
      clearTimeout(speechTimer); speechTimer = setTimeout(commitLocalSpeech, CV.endOfUtteranceMs);
    }
  }
  function commitLocalSpeech() {
    clearTimeout(speechTimer); speechTimer = null;
    const t = speechBuffer.trim(); speechBuffer = ""; utterBuf = ""; interimBuf = "";
    $("liveTranscript").textContent = ""; $("micBtn").classList.remove("hearing"); S.voiceActiveUntil = 0;
    if (t) handleUser(t, "voice");
  }
  function finishLocalAnswer() {
    const feedbackEligible = participantSpeechSamples >= MIN_EMOTION_FEEDBACK_SAMPLES;
    if (!feedbackEligible) {
      const remaining = Math.max(1, Math.ceil((MIN_EMOTION_FEEDBACK_SAMPLES - participantSpeechSamples) / 16000));
      toast(`Please continue speaking for at least ${remaining} more second${remaining === 1 ? "" : "s"}.`);
      $("voiceOnlyHint").textContent = `Please keep speaking for at least ${remaining} more second${remaining === 1 ? "" : "s"}. The Stop button remains available if you want to end the session.`;
      log("minimum_speech_prompt", { spoken_ms: Math.round(participantSpeechSamples / 16), minimum_ms: Math.round(MIN_EMOTION_FEEDBACK_SAMPLES / 16) });
      return false;
    }
    setListening(false);
    if (!submitBusy && sampleCount >= 16000) sendEmotionWindow(true);
    else if (!submitBusy && inflightEmotionWindows === 0) {
      if (speechBuffer.trim()) commitLocalSpeech();
      else toast("Please speak for at least a second, then press the microphone to finish.");
    }
    return true;
  }

  function commitUtterance() {
    commitLocalSpeech();
  }

  // Phase ending / check-in opening mid-sentence: keep the words, no reply
  function flushUtterance(reason) {
    clearTimeout(utterTimer); clearTimeout(speechTimer);
    $("micBtn").classList.remove("hearing");
    const t = speechBuffer.trim();
    speechBuffer = "";
    utterBuf = ""; interimBuf = "";
    $("liveTranscript").textContent = "";
    S.voiceActiveUntil = 0;
    if (t && curPhase() && curPhase().kind === "chat") recordUser(t, { input: "voice", no_reply: true, cut_reason: reason });
  }

  // ---------------- Hosted demo: push-to-talk dictation ----------------
  let dictWired = false, dictDiscard = false;
  function wireDictation() {
    if (dictWired || !H || !H.dict) return;
    dictWired = true;
    H.dict.onPartial(({ text }) => {
      if (dictDiscard || S.chatLocked) return;
      interimBuf = text || "";
      $("liveTranscript").textContent = (utterBuf + " " + interimBuf).trim();
    });
    H.dict.onFinal(({ text }) => {
      if (dictDiscard || S.chatLocked) return;
      utterBuf += text; interimBuf = "";
      $("liveTranscript").textContent = utterBuf.trim();
    });
    H.dict.onState(({ state, reason }) => {
      const on = state !== "idle";
      $("micBtn").classList.toggle("dictating", on);
      $("micBtn").classList.toggle("hearing", state === "listening");
      if (on) { S.voiceActiveUntil = perf() + 3600e3; return; }   // Alex holds its reply while the mic is open
      S.voiceActiveUntil = 0;
      if (dictDiscard) { dictDiscard = false; utterBuf = ""; interimBuf = ""; $("liveTranscript").textContent = ""; return; }
      if (reason && !["stopped", "viewer_stopped", "hidden"].includes(reason)) log("stt_error", { error: reason });
      interimBuf = "";
      commitUtterance();
    });
  }
  if (HOSTED) H.ready.then(wireDictation);
  function stopDictation(discard) {
    if (!HOSTED || !H || !H.dict || !H.dict.active()) return;
    dictDiscard = !!discard;
    H.dict.stop().catch(() => {});
  }

  $("micBtn").onclick = () => {
    if (S.chatLocked || S.inputMode !== "voice") return;
    if (HOSTED) {
      if (!H || !H.dict) { toast("Spoken input is unavailable. The session cannot continue without it."); return; }
      if (H.dict.active()) { log("mic_toggle", { on: false }); H.dict.stop().catch(() => {}); return; }
      if (S.botSpeaking) {             // pressing the mic while Alex talks: Alex stops and listens
        log("bot_interrupted", { heard: "(pressed the microphone)", spoken_chars: S.ttsChar, text_chars: S.currentBotText.length });
        stopSpeaking("barge_in");
      }
      dictDiscard = false;
      H.dict.start().catch((e) => {
        if (e && e.code === "not_granted") toast("Microphone access was declined. Allow it in the browser before continuing.");
      });
      log("mic_toggle", { on: true });
      return;
    }
    if (!recogWanted && S.botSpeaking) stopSpeaking("barge_in");
    if (recogWanted) {
      if (!finishLocalAnswer()) return;
    }
    else { if (S.botSpeaking) stopSpeaking("barge_in"); setListening(true); }
    log("mic_toggle", { on: recogWanted });
  };
  function addMsg(who, text) {
    const d = document.createElement("div");
    d.className = "msg " + who; d.textContent = text;
    $("chatbox").appendChild(d); $("chatbox").scrollTop = 1e9;
    return d;
  }

  let lastStatus = null;
  function updateBotStatus() {
    let s = "";
    if (S.activeProbe) s = "Paused";
    else if (S.botSpeaking) s = "Speaking";
    else if (userActive()) s = "Listening…";
    else if (S.busy) s = "Thinking…";
    if (s !== lastStatus) {
      $("botStatus").textContent = s;
      $("botStatus").classList.toggle("on", !!s);
      lastStatus = s;
    }
  }

  // ------------------------------------------------------------------
  // Check-in (slider dialog over the chat; the chat is locked while open)
  // ------------------------------------------------------------------
  function tickProbe(left) {
    if (S.activeProbe) {
      if (!S.activeProbe.submitted && (perf() - S.activeProbe.shownPerf) / 1000 * S.speed > C.probes.autoDismissSec) clearProbe("timeout");
      return;
    }
    if (S.nextProbeAt == null || S.phaseElapsed < S.nextProbeAt) return;
    if (left < C.probes.minRemainingSec || inNoticeWindow()) {
      log("probe_skipped", { reason: "phase_ending" });
      S.nextProbeAt = null; S.probeDueAt = null; S.probeDeferredReason = null;
      return;
    }
    if (S.probeDueAt == null) S.probeDueAt = perf();
    const waited = perf() - S.probeDueAt;
    const blockedBy = probeBlockedBy();
    if (blockedBy) {
      if (S.probeDeferredReason !== blockedBy) {
        log("probe_deferred", { reason: blockedBy, deferred_ms: Math.round(waited) });
        S.probeDeferredReason = blockedBy;
      }
      return;
    }
    showProbe("scheduled", waited);
  }

  function probeBlockedBy() {
    if (S.botSpeaking) return "ai_speaking";
    const hostedDictActive = HOSTED && !!(H && H.dict && H.dict.active());
    const micCapturing = localListening || recogWanted || hostedDictActive || userActive() ||
      $("micBtn").classList.contains("hearing") || $("micBtn").classList.contains("dictating");
    if (micCapturing) return "participant_answer_in_progress";
    if (S.busy || submitBusy || inflightEmotionWindows > 0) return "turn_processing";
    if (speechBuffer.trim() || utterBuf.trim() || interimBuf.trim()) return "uncommitted_speech";
    return null;
  }

  function setChatLocked(on) {
    S.chatLocked = on;
    $("chatPanel").classList.toggle("locked", on);
    $("micBtn").disabled = on;
    $("voiceOnlyHint").textContent = on
      ? "Conversation paused while you answer the check-in."
      : "Speak your answer. Use the microphone button to pause or resume listening.";
    $("chatbox").inert = on;
    if (on) { S.voiceActiveUntil = 0; pauseRecog(true, "checkin"); stopDictation(true); }
    else pauseRecog(false, "checkin");
  }

  function midValue(it) {
    const step = it.step || 1;
    return it.min + Math.round((it.max - it.min) / 2 / step) * step;
  }
  function valueText(it, v) {
    const end = v === it.min ? `, ${it.left}` : v === it.max ? `, ${it.right}` : "";
    return `${v} out of ${it.max}${end}`;
  }

  function showProbe(trigger, deferredMs = 0) {
    const p = curPhase();
    if (S.activeProbe || !p || p.kind !== "chat") return false;
    const blockedBy = probeBlockedBy();
    if (blockedBy) {
      S.probeDueAt = S.probeDueAt ?? perf();
      S.probeDeferredReason = blockedBy;
      if (trigger === "manual") {
        S.nextProbeAt = S.phaseElapsed;
        toast("Check-in will wait until you finish speaking and Alex finishes replying.");
      }
      log("probe_deferred", { reason: blockedBy, trigger, deferred_ms: Math.round(perf() - S.probeDueAt) });
      return false;
    }
    setChatLocked(true);
    S.probeCount++;
    S.probeDueAt = null;
    S.probeDeferredReason = null;
    const id = `probe_${S.probeCount}`;
    const shown = log("probe_shown", { probe_id: id, trigger, deferred_ms: Math.round(deferredMs), affect: getAffectSnapshot() });

    const layer = $("probeLayer");
    layer.innerHTML = "";
    const card = document.createElement("div");
    card.className = "probe-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "probeTitle");
    card.setAttribute("aria-describedby", "probeSub");
    card.innerHTML = `<h3 id="probeTitle" tabindex="-1">Quick check-in</h3>
      <p class="probe-sub" id="probeSub">The conversation is paused. Click or drag along each line to show how you feel right now.</p>`;

    const answers = {}, firstRt = {}, nChanges = {};
    const foot = document.createElement("div"); foot.className = "probe-foot";
    const hint = document.createElement("span"); hint.className = "probe-hint"; hint.setAttribute("aria-live", "polite");
    const submit = document.createElement("button");
    submit.className = "btn btn-primary"; submit.textContent = "Save check-in"; submit.disabled = true;
    const refresh = () => {
      const left = C.probeItems.length - Object.keys(answers).length;
      submit.disabled = left > 0;
      hint.textContent = left > 0 ? `${left} of ${C.probeItems.length} left to answer` : "All answered";
    };

    C.probeItems.forEach((it) => {
      const sid = `probe-${it.id}`;
      const ticks = [];
      for (let v = it.min; v <= it.max; v += it.step || 1) ticks.push(`<span>${v}</span>`);
      const wrap = document.createElement("div");
      wrap.className = "probe-item";
      wrap.innerHTML = `
        <div class="pi-head">
          <label for="${sid}">${it.text}</label>
          <output class="pi-value empty" id="${sid}-out" for="${sid}">Not answered</output>
        </div>
        <input type="range" class="slider untouched" id="${sid}" min="${it.min}" max="${it.max}" step="${it.step || 1}"
               value="${midValue(it)}" aria-describedby="${sid}-anchors" aria-valuetext="Not answered yet" />
        <div class="ticks" aria-hidden="true">${ticks.join("")}</div>
        <div class="anchors" id="${sid}-anchors"><span>${it.left}</span><span>${it.right}</span></div>`;
      const input = wrap.querySelector("input"), out = wrap.querySelector("output");
      const take = () => {
        if (!S.activeProbe || S.activeProbe.submitted) return;
        const v = +input.value;
        if (answers[it.id] !== v) nChanges[it.id] = (nChanges[it.id] || 0) + 1;
        answers[it.id] = v;
        if (firstRt[it.id] == null) firstRt[it.id] = Math.round(perf() - S.activeProbe.shownPerf);
        input.classList.remove("untouched");
        input.style.setProperty("--fill", (((v - it.min) / (it.max - it.min)) * 100).toFixed(1) + "%");
        input.setAttribute("aria-valuetext", valueText(it, v));
        out.textContent = v; out.classList.remove("empty");
        refresh();
      };
      input.addEventListener("input", take);
      input.addEventListener("pointerup", take);                 // a click on the current (middle) value still counts
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); take(); } });
      card.appendChild(wrap);
    });

    submit.onclick = () => {
      if (!S.activeProbe || S.activeProbe.submitted || submit.disabled) return;
      S.activeProbe.submitted = true;
      const rt = Math.round(perf() - S.activeProbe.shownPerf);
      const rec = {
        probe_id: id, ...phaseInfo(),
        shown_epoch_ms: shown.t_epoch_ms, shown_session_s: shown.t_session_s,
        answered_epoch_ms: now().t_epoch_ms, rt_ms: rt, status: "answered", deferred_ms: Math.round(deferredMs),
        ...Object.fromEntries(C.probeItems.map((it) => [it.id, answers[it.id]])),
        ...Object.fromEntries(C.probeItems.map((it) => [`${it.id}_first_rt_ms`, firstRt[it.id]])),
        ...Object.fromEntries(C.probeItems.map((it) => [`${it.id}_n_changes`, nChanges[it.id]])),
        affect_at_shown: shown.affect, affect_at_answer: getAffectSnapshot(),
      };
      S.probes.push(rec);
      log("probe_response", rec);
      addMsg("system", "Check-in saved");
      card.innerHTML = `<div class="probe-thanks" role="status">Saved. Back to the conversation.</div>`;
      setTimeout(() => { if (S.activeProbe && S.activeProbe.id === id) closeProbe(); }, 900);
    };

    foot.appendChild(hint); foot.appendChild(submit);
    card.appendChild(foot);
    layer.appendChild(card);
    layer.classList.add("show");
    refresh();
    S.activeProbe = { id, card, shownPerf: perf(), shown, submitted: false };
    $("probeTitle").focus();
    return true;
  }

  function closeProbe() {
    $("probeLayer").classList.remove("show");
    $("probeLayer").innerHTML = "";
    S.activeProbe = null;
    setChatLocked(false);
    S.lastUserAt = perf();                                     // restart the silence timer
    scheduleNextProbe();
  }
  function clearProbe(reason) {
    if (!S.activeProbe) return;
    if (!S.activeProbe.submitted) {
      const { id, shown } = S.activeProbe;
      const rec = { probe_id: id, ...phaseInfo(), shown_epoch_ms: shown.t_epoch_ms, shown_session_s: shown.t_session_s, status: reason, affect_at_shown: shown.affect };
      S.probes.push(rec);
      log("probe_missed", rec);
      if (reason === "timeout") addMsg("system", "Check-in skipped");
    }
    closeProbe();
  }
  function scheduleNextProbe() {
    const p = curPhase();
    S.probeDeferredReason = null;
    S.probeDueAt = null;
    S.nextProbeAt = p && p.kind === "chat" && (p.isCondition || !C.probes.onlyDuringCondition) ? S.phaseElapsed + randProbeDelay() : null;
  }

  // ------------------------------------------------------------------
  // Affect sampling + feedback rendering
  // ------------------------------------------------------------------
  function setupConditionUI() {
    $("directPanel").classList.toggle("hidden", S.condition !== "direct");
  }

  async function localEmotionReady() {
    try { const r = await fetch("/api/emotion/health"); const d = await r.json(); return r.ok && d.status === "ready" && d.models && d.models.joint === "lightmer_stage2"; }
    catch (_) { return false; }
  }
  function setFaceLocatorStatus(state, message) {
    const tile = $("selfTile"), status = $("faceStatus"), box = $("faceBox");
    if (tile) tile.dataset.faceState = state;
    if (status && status.textContent !== message) status.textContent = message;
    if (box && state !== "found") box.style.display = "none";
  }
  function renderFaceLocator() {
    const video = $("selfVideo"), boxEl = $("faceBox");
    if (!video || !boxEl) return;
    const face = faceCueEngine && faceCueEngine.face;
    if (!faceCueEngine || !faceCueEngine.faceReady) {
      setFaceLocatorStatus(HOSTED ? "unavailable" : "waiting", HOSTED ? "Face locator unavailable" : "Face detector starting…");
      return;
    }
    if (!face || !face.box || face.conf < 0.2 || perf() - face.t > 1200) {
      const message = !video.videoWidth ? "Waiting for camera…" : face && face.t ? "No face detected · move into view" : "Looking for your face…";
      setFaceLocatorStatus("missing", message);
      return;
    }
    const rect = video.getBoundingClientRect();
    const frameWidth = face.box.frameWidth || video.videoWidth;
    const frameHeight = face.box.frameHeight || video.videoHeight;
    if (!rect.width || !rect.height || !frameWidth || !frameHeight) {
      setFaceLocatorStatus("missing", "Waiting for camera…");
      return;
    }
    // Match object-fit: cover and the mirrored self-view, so this box is drawn
    // around the face exactly where the participant sees it.
    const scale = Math.max(rect.width / frameWidth, rect.height / frameHeight);
    const cropX = (frameWidth * scale - rect.width) / 2;
    const cropY = (frameHeight * scale - rect.height) / 2;
    const width = face.box.width * scale;
    const height = face.box.height * scale;
    const left = rect.width - ((face.box.x + face.box.width) * scale - cropX);
    const top = face.box.y * scale - cropY;
    boxEl.style.left = `${left}px`;
    boxEl.style.top = `${top}px`;
    boxEl.style.width = `${width}px`;
    boxEl.style.height = `${height}px`;
    boxEl.style.display = "block";
    setFaceLocatorStatus("found", `Face detected · ${Math.round(face.conf * 100)}%`);
  }
  async function startClientFaceCueDetector() {
    if (HOSTED) { setFaceLocatorStatus("unavailable", "Face locator unavailable in this mode"); return false; }
    if (!S.stream || !window.AffectEngine) { setFaceLocatorStatus("unavailable", "Face detector unavailable"); return false; }
    setFaceLocatorStatus("waiting", "Loading face detector…");
    if (faceCueEngine) faceCueEngine.stopFace();
    faceCueEngine = new window.AffectEngine(C.affect, () => {});
    const ready = await faceCueEngine.initFace($("selfVideo"), "vendor/models");
    if (!ready) {
      log("local_face_expression_unavailable", { reason: "local model load failed" });
      setFaceLocatorStatus("unavailable", "Face detector unavailable");
      return false;
    }
    if (faceCueSampler) clearInterval(faceCueSampler);
    faceCueSampler = setInterval(() => {
      renderFaceLocator();
      if (!localListening) return;
      const face = faceCueEngine && faceCueEngine.face;
      if (!face || !face.conf || !face.expressions) return;
      faceCueHistory.push({ at: perf(), expressions: { ...face.expressions } });
      const cutoff = perf() - 18000;
      while (faceCueHistory.length && faceCueHistory[0].at < cutoff) faceCueHistory.shift();
    }, 250);
    renderFaceLocator();
    log("local_face_expression_ready", { model: "face-api.js local expression net", detector_threshold: 0.2 });
    return true;
  }
  function stopClientFaceCueDetector() {
    if (faceCueSampler) clearInterval(faceCueSampler);
    faceCueSampler = null;
    if (faceCueEngine) faceCueEngine.stopFace();
    faceCueEngine = null;
    faceCueHistory = [];
    setFaceLocatorStatus("waiting", "Face detection stopped");
  }
  const FACE_LABELS = { happy: "happiness", sad: "sadness", angry: "anger", fearful: "fear", disgusted: "disgust", surprised: "surprise", neutral: "neutral" };
  const TEXT_EMOTION_TERMS = {
    anger: ["angry", "anger", "furious", "rage", "frustrated", "frustrating", "frustration", "annoyed", "annoying", "irritated", "irritating", "resentful", "mad"],
    disgust: ["disgusted", "disgusting", "grossed out", "repulsed", "revolting", "repelled", "contemptuous"],
    fear: ["stressed", "stress", "stressful", "under pressure", "pressured", "overwhelmed", "anxious", "anxiety", "worried", "worry", "nervous", "uneasy", "panicked", "tense", "afraid", "scared", "insecure"],
    happiness: ["happy", "happiness", "excited", "exciting", "joyful", "glad", "delighted", "pleased", "enjoyed", "enjoying", "cheerful", "thrilled", "amused", "relieved", "grateful", "content"],
    sadness: ["sad", "sadness", "down", "disappointed", "disappointing", "lonely", "upset", "unhappy", "discouraged", "grief", "grieving", "heartbroken", "hopeless", "hurt"],
    surprise: ["surprised", "shocked", "astonished", "unexpected", "amazed"],
    shame: ["ashamed", "shame", "embarrassed", "embarrassment", "self conscious", "guilty", "guilt"],
    pride: ["proud", "pride", "accomplished"],
    interest: ["interested", "interest", "curious", "curiosity", "intrigued", "fascinated", "engaged"]
  };
  function transcriptEmotionCue(transcript) {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const terms = Object.values(TEXT_EMOTION_TERMS).flat().map(escape).sort((a, b) => b.length - a.length);
    const termsPattern = terms.join("|");
    const negative = new RegExp(`\\b(?:not|never|no longer|isn't|wasn't|aren't|don't|do not|didn't|doesn't)(?:\\s+\\w+){0,3}\\s+(?:${termsPattern})\\b`, "gi");
    const text = String(transcript || "").toLowerCase().replace(negative, " ");
    const mentions = [];
    for (const [label, phrases] of Object.entries(TEXT_EMOTION_TERMS)) {
      const pattern = new RegExp(`\\b(?:${phrases.map(escape).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");
      for (const match of text.matchAll(pattern)) mentions.push({ label, phrase: match[0], at: match.index });
    }
    if (!mentions.length) return null;
    mentions.sort((a, b) => a.at - b.at);
    const counts = new Map();
    for (const mention of mentions) counts.set(mention.label, (counts.get(mention.label) || 0) + 1);
    const winner = [...counts].sort((a, b) => b[1] - a[1] || mentions.filter((item) => item.label === b[0]).at(-1).at - mentions.filter((item) => item.label === a[0]).at(-1).at)[0][0];
    const latest = [...mentions].reverse().find((mention) => mention.label === winner);
    return { label: winner, phrase: latest.phrase, mentions: mentions.length };
  }
  function normalizedEmotionScores(scores, canonical) {
    const mapped = {};
    for (const [raw, value] of Object.entries(scores || {})) {
      const label = canonical(raw);
      if (Number.isFinite(+value) && +value >= 0) mapped[label] = (mapped[label] || 0) + +value;
    }
    const total = Object.values(mapped).reduce((sum, value) => sum + value, 0);
    if (!total) return {};
    for (const key of Object.keys(mapped)) mapped[key] /= total;
    return mapped;
  }
  function faceCueForWindow(f) {
    const start = Number(f.client_start_ms), end = Number(f.client_end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { means: {}, cue: null, count: 0 };
    const samples = faceCueHistory.filter((row) => row.at >= start - 350 && row.at <= end + 350);
    const means = {};
    if (samples.length) {
      for (const key of Object.keys(FACE_LABELS)) {
        means[key] = samples.reduce((sum, row) => sum + (+row.expressions[key] || 0), 0) / samples.length;
      }
    }
    const ranked = Object.entries(means).filter(([key]) => key !== "neutral").sort((a, b) => b[1] - a[1]);
    const [raw, mean] = ranked[0] || [];
    const peak = raw ? Math.max(...samples.map((row) => +row.expressions[raw] || 0)) : 0;
    const meanThreshold = C.affect.faceCueMeanThreshold || 0.035;
    const peakThreshold = C.affect.faceCuePeakThreshold || 0.12;
    const cue = samples.length >= 3 && raw && mean >= meanThreshold && peak >= peakThreshold
      ? { label: FACE_LABELS[raw], mean: +mean.toFixed(4), peak: +peak.toFixed(4), samples: samples.length }
      : null;
    return { means, cue, count: samples.length };
  }
  function getAffectSnapshot() {
    const f = latestEmotion || {};
    return { label: f.label || "uncertain", emotion_terms: f.emotion_terms || [], status: f.status || "waiting", transcript: f.transcript || "", asr_ms: f.asr_ms || null, inference_ms: f.inference_ms || null, window_start_ms: f.client_start_ms ?? null, window_end_ms: f.client_end_ms ?? null };
  }
  function startLocalEmotionCapture() {
    sampleQueue=[]; sampleCount=0;
    emotionCtx=new (window.AudioContext||window.webkitAudioContext)(); audioSource=emotionCtx.createMediaStreamSource(S.stream);
    emotionCtx.resume().catch(()=>{});
    emotionProcessor=emotionCtx.createScriptProcessor(4096,1,1); const sink=emotionCtx.createGain(); sink.gain.value=0;
    audioSource.connect(emotionProcessor); emotionProcessor.connect(sink); sink.connect(emotionCtx.destination);
    emotionProcessor.onaudioprocess=(e)=>{
      if(!emotionToken||S.ended||!localListening)return;const src=e.inputBuffer.getChannelData(0),ratio=emotionCtx.sampleRate/16000,out=new Float32Array(Math.floor(src.length/ratio));
      for(let i=0;i<out.length;i++){const a=Math.floor(i*ratio),b=Math.min(src.length,Math.floor((i+1)*ratio));let sum=0;for(let j=a;j<b;j++)sum+=src[j];out[i]=sum/Math.max(1,b-a);}
      if(sampleCount===0)sampleQueueStartMs=performance.now()-out.length/16;
      windowParticipantAnswer=true;participantAnswerSamples+=out.length;let power=0;for(let i=0;i<src.length;i++)power+=src[i]*src[i];const rms=Math.sqrt(power/Math.max(1,src.length));if(rms>.008){participantSpeechSamples+=out.length;$("micBtn").classList.add("hearing");const seconds=Math.floor(participantSpeechSamples/16000);$("voiceOnlyHint").textContent=`Listening · ${seconds}/${C.affect.minFeedbackSeconds||10} seconds spoken. Keep going until you reach ${C.affect.minFeedbackSeconds||10} seconds.`;}
      sampleQueue.push(out);sampleCount+=out.length;if(sampleCount>=80000)sendEmotionWindow(false);
    };
    frameTimer=setInterval(captureFrame,800);captureFrame();
  }
  const emotionFrames=[];
  function captureFrame(){if(!emotionToken||!$("selfVideo").videoWidth)return;try{frameCanvas.getContext("2d").drawImage($("selfVideo"),0,0,224,168);emotionFrames.push({client_ms:performance.now(),jpeg:frameCanvas.toDataURL("image/jpeg",.7).split(",")[1]});while(emotionFrames.length>40)emotionFrames.shift();}catch(_){}}
  function floatBase64(a){const bytes=new Uint8Array(a.length*4),v=new DataView(bytes.buffer);for(let i=0;i<a.length;i++)v.setFloat32(i*4,a[i],true);let b="";for(let i=0;i<bytes.length;i+=32768)b+=String.fromCharCode(...bytes.subarray(i,Math.min(i+32768,bytes.length)));return btoa(b);}
  async function sendEmotionWindow(force=false){
    if(submitBusy||!emotionToken||sampleCount<(force?16000:80000))return;submitBusy=true;inflightEmotionWindows++;
    const take=Math.min(sampleCount,96000),parts=sampleQueue,samples=new Float32Array(take);let copied=0,used=0;
    for(const part of parts){if(copied>=take)break;const n=Math.min(part.length,take-copied);samples.set(part.subarray(0,n),copied);copied+=n;used++;if(n<part.length){sampleQueue=[part.subarray(n),...parts.slice(used)];used=0;break;}}
    if(used>0)sampleQueue=parts.slice(used);
    sampleCount-=take;const startMs=sampleQueueStartMs??(performance.now()-take/16),endMs=startMs+take/16;sampleQueueStartMs=sampleCount?endMs:null;
    const fromAnswer=windowParticipantAnswer,frames=emotionFrames.filter(f=>f.client_ms>=startMs-100&&f.client_ms<=endMs+100).slice(-8);
    if(!sampleCount)windowParticipantAnswer=false;
    try{const r=await fetch("/api/emotion/window",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_token:emotionToken,audio:floatBase64(samples),client_start_ms:startMs,client_end_ms:endMs,frames})});const ack=await r.json();if(!r.ok)throw new Error(ack.error||`HTTP ${r.status}`);
      const until=Date.now()+25000;while(Date.now()<until&&emotionToken){await sleep(350);const sr=await fetch("/api/emotion/state",{headers:{"x-session-token":emotionToken}});const sd=await sr.json(),f=sd.fusion;if(f&&Math.abs((f.client_end_ms||0)-endMs)<100){const feedbackEligible=fromAnswer&&participantSpeechSamples>=MIN_EMOTION_FEEDBACK_SAMPLES;const shown=feedbackEligible?f:{...f,label:"uncertain",candidate:"uncertain",feedback_label:"uncertain",emotion_terms:[],scores:{},channel_scores:{},status:"insufficient_signal",demo_status:"answer_too_short"};applyEmotionResult(shown,fromAnswer,feedbackEligible);break;}}
    }catch(e){log("emotion_window_error",{error:String(e.message||e)});}finally{
      submitBusy=false;inflightEmotionWindows--;
      if(sampleCount>=80000||(!localListening&&sampleCount>=16000))sendEmotionWindow(!localListening);
      else if(!localListening&&inflightEmotionWindows===0)commitLocalSpeech();
    }
  }
  function applyEmotionResult(f,fromAnswerWindow=false,feedbackEligible=true){
    latestEmotion=f;
    const faceWindow = fromAnswerWindow ? faceCueForWindow(f) : { means: {}, cue: null, count: 0 };
    const textCue = fromAnswerWindow ? transcriptEmotionCue(f.transcript) : null;
    let terms=Array.isArray(f.emotion_terms)?f.emotion_terms.slice():[];
    const noEmotion = new Set(["uncertain", "neutral", "insufficient_signal", "no_face", "multiple_faces", "waiting"]);
    const aliases = { happy: "happiness", joy: "happiness", amused: "happiness", amusement: "happiness", cheerful: "happiness", thrilled: "happiness", delighted: "happiness", angry: "anger", furious: "anger", rage: "anger", frustrated: "anger", frustrating: "anger", frustration: "anger", annoyed: "anger", annoyance: "anger", irritated: "anger", resentful: "anger", disapproval: "anger", sad: "sadness", disappointed: "sadness", disappointment: "sadness", grieving: "sadness", grief: "sadness", heartbroken: "sadness", hopeless: "sadness", anxious: "fear", anxiety: "fear", nervousness: "fear", nervous: "fear", fearful: "fear", stressed: "fear", stressful: "fear", stress: "fear", pressured: "fear", overwhelmed: "fear", worried: "fear", worry: "fear", panicked: "fear", tense: "fear", uneasy: "fear", afraid: "fear", scared: "fear", insecure: "fear", disgusted: "disgust", contemptuous: "disgust", surprised: "surprise", amazed: "surprise", embarrassed: "shame", embarrassment: "shame", ashamed: "shame", guilty: "shame", guilt: "shame", curious: "interest", curiosity: "interest", interested: "interest", fascinated: "interest", engaged: "interest", admired: "pride", admiration: "pride", proud: "pride", accomplished: "pride", relieved: "happiness", grateful: "happiness", content: "happiness" };
    const canonical = (value) => {
      const term = String(value || "").toLowerCase().split(/[, +]/)[0].trim();
      return aliases[term] || term;
    };
    let mainEmotion=[f.feedback_label,terms[0],f.candidate,f.label]
      .map(canonical).find((candidate)=>candidate&&!noEmotion.has(candidate))||"";

    // Pool the short model windows from this spoken answer. This reduces
    // frame-to-frame label flips while retaining the most salient non-neutral
    // cue when neutral is only marginally ahead.
    let pooledScores = {}, fusedScores = {}, feedbackScores = {};
    let recentFaceCue = null;
    let appliedTextCue = textCue;
    let rawEmotionLabel = mainEmotion;
    let strategyTarget = ({ anger: "anger", pride: "pride" })[S.strategy] || null;
    let targetPriorApplied = 0;
    let targetPriorEligible = false;
    const hasFaceScores = Object.keys(faceWindow.means).length > 0;
    const mergedChannelScores = { ...(f.channel_scores || {}) };
    if (hasFaceScores) mergedChannelScores.face_api = faceWindow.means;
    if (textCue) mergedChannelScores.explicit_text = { [textCue.label]: 1 };
    if (fromAnswerWindow && feedbackEligible && ((f.scores && Object.keys(f.scores).length) || hasFaceScores || textCue || terms.length)) {
      answerEmotionWindows.push({ scores: f.scores || {}, face_scores: faceWindow.means, face_cue: faceWindow.cue, text_cue: textCue, face_count: faceWindow.count, label: textCue?.label || mainEmotion || canonical(terms[0]), terms, sources: [...(f.sources || []), ...(faceWindow.cue ? ["face_api"] : []), ...(textCue ? ["explicit_text"] : [])], channel_scores: mergedChannelScores });
      answerEmotionWindows = answerEmotionWindows.slice(-4);
      const rows = answerEmotionWindows;
      const totalWeight = rows.reduce((sum, _, i) => sum + i + 1, 0);
      const pooledFaceScores = {};
      for (const [i, row] of rows.entries()) {
        const weight = (i + 1) / totalWeight;
        for (const [key, value] of Object.entries(row.scores || {})) {
          const normalized = canonical(key);
          if (Number.isFinite(+value)) pooledScores[normalized] = (pooledScores[normalized] || 0) + weight * +value;
        }
        for (const [key, value] of Object.entries(row.face_scores || {})) {
          const normalized = canonical(key);
          if (Number.isFinite(+value)) pooledFaceScores[normalized] = (pooledFaceScores[normalized] || 0) + weight * +value;
        }
      }
      const modelNorm = normalizedEmotionScores(pooledScores, canonical);
      const faceNorm = normalizedEmotionScores(pooledFaceScores, canonical);
      const recentTextCue = [...rows].reverse().find((row) => row.text_cue)?.text_cue || null;
      appliedTextCue = recentTextCue;
      const recentFaceCueRow = [...rows].reverse().find((row) => row.face_cue) || null;
      recentFaceCue = recentFaceCueRow?.face_cue || null;
      const cueWeights = C.affect.answerCueWeights || {};
      const weights = recentTextCue
        ? { model: cueWeights.model ?? 0.40, face: cueWeights.face ?? 0.15, text: cueWeights.explicitText ?? 0.45 }
        : { model: cueWeights.modelWithoutText ?? 0.72, face: cueWeights.faceWithoutText ?? 0.28, text: 0 };
      const labels = new Set([...Object.keys(modelNorm), ...Object.keys(faceNorm), ...rows.flatMap((row) => (row.terms || []).map(canonical)), ...(recentTextCue ? [recentTextCue.label] : []), "anger", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"]);
      for (const key of labels) fusedScores[key] = weights.model * (modelNorm[key] || 0) + weights.face * (faceNorm[key] || 0) + (recentTextCue?.label === key ? weights.text : 0);
      const ranked = Object.entries(fusedScores).filter(([key, value]) => !noEmotion.has(key) && Number.isFinite(value)).sort((a, b) => b[1] - a[1]);
      const bestNonNeutral = ranked.find(([key, value]) => key !== "neutral" && value > 0);
      const specialLabels = rows.map((row) => canonical(row.label)).filter((key) => ["shame", "pride", "interest"].includes(key));
      const special = specialLabels.length ? specialLabels[specialLabels.length - 1] : "";
      rawEmotionLabel = recentTextCue?.label || special || bestNonNeutral?.[0] || ranked.find(([, value]) => value > 0)?.[0] || canonical(terms[0]) || mainEmotion;
      if (noEmotion.has(rawEmotionLabel)) rawEmotionLabel = "";
      // Keep measured affect independent from the active induction condition.
      feedbackScores = { ...fusedScores };
      const hasAffectEvidence = !!recentTextCue || !!recentFaceCue || terms.some((term) => !noEmotion.has(canonical(term))) || (bestNonNeutral?.[1] >= 0.03) || (!!mainEmotion && !noEmotion.has(mainEmotion));
      targetPriorEligible = !!strategyTarget && S.strategyStimulusDelivered;
      if (!recentTextCue && targetPriorEligible && hasAffectEvidence) {
        targetPriorApplied = Math.max(0, Number(C.affect.strategyTargetPriorBoost) || 0);
        feedbackScores[strategyTarget] = (feedbackScores[strategyTarget] || 0) + targetPriorApplied;
      }
      const feedbackRanked = Object.entries(feedbackScores).filter(([key, value]) => !noEmotion.has(key) && Number.isFinite(value)).sort((a, b) => b[1] - a[1]);
      const feedbackNonNeutral = feedbackRanked.find(([key, value]) => key !== "neutral" && value > 0);
      // Explicit emotion words stay in front. Otherwise, after Alex has
      // delivered the induction stimulus, its target can shape the next cue.
      mainEmotion = recentTextCue?.label || (targetPriorApplied ? feedbackNonNeutral?.[0] : rawEmotionLabel) || rawEmotionLabel;
    }
    const nonNeutralScores=Object.entries(fusedScores).length
      ? Object.entries(fusedScores).filter(([key,value])=>key!=="neutral"&&Number.isFinite(+value)).sort((a,b)=>+b[1]-+a[1])
      : Object.entries(f.scores||{}).filter(([key,value])=>key!=="neutral"&&Number.isFinite(+value)).sort((a,b)=>+b[1]-+a[1]);
    const bestSubtle=nonNeutralScores[0]?.[0]||null;
    let feedbackStrength=f.feedback_strength||"subtle";
    if(rawEmotionLabel&&!noEmotion.has(rawEmotionLabel))lastClearEmotion={label:rawEmotionLabel,raw_label:rawEmotionLabel,strategy:S.strategy,at:performance.now()};
    // Some Light-MER service builds return emotion_terms with a status other
    // than the literal "estimate". Trust a non-empty model term for feedback.
    if(fromAnswerWindow){
      if(!feedbackEligible){
        S.feedbackEmotionLabel="neutral";
      }else if(mainEmotion&&!noEmotion.has(mainEmotion)){
        S.feedbackEmotionLabel=mainEmotion.toLowerCase();
        const cueWindows=answerEmotionWindows.filter((row)=>canonical(row.label)===mainEmotion).length;
        const independentChannels=new Set(answerEmotionWindows.flatMap((row)=>Object.entries(row.channel_scores||{}).filter(([,scores])=>canonical(Object.entries(scores||{}).sort((a,b)=>+b[1]-+a[1])[0]?.[0])===mainEmotion).map(([name])=>name)));
        feedbackStrength=independentChannels.size>=2||cueWindows>=2?"supported":"subtle";
        log("main_emotion_selected",{emotion:S.feedbackEmotionLabel,raw_feedback_label:rawEmotionLabel,raw_fused_winner:f.label||null,strategy_target:strategyTarget,condition_target:strategyTarget,strategy_stimulus_delivered:S.strategyStimulusDelivered,target_prior_eligible:targetPriorEligible,target_prior_applied:targetPriorApplied,source:appliedTextCue?"explicit_transcript_emotion_cue":targetPriorApplied?"strategy_prior_adjusted_feedback":pooledScores[mainEmotion]!==undefined?"multimodal_answer_fusion":f.feedback_label?"multimodal_sensitive_candidate":bestSubtle?"lightmer_stage2_best_non_neutral":"lightmer_stage2",feedback_strength:feedbackStrength,model_status:f.status,sources:[...(f.sources||[]),...(recentFaceCue?["face_api"]:[]),...(appliedTextCue?["explicit_text"]:[])],scores:f.scores||{},pooled_scores:pooledScores,raw_fused_scores:fusedScores,feedback_scores:feedbackScores,channel_scores:mergedChannelScores,face_cue:recentFaceCue||null,text_cue:appliedTextCue||null,windows_in_answer:answerEmotionWindows.length,independent_channels:[...independentChannels]});
      }else if(lastClearEmotion&&performance.now()-lastClearEmotion.at<=120000){
        // Keep the most recent clear estimate through uncertain windows, up to
        // the same two-minute context used by the emotion summary.
        const retained=lastClearEmotion.raw_label;
        S.feedbackEmotionLabel=String(retained).split(/[, +]/)[0].toLowerCase();
        mainEmotion=canonical(S.feedbackEmotionLabel);
        log("main_emotion_retained",{emotion:S.feedbackEmotionLabel,reason:"uncertain_window_under_2min"});
      }
    }
    if (mainEmotion && !noEmotion.has(mainEmotion)) terms=[mainEmotion];
    const label=mainEmotion&&!noEmotion.has(mainEmotion)?mainEmotion:(terms.length?terms.join(", "):(f.status==="estimate"&&f.label?f.label:"uncertain"));
    if(f.transcript){$("liveTranscript").textContent=f.transcript;log("local_asr_result",{text:f.transcript,window_start_ms:f.client_start_ms,window_end_ms:f.client_end_ms,asr_ms:f.asr_ms});acceptLocalTranscript(f.transcript,fromAnswerWindow);}
    const snapshot=getAffectSnapshot();log("affect_sample",{...snapshot,source:"lightmer_local_face_text_fusion",raw_feedback_label:rawEmotionLabel,displayed_feedback_label:mainEmotion||"uncertain",feedback_label:mainEmotion||"uncertain",strategy_target:strategyTarget,condition_target:strategyTarget,strategy_stimulus_delivered:S.strategyStimulusDelivered,target_prior_eligible:targetPriorEligible,target_prior_applied:targetPriorApplied,feedback_strength:feedbackStrength,sources:[...(f.sources||[]),...(faceWindow.cue?["face_api"]:[]),...(appliedTextCue?["explicit_text"]:[])],channel_scores:mergedChannelScores,face_cue:faceWindow.cue,face_samples:faceWindow.count,text_cue:appliedTextCue,raw_fused_scores:fusedScores,feedback_scores:feedbackScores,pooled_scores:pooledScores});$("xAffect").textContent=label;$("xSource").textContent=(f.status||"waiting")+" · multimodal ensemble";
    $("dpLabel").textContent=label==="uncertain"?"Still uncertain":label;const st=$("dpStatus");if(st){const hints={"未检测到单个人脸":"No face signal · using available audio/text models","未检测到语音":"No speech signal · using available face/text models","未转写出文字":"No transcript · using available face/voice models","模型没有输出可用标签":"No emotion candidate available"};st.textContent=mainEmotion&&!noEmotion.has(mainEmotion)?`${feedbackStrength} affect cue · exploratory estimate`:(hints[f.demo_status]||"No clear estimate in this window");}
    const p=curPhase();if(p&&p.kind==="chat"){if(S.condition==="direct")$("directPanel").classList.remove("hidden");if(fromAnswerWindow&&S.condition!=="none"&&label!==S.lastFeedbackLabel){log("feedback_render",{raw_feedback_label:rawEmotionLabel,displayed_feedback_label:label,feedback_label:label,feedback_condition:S.condition,strategy_target:strategyTarget,condition_target:strategyTarget,strategy_stimulus_delivered:S.strategyStimulusDelivered,target_prior_eligible:targetPriorEligible,target_prior_applied:targetPriorApplied,model_status:f.status});S.lastFeedbackLabel=label;}}
  }
  function setAiEmotion(label, animated = true) {
    const term=String(label||"").toLowerCase().split(/[, +]/)[0].trim();
    const aliases={frustration:"anger",angry:"anger",irritated:"anger",annoyed:"anger",annoyance:"anger",disapproval:"anger",embarrassment:"shame",happy:"happiness",joy:"happiness",amused:"happiness",amusement:"happiness",interested:"interest",curious:"interest",curiosity:"interest",sad:"sadness",disappointment:"sadness",anxiety:"fear",anxious:"fear",nervousness:"fear",disgusted:"disgust",surprised:"surprise",admiration:"pride"};
    const allowed=new Set(["anger","shame","pride","happiness","interest","sadness","fear","disgust","surprise"]);
    const emotion=allowed.has(aliases[term]||term)?(aliases[term]||term):"neutral";
    const assets={neutral:"neutral",anger:"angry",shame:"embarrassed",pride:"proud",happiness:"joyful",interest:"curious",sadness:"sad",fear:"anxious",disgust:"unimpressed",surprise:"surprised"};
    $("botTile").dataset.emotion=emotion;
    const image=$("avatarFace");
    if(image){image.src=`vendor/minicons-animated/${animated?assets[emotion]:"neutral-static"}.svg`;image.alt=`Alex's ${emotion} expression${animated?"":" (still while you speak)"}`;}
  }
  function renderSubtitleTint(label){const neg=/anger|frustrat|shame|sad|fear|anx|disgust|irritat/i.test(label),pos=/pride|happ|joy|interest|curios/i.test(label),root=document.documentElement.style;root.setProperty("--sub-hue",neg?8:pos?38:230);root.setProperty("--sub-sat",neg||pos?"38%":"12%");root.setProperty("--sub-light","95%");root.setProperty("--sub-border",".38");$("subtitle").classList.remove("pulse");}
  function clearSubtitleTint(){const root=document.documentElement.style;for(const key of ["--sub-hue","--sub-sat","--sub-light","--sub-border"])root.removeProperty(key);$("subtitle").classList.remove("pulse");}
  function renderDirect() { /* Stage 2 produces labels, not calibrated probabilities. */ }

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = 224; frameCanvas.height = 168;
  // ------------------------------------------------------------------
  // Stop / end / export
  // ------------------------------------------------------------------
  function askDialog({ title, body, ok, cancel = "Cancel", input = false, tone = "primary" }) {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "modal-layer";
      layer.innerHTML = `<div class="modal" role="${input ? "dialog" : "alertdialog"}" aria-modal="true" aria-labelledby="mdTitle" aria-describedby="mdBody">
        <h2 id="mdTitle"></h2><p id="mdBody"></p>
        ${input ? '<input id="mdInput" type="text" autocomplete="off" aria-labelledby="mdTitle" />' : ""}
        <div class="modal-actions"><button type="button" class="btn btn-quiet" data-a="no"></button><button type="button" class="btn btn-${tone}" data-a="yes"></button></div></div>`;
      layer.querySelector("#mdTitle").textContent = title;
      layer.querySelector("#mdBody").textContent = body || "";
      layer.querySelector('[data-a="no"]').textContent = cancel;
      layer.querySelector('[data-a="yes"]').textContent = ok;
      const prev = document.activeElement;
      const finish = (v) => { layer.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); resolve(v); };
      const yes = () => finish(input ? layer.querySelector("#mdInput").value : true);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(input ? null : false); }
        if (e.key === "Enter" && input && document.activeElement && document.activeElement.id === "mdInput") { e.preventDefault(); yes(); }
        if (e.key === "Tab") {   // keep focus inside the dialog
          const f = [...layer.querySelectorAll("button, input")];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      };
      layer.querySelector('[data-a="no"]').onclick = () => finish(input ? null : false);
      layer.querySelector('[data-a="yes"]').onclick = yes;
      layer.addEventListener("click", (e) => { if (e.target === layer) finish(input ? null : false); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(layer);
      (input ? layer.querySelector("#mdInput") : layer.querySelector('[data-a="no"]')).focus();
    });
  }

  $("btnStop").onclick = async () => {
    log("stop_button_pressed");
    const yes = await askDialog({ title: "Stop the session?", body: "You can stop at any time. There's no penalty for stopping.", ok: "Stop session", cancel: "Keep going" });
    if (yes) endSession("participant_stopped"); else log("stop_cancelled");
  };

  function endSession(reason) {
    if (S.ended) return;
    const p = curPhase();
    if (p) {
      if (p.kind === "chat") flushUtterance("session_end");
      log("phase_end", { elapsed_s: +S.phaseElapsed.toFixed(2), interrupted: reason !== "completed" });
    }
    clearProbe("session_end");
    hideNotice();
    log("session_end", { reason, n_probes_answered: S.probes.filter((x) => x.status === "answered").length });
    S.ended = true;
    stopClientFaceCueDetector();
    if (frameTimer) clearInterval(frameTimer); frameTimer = null;
    if (emotionProcessor) { emotionProcessor.disconnect(); emotionProcessor.onaudioprocess = null; emotionProcessor = null; }
    if (audioSource) { audioSource.disconnect(); audioSource = null; }
    if (emotionCtx) { emotionCtx.close().catch(() => {}); emotionCtx = null; }
    if (emotionToken) { fetch("/api/emotion/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_token: emotionToken }) }).catch(() => {}); emotionToken = null; }
    setListening(false);
    stopSpeaking("session_end");
    window.speechSynthesis && speechSynthesis.cancel();
    flushLog();
    if (reason !== "completed") {
      $("endTitle").textContent = "Session stopped";
      $("endText").textContent = "Thank you for your time. The researcher will be with you in a moment.";
    }
    document.querySelector(".exp-strip-label").textContent = HOSTED
      ? (S.serverInfo && S.serverInfo.log_dir ? "For the researcher. This demo session is saved privately to your account, under Sessions and review." : "For the researcher. Sign in to Claude to keep demo sessions; you can still download this one.")
      : S.serverOk
      ? `For the researcher. This session was also saved automatically to data/${S.pid.replace(/[^A-Za-z0-9_-]/g, "_")}.`
      : "For the researcher. The local server wasn't reachable, so download the data now.";
    $("exportBox").classList.remove("hidden");
    showScreen("screen-end");
  }

  $("btnShowDebrief").onclick = () => { $("debrief").classList.remove("hidden"); $("exportBox").classList.add("hidden"); log("debrief_shown"); flushLog(); };
  $("btnExport").onclick = exportAll;

  async function exportAll() {
    const stamp = new Date(S.startEpoch).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = `${S.pid}_${S.condition}_${stamp}`;
    const full = JSON.stringify({
      pid: S.pid, condition: S.condition, order: S.order, start_epoch_ms: S.startEpoch,
      events: S.events, affect_samples: S.affect, probes: S.probes, transcript: S.transcript,
    }, null, 1);
    if (HOSTED) {   // each hosted download asks the viewer, so offer the two files that matter, one after the other
      await download(`${base}_full.json`, full, "application/json");
      await download(`${base}_probes.csv`, toCSV(S.probes.map(flat)));
      return;
    }
    download(`${base}_full.json`, JSON.stringify({
      pid: S.pid, condition: S.condition, order: S.order, start_epoch_ms: S.startEpoch,
      events: S.events, affect_samples: S.affect, probes: S.probes, transcript: S.transcript,
    }, null, 1), "application/json");
    download(`${base}_events.csv`, toCSV(S.events.map(flat)));
    download(`${base}_affect.csv`, toCSV(S.affect.map(flat)));
    download(`${base}_probes.csv`, toCSV(S.probes.map(flat)));
    download(`${base}_transcript.csv`, toCSV(S.transcript));
  }
  function flat(o, pre = "", out = {}) {
    for (const [k, v] of Object.entries(o)) {
      if (k === "system_prompt") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v, pre + k + ".", out);
      else out[pre + k] = Array.isArray(v) ? v.join("|") : v;
    }
    return out;
  }
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = [...new Set(rows.flatMap(Object.keys))];
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  }
  function download(name, text, type = "text/csv") {
    if (HOSTED) return H.save(name, text, type).catch((e) => {
      if (e && e.code !== "declined") toast("The download didn't start. Try again in a moment.");
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------------
  // Experimenter panel + shortcuts
  // ------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); $("expPanel").classList.toggle("hidden"); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "x") { e.preventDefault(); if (S.startPerf) endSession("experimenter_emergency_stop"); }
  });
  $("expClose").onclick = () => $("expPanel").classList.add("hidden");
  $("xSkip").onclick = () => { log("experimenter_skip_phase"); nextPhase(); };
  $("xPause").onclick = () => {
    S.paused = !S.paused; log(S.paused ? "experimenter_pause" : "experimenter_resume");
    $("xPause").textContent = S.paused ? "Resume" : "Pause";
  };
  $("xMarker").onclick = async () => {
    const m = await askDialog({ title: "Add a marker", body: "A short note saved with the current time, for example 'participant coughed'.", ok: "Add marker", input: true });
    if (m != null && m.trim()) { log("experimenter_marker", { note: m.trim() }); toast("Marker added."); }
  };
  $("xProbeNow").onclick = () => showProbe("manual");
  $("xAbort").onclick = async () => {
    if (await askDialog({ title: "End the session now?", body: "The participant goes to the end screen. Data recorded so far is kept.", ok: "End session", tone: "danger-solid" })) endSession("experimenter_ended");
  };

  // ------------------------------------------------------------------
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  }
  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 4000);
  }

  // Expose for debugging / automated checks
  window.__AE = { S, handleUser, showProbe, nextPhase, endSession, generateReply, get engine() { return engine; } };
})();
