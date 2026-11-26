#!/usr/bin/env python3
"""
Write clearly labelled SIMULATED sessions into data/, so the Sessions and
review view can be explored before any real participant has taken part
(pilot training, walkthroughs, demos).

Every simulated session:
  * has a participant ID starting with SIM-
  * is marked  demo: true  and  simulated: true  in its session_start event
  * shows a "Simulated" tag in the review view
  * is excluded from the condition-balance counts and the next-participant suggestion

Usage:
  python tools/simulate_session.py            # 3 sessions, one per condition
  python tools/simulate_session.py --n 6      # more
  python tools/simulate_session.py --clean    # delete all SIM-* sessions
"""
import argparse
import json
import math
import random
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

TIMING = dict(rest=60, practice=120, base=60, cond=600, recov=60, brk=60)
CONDITIONS = ["other_mediated", "direct", "none"]
ORDERS = [["anger", "pride"], ["pride", "anger"]]
# Latent affect each strategy pushes toward (valence, arousal)
TARGET = {"neutral": (0.08, -0.05), "anger": (-0.45, 0.55), "pride": (0.5, 0.32)}
TOPICS = ["What are the differences between high school and college?", "Do you prefer large or small classes, and why?",
          "Is it better to study alone or in a group?", "What makes a good roommate?",
          "What makes group projects work well, and what usually gets in the way?",
          "What is one skill you have worked to improve, and what helped you improve it?",
          "Should college classes be recorded and posted online?", "What makes a lecture engaging?",
          "Is it better to have an early morning class or a late evening class?",
          "What is a useful way to handle a disagreement in a group?", "What makes a campus event worth attending?",
          "Should students take a gap year before college?",
          "What's more useful in college: good time management or good study skills?",
          "What is one class assignment that taught you something useful?",
          "Should students be required to take courses outside their major?",
          "What's the best way to spend a free weekend in Atlanta?", "Is it better to live on campus or off campus?"]
BOT = {
    "neutral": ["So you think that gives you more time with the professor. How many students were in your largest class?",
                "Thank you. What details make you see it that way?", "Okay. How often does that come up for you?"],
    "anger": ["No, I'm not convinced yet. Give one concrete reason and explain how it supports your point.",
              "That still does not persuade me. Try again with a specific example and make the connection clear.",
              "I still don't see a strong defense of that claim. What evidence would make your case convincing?"],
    "pride": ["That is an exceptionally sharp point—the example makes your reasoning compelling. I'm impressed. Build on it.",
              "You connected those ideas in a clear, original way. That's genuinely impressive; tell me how you arrived at it.",
              "That was a remarkably strong explanation. Your specific reason makes the point persuasive. What else follows?"],
}
USER = ["I think it depends a lot on the person, but for me smaller groups work better.",
        "Honestly I'd say the freedom is the biggest difference, you have to manage your own time.",
        "I guess because you get more chances to ask questions and actually talk.",
        "I'm not sure, I just feel like it helps me focus more.", "Well, my roommate last year was really messy, so cleanliness matters.",
        "I mean, I gave a reason, it's about being able to concentrate.", "Okay, I can try. I think it's mostly about routine.",
        "Yeah, I've thought about that before, it really depends on your major.", "Mornings are tough but I get more done."]


