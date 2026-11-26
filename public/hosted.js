// =====================================================================
// Affective Echoes — hosted demo adapter (claude.ai artifact)
//
// Loaded only in the hosted build. It stands in for the local Python
// server so the same app files run as a Claude artifact:
//   /api/health, /api/chat      -> Claude via the `sample` capability
//   /api/log, /api/sessions,
//   /api/session                -> the artifact's private per-viewer `db`
//   downloads                   -> the `downloads` capability
//   Alex's voice                -> the `tts` capability (falls back to the browser voice)
//   participant speech          -> push-to-talk via the `dictation` capability
// The camera is not available to hosted pages, so the hosted demo
// estimates affect from the participant's words only.
// =====================================================================
(function () {
  window.AE_HOSTED = true;
  if (!document.documentElement.lang) document.documentElement.lang = "en";   // the platform wrapper doesn't set it

  const H = (window.AE_HOST = { sample: null, db: null, user: null, uid: null, tts: null, dict: null, downloads: null, perms: null });
  const use = (name) => (window.claude && window.claude.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
  H.ready = (async () => {
    const [sample, db, user, tts, dict, downloads, perms] = await Promise.all(
      ["sample", "db", "user", "tts", "dictation", "downloads", "permissions"].map(use));
    Object.assign(H, { sample, db, user, tts, dict, downloads, perms });
    try { H.uid = user ? await user.id() : null; } catch (e) { H.uid = null; }
    if (!H.uid) H.db = null;               // sessions are stored privately per viewer
    window.dispatchEvent(new Event("ae-host-ready"));
    return H;
  })();

  // Ask for Claude replies and Claude's voice in one dialog, at the start of a session
  H.requestUpfront = () => {
    if (!H.perms) return;
    try { H.perms.request(["sample", "tts"]); } catch (e) { /* consent will be asked on first use */ }
  };

  // ---------------- downloads ----------------
  H.save = async (filename, text, type = "text/plain") => {
    if (!H.downloads) throw { code: "unavailable" };
    const data = new Blob([text], { type });
    return H.downloads.save({ filename, data });
  };

  // ---------------- session storage (private per viewer) ----------------
  const safe = (s) => String(s || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "unknown";
  const sessions = new Map();            // sid -> {meta, buf, bufBytes, seq, lastFlush, dirtyMeta}
  let queue = Promise.resolve();         // one store write at a time
  const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.warn("[hosted db]", e && (e.code || e.message || e))));
  const col = () => H.db.collection("data/users/" + H.uid);

  function sessionFor(pid, startMs) {
    const sid = `${safe(pid)}_${Math.round(startMs || Date.now())}`;
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        sid, buf: [], bufBytes: 0, seq: 0, lastFlush: Date.now(), lastMeta: 0, metaDirty: true,
        meta: { file: sid, pid, start_epoch_ms: startMs, probes_answered: 0, probes_missed: 0, interruptions: 0,
                user_messages: 0, phases_done: 0, ended: null, last_t: 0, updated_ms: Date.now() },
      });
    }
    return sessions.get(sid);
  }
  function absorb(s, ev) {
    const m = s.meta;
    m.last_t = Math.max(m.last_t, ev.t_session_s || 0);
    switch (ev.type) {
      case "session_start":
        Object.assign(m, { condition: ev.condition, order: ev.order, speed: ev.speed, llm: ev.llm,
          checklist: ev.checklist, demo: !!ev.demo, simulated: !!ev.simulated, hosted: true });
        s.metaDirty = true; break;
      case "session_end": m.ended = ev.reason; s.metaDirty = true; break;
      case "probe_response": m.probes_answered++; s.metaDirty = true; break;
      case "probe_missed": m.probes_missed++; s.metaDirty = true; break;
      case "bot_interrupted": m.interruptions++; break;
      case "user_message": m.user_messages++; break;
      case "phase_end": m.phases_done++; s.metaDirty = true; break;
    }
  }
  function flush(s, force) {
    if (!H.db) return;
    const now = Date.now();
    if (s.buf.length && (force || s.bufBytes > 110000 || now - s.lastFlush > 15000)) {
      const events = s.buf.splice(0); s.bufBytes = 0; s.lastFlush = now;
      const seq = s.seq++;
      enqueue(() => col().doc(s.sid).collection("chunks").doc(String(seq).padStart(5, "0")).set({ seq, events }));
    }
    if (s.metaDirty && (force || now - s.lastMeta > 5000)) {
      s.metaDirty = false; s.lastMeta = now; s.meta.updated_ms = now;
      const meta = JSON.parse(JSON.stringify(s.meta));
      enqueue(() => col().doc(s.sid).set(meta));
    }
  }
  setInterval(() => sessions.forEach((s) => flush(s, false)), 5000);
  window.addEventListener("pagehide", () => sessions.forEach((s) => flush(s, true)));

  // ---------------- /api/* shim ----------------
  const realFetch = window.fetch.bind(window);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  async function api(url, init) {
    await H.ready;
    const path = url.split("?")[0];
    const body = init && init.body ? JSON.parse(init.body) : {};

    if (path === "/api/health") {
      return json({ ok: true, hosted: true, lsl: false,
        llm: H.sample ? { provider: "hosted", model: "Claude" } : null,
        log_dir: H.db ? "your private session list" : null });
    }

    if (path === "/api/chat") {
      if (!H.sample) return json({ error: "unavailable" }, 503);
      const input = [
        { role: "user", content: `<instructions>\n${body.system}\n</instructions>\n\nYou are Alex in the conversation that follows. Reply with Alex's next spoken line only: no quotation marks, no stage directions, no name label.` },
        ...(body.messages || []),
      ];
      try {
        const r = await H.sample(input, { modelTier: "quick", cache: false });
        return json({ text: r.text.trim().replace(/^Alex:\s*/i, "") });
      } catch (e) {
        return json({ error: (e && e.code) || "error" }, 502);
      }
    }

    if (path === "/api/log") {
      const s = sessionFor(body.pid, body.session_start_epoch_ms);
      for (const ev of body.events || []) {
        absorb(s, ev);
        s.buf.push(ev);
        s.bufBytes += 220 + (ev.text ? ev.text.length : 0);
      }
      const ended = (body.events || []).some((e) => e.type === "session_end");
      flush(s, ended);
      return json({ ok: true, n: (body.events || []).length, saved: !!H.db });
    }

    if (path === "/api/sessions") {
      if (!H.db) return json({ sessions: [], storage: false });
      try {
        const snap = await col().get();
        const list = snap.docs.map((d) => d.data()).filter((m) => m && m.file);
        // include anything still buffered in this tab
        sessions.forEach((s) => { if (!list.some((m) => m.file === s.sid)) list.push({ ...s.meta }); });
        list.sort((a, b) => (b.start_epoch_ms || 0) - (a.start_epoch_ms || 0));
        return json({ sessions: list });
      } catch (e) { return json({ error: (e && e.code) || "unavailable" }, 503); }
    }

    if (path === "/api/session") {
      const sid = new URLSearchParams(url.split("?")[1] || "").get("file") || "";
      if (!H.db || !/^[A-Za-z0-9_-]+$/.test(sid)) return json({ error: "session not found" }, 404);
      try {
        const snap = await col().doc(sid).collection("chunks").orderBy("seq").get();
        let events = snap.docs.flatMap((d) => (d.data() && d.data().events) || []);
        const live = sessions.get(sid);
        if (live) events = events.concat(live.buf);
        if (!events.length) return json({ error: "session not found" }, 404);
        events.sort((a, b) => (a.t_session_s || 0) - (b.t_session_s || 0));
        return json({ file: sid, events });
      } catch (e) { return json({ error: (e && e.code) || "unavailable" }, 503); }
    }

    return json({ error: "not found" }, 404);
  }

  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input && input.url;
    if (url && url.startsWith("/api/")) return api(url, init);
    return realFetch(input, init);
  };

  // ---------------- hosted-only presentation ----------------
  const css = `
    .hosted-flag { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; background: var(--harbor-tint); color: var(--harbor-hover); font-size: var(--t-sm); line-height: 1.45; border: 1px solid var(--hair); }
    .hosted-flag strong { font-weight: 700; }
    .self-tile.no-camera { display: grid; place-items: center; background: #1c252c; }
    .self-tile.no-camera video { display: none; }
    .self-tile.no-camera .no-cam { color: #9aa7b0; font-size: 12.5px; text-align: center; padding: 0 16px; line-height: 1.45; }
    .preview-box.no-camera .preview-empty span::after { content: " is off in the hosted demo"; }
    .rv .lib-grid { grid-template-columns: 1fr; }
    .rv .balance { display: none; }
    .mic.dictating { background: var(--harbor); color: var(--on-dark); border-color: var(--harbor); box-shadow: 0 0 0 5px rgba(42,74,99,.16); }
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function adjustDom() {
    const $ = (s) => document.querySelector(s);
    // Console
    const head = $(".setup-head > div");
    if (head) {
      const f = document.createElement("p"); f.className = "hosted-flag";
      f.innerHTML = "<span><strong>Hosted demo.</strong> Runs on your Claude account. The camera isn't available here, so affect is estimated from the participant's words. Use the local app for real sessions.</span>";
      head.appendChild(f);
    }
    const tile = $(".self-tile");
    if (tile) {
      tile.classList.add("no-camera");
      const s = document.createElement("span"); s.className = "no-cam";
      s.textContent = "Camera is off in the hosted demo";
      tile.appendChild(s);
    }
    const pb = $(".preview-box"); if (pb) pb.classList.add("no-camera");
    const tb = $("#btnTestDevices"); if (tb) tb.lastChild.textContent = "Check speech input";
    const dpSub = $(".dp-head p"); if (dpSub) dpSub.textContent = "Estimated from your words";
    const steps = document.querySelectorAll(".steps li");
    if (steps[1]) steps[1].innerHTML = "<strong>Short conversations.</strong> Speak with Alex as you would on a video call. Replies must be spoken; typing is disabled. Press the microphone to speak, then press it again when you're done.";
    const rail = $(".rail-note"); if (rail) rail.innerHTML = "Sessions save privately to your account on this page, and can be downloaded at the end.";
    // Review
    const ex = $("#btnExample"); if (ex) ex.classList.remove("hidden");
    // Links back to the console: the artifact's main page
    document.querySelectorAll('a[href="index.html"]').forEach((a) => a.setAttribute("href", "./"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", adjustDom); else adjustDom();
})();