def simulate(pid, condition, order, seed, start_epoch_ms):
    rng = random.Random(seed)
    ev, t = [], 0.0
    base = dict(pid=pid, condition=condition)

    def add(type_, t_s, phase=None, **kw):
        e = dict(t_epoch_ms=round(start_epoch_ms + t_s * 1000, 2), t_session_s=round(t_s, 3), type=type_, **base)
        if phase:
            e.update(phase=phase["id"], phase_kind=phase["kind"], block=phase.get("block"), strategy=phase.get("strategy") or "none")
        e.update(kw)
        ev.append(e)
        return e

    phases = [dict(id="resting_baseline", kind="rest", dur=TIMING["rest"], strategy=None),
              dict(id="practice", kind="chat", dur=TIMING["practice"], strategy="neutral")]
    for i, st in enumerate(order):
        b = i + 1
        phases += [dict(id=f"b{b}_neutral_baseline", kind="chat", dur=TIMING["base"], strategy="neutral", block=b),
                   dict(id=f"b{b}_condition_{st}", kind="chat", dur=TIMING["cond"], strategy=st, block=b, cond=True),
                   dict(id=f"b{b}_neutral_recovery", kind="chat", dur=TIMING["recov"], strategy="neutral", block=b)]
        if i < len(order) - 1:
            phases.append(dict(id=f"b{b}_break", kind="break", dur=TIMING["brk"], strategy=None, block=b))

    add("session_start", 0, order=">".join(order), engine="llm", tts=True, input_mode="voice", speed=1,
        start_epoch_ms=start_epoch_ms, demo=True, simulated=True, llm="simulated",
        checklist=dict(consent=True, emotibit=True, eeg=True, headphones=True))

    v, a = 0.05, -0.1
    sensitivity = rng.uniform(0.7, 1.15)        # how strongly this simulated person reacts
    report_noise = rng.uniform(0.12, 0.25)      # how precisely they report
    topic_i, turns, probe_n = 0, 0, 0
    for ph in phases:
        add("phase_start", t, ph, duration_s=ph["dur"])
        t0, t_end = t, t + ph["dur"]
        target = TARGET.get(ph["strategy"] or "neutral", TARGET["neutral"])
        if ph["kind"] == "break":
            target = (0.1, -0.25)
        if ph["kind"] == "rest":
            target = (0.02, -0.3)
        next_turn = t + 4
        next_probe = t + rng.uniform(60, 120) if ph.get("cond") else None
        if ph["kind"] == "chat":
            turns = 0
            add("topic_start", t + 0.5, ph, topic=TOPICS[topic_i % len(TOPICS)])
            add("bot_message", t + 0.5, ph, text=("Hi, I'm Alex! Let's start with an easy one: " if topic_i == 0 else "Next topic: ") + TOPICS[topic_i % len(TOPICS)], kind="opener", engine_used="fixed")
            topic_i += 1
        while t < t_end:
            t += 0.5
            k = 0.012 if ph.get("cond") else 0.02
            tv, ta = target[0] * (sensitivity if ph.get("cond") else 1), target[1] * (sensitivity if ph.get("cond") else 1)
            # slow latent state + a little measurement noise on what the detector "sees"
            v += (tv - v) * k + rng.gauss(0, 0.012)
            a += (ta - a) * k + rng.gauss(0, 0.012)
            v, a = max(-1, min(1, v)), max(-1, min(1, a))
            ov = max(-1, min(1, v + rng.gauss(0, 0.05) + 0.04 * math.sin(t / 23)))
            oa = max(-1, min(1, a + rng.gauss(0, 0.05)))
            add("affect_sample", t, ph, valence=round(ov, 3), arousal=round(oa, 3),
                intensity=round(min(1, math.hypot(ov, oa)), 3), label="simulated", source="simulated")
            if ph["kind"] == "chat" and t >= next_turn and t < t_end - 8:
                add("user_message", t, ph, text=rng.choice(USER), input="voice")
                turns += 1
                if rng.random() < 0.12:
                    add("bot_interrupted", t + 4.2, ph, heard="wait, actually", spoken_chars=24, text_chars=70)
                add("bot_message", t + 3.8, ph, text=rng.choice(BOT[ph["strategy"]]), kind="reply", engine_used="llm", strategy_used=ph["strategy"])
                if turns % 6 == 0:
                    add("topic_start", t + 22, ph, topic=TOPICS[topic_i % len(TOPICS)])
                    add("bot_message", t + 22, ph, text="Next topic: " + TOPICS[topic_i % len(TOPICS)], kind="opener", engine_used="fixed")
                    topic_i += 1
                next_turn = t + rng.uniform(18, 30)
            if next_probe and t >= next_probe and t < t_end - 15:
                probe_n += 1
                pid_ = f"probe_{probe_n}"
                shown = add("probe_shown", t, ph, probe_id=pid_, trigger="scheduled", deferred_ms=rng.randint(0, 2500))
                if rng.random() < 0.9:
                    rv = max(1, min(9, round(5 + 4 * (v + rng.gauss(0, report_noise)))))
                    ra = max(1, min(9, round(5 + 4 * (a + rng.gauss(0, report_noise)))))
                    aw = max(1, min(7, round(3 + 3 * min(1, abs(v - target[0] * 0.3) + abs(a)) + rng.gauss(0, 0.8))))
                    rt = rng.randint(5200, 12500)
                    add("probe_response", t + rt / 1000, ph, probe_id=pid_, shown_session_s=shown["t_session_s"],
                        shown_epoch_ms=shown["t_epoch_ms"], rt_ms=rt, status="answered", valence=rv, arousal=ra, awareness=aw)
                else:
                    add("probe_missed", t + 25, ph, probe_id=pid_, shown_session_s=shown["t_session_s"], status="timeout")
                next_probe = t + rng.uniform(60, 120)
            if ph["kind"] == "chat" and abs(t - (t_end - 30)) < 0.26 and ph["id"].endswith("recovery"):
                add("transition_notice_shown", t, ph, notice="break" if ph is not phases[-1] else "end", lead_s=30)
        add("phase_end", t, ph, elapsed_s=round(t - t0, 2))
    add("session_end", t, None, reason="completed", n_probes_answered=sum(1 for e in ev if e["type"] == "probe_response"))
    ev.sort(key=lambda e: e["t_session_s"])
    return ev


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=3, help="number of simulated sessions (default 3)")
    ap.add_argument("--clean", action="store_true", help="delete all SIM-* sessions and exit")
    args = ap.parse_args()
    if args.clean:
        removed = [p for p in DATA.glob("SIM-*") if p.is_dir()]
        for p in removed:
            shutil.rmtree(p)
        print(f"Removed {len(removed)} simulated session folder(s).")
        return
    DATA.mkdir(exist_ok=True)
    now = time.time() * 1000
    for i in range(args.n):
        pid = f"SIM-{i + 1:03d}"
        start = now - (args.n - i) * 86_400_000 + 3_600_000 * (i % 5)
        events = simulate(pid, CONDITIONS[i % 3], ORDERS[i % len(ORDERS)], seed=1000 + i, start_epoch_ms=start)
        folder = DATA / pid
        folder.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(start / 1000))
        path = folder / f"{pid}_{stamp}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
        print(f"Wrote {path.relative_to(ROOT)}  ({len(events)} events, {CONDITIONS[i % 3]})")


if __name__ == "__main__":
    main()
