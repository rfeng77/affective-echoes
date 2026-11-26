# Affective Echoes — study chatbot

A local web app that runs the full Affective Echoes session: a video-call style
conversation with an AI partner ("Alex"), real-time multimodal affect detection,
the three feedback conditions, the Neutral, Anger and Pride response strategies, in-chat emotion
probes, and time-stamped logging for alignment with EmotiBit / EEG.

It has three views, linked from the sidebar (or the bottom bar on a phone):

| View | Address | For |
|---|---|---|
| **Run a session** | `http://localhost:8000` | The experimenter console and the participant session |
| **Sessions and review** | `/review.html` | Browsing saved sessions and exploring each one |
| **Project overview** | `/overview.html` | Explaining the study to judges, mentors and visitors |

### Interface design

The interface is designed to look polished without becoming part of the stimulus:

- **Restrained palette.** Participant screens use cool, low-saturation greys and one
  muted blue for actions. Subtitle color and the AI emoji face respond to emotion only in
  the other-mediated condition. Participant screens don't use red, including on Stop.
- **Static rest and break screens.** They have no breathing or pulsing animation, because
  paced breathing would change the heart-rate data EmotiBit records.
- **Identical for every participant.** The app ignores the computer's dark-mode setting.
- **Legible type.** Atkinson Hyperlegible Next was designed by the Braille Institute for
  at-a-glance reading, which suits live subtitles. JetBrains Mono is used for numbers and
  IDs on researcher screens only. Both are bundled in `public/vendor/fonts` under the SIL
  Open Font License, so the app also looks right offline.
- **Comfortable on any device.** Tap targets are at least 44 px, hover effects only apply
  on devices with a mouse, and motion is switched off for people who've asked their
  computer to reduce it.
- **Alex uses native animated face artwork.** The mouth belongs to each illustration; there is no
  separately overlaid mouth. Expression artwork changes only in Other-mediated projection, and
  Alex's face is static while the participant speaks.
- **Preview the expression artwork:** open `/emotion-preview.html` while the local server is
  running. The animated SVG faces are stored locally under their MIT license.
- **Experimenter vs participant.** Experimenter areas (setup sidebar, end-screen strip,
  Ctrl+Shift+E panel) use a dark graphite treatment, so it's obvious which screens are
  meant for whom.
- **Setup console.** Shows the protocol as a timeline sized by duration, plus a system
  check of the server, language model, speech recognition, face model, camera and a live
  microphone meter.
- **Session progress bar.** The participant's top bar shows how far through the session
  they are, and never names the strategy in each part.

---

## 1. Quick start (lab PC, Windows)

Everything ships in one zip: the app, a portable Python, the llama.cpp engine and the
built-in AI model (Llama 3.2 3B). **Nothing to install, no API key, no Ollama.**

1. Download **Affective-Echoes-Windows-v….zip** from the project's GitHub **Releases** page.
2. Right-click it → **Extract All** → open the **Affective-Echoes** folder.
3. Double-click **Start Affective Echoes (Windows).bat**. Your browser opens the console.
4. Wait for **Language model** in the console's system check to turn green (up to a minute
   the first time while the model loads into memory). Use **Chrome or Edge**.

Keep the black window open during the session; close it to stop. If Windows SmartScreen
warns about the .bat file, click **More info** → **Run anyway**.

**Computer requirements:** Windows 10 or 11 (64-bit), 8 GB of RAM or more, about 3 GB of
disk space, webcam and microphone. A graphics card is used automatically when there is one
(Vulkan); otherwise the model runs on the processor. Replies take about 2–10 seconds.

> Participant replies are voice-only; typing is disabled. In the integrated Mac setup,
> speech-to-text and multimodal emotion detection use the local Whisper and Light-MER service.

For emotion-modulated feedback, participants are asked to speak for at least ten seconds before
ending each answer. The microphone keeps listening if they try to finish early, while the Stop
button remains available at all times. The multimodal estimate combines Light-MER with local
face-expression, conversational-text, and voice-emotion models. It pools up to four short model
windows from the same answer to reduce label flicker, then surfaces the strongest non-neutral cue
as subtle unless repeated windows or independent channels support it. The raw fused winner and
per-channel scores are retained separately for review. These are exploratory estimates, not
verified statements about a participant's feelings. Adjust
`affect.minFeedbackSeconds` in `public/config.js` if the study protocol requires a different
minimum.

### Running from source (developers)

Requirements: Python 3.9+, Chrome. From the project folder: `python server.py`.
The console then offers **Download model** (2 GB, one time). The llama.cpp engine isn't in
the repository; either build the release (section 10), copy `bin/llama/` from a release zip,
or install llama.cpp so `llama-server` is on your PATH.

**Choosing the language model** (`.env` file next to `server.py`, see `.env.example`):

| Setting | Effect |
|---|---|
| `AE_LLM=auto` (default) | Built-in model if its files are present, otherwise a cloud key below, otherwise offer the download |
| `AE_LLM=local` | Built-in model only |
| `AE_LLM=cloud` | `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` + `OPENAI_BASE_URL` (works with Ollama) |
| `AE_LLM=off` | Scripted lines only |
| `AE_LLM_BACKEND=cpu` | Skip the graphics card (if a GPU driver misbehaves) |
| `AE_MODEL_PATH=…` | Use a different `.gguf` model file |

Optional extras: `pip install pylsl` (LSL markers for LabRecorder); your own affect model,
see §7.

---|---|---|
| LSL markers | `pip install pylsl` | Event markers stream `AffectiveEchoesMarkers` for LabRecorder |
| Your own affect model | `pip install websockets` then `python model_server_stub.py` | Replaces built-in estimates (see §7) |

Without an API key the app still runs, using the scripted fallback lines in `config.js`.

> The integrated local emotion detector is currently started by the Mac launcher from the
> sibling `emotion_detector` folder. The detector and local Whisper must report ready before
> a participant session can start; typing is disabled.

---

## 2. Running a session

1. **Setup screen (experimenter)** — enter Participant ID, pick the feedback condition,
   choose the block order (default: counterbalanced by participant ID between Anger→Pride
   and Pride→Anger), click **Test camera and microphone**, then **Start session**.
   - **Suggested next participant:** the console suggests the next ID and the condition
     with the fewest completed sessions, so groups stay balanced. **Use suggestion** fills
     both in. Demos and simulated sessions don't count.
   - **Before you start checklist:** consent, EmotiBit, EEG/LabRecorder and headphones.
     Ticked items are saved with the session. If consent, EmotiBit or EEG is unticked,
     the first click on Start only warns you, and a second click (**Start anyway**) starts.
   - Closing or reloading the tab mid-session asks for confirmation first.
2. **Instructions** — participant reads them (includes the "attend to your emotions"
   instruction and exit rules) and clicks *I'm ready*.
3. The protocol then runs automatically:

| Phase | Duration | Bot strategy | Probes |
|---|---|---|---|
| Resting baseline (fixation cross) | 1 min | — | no |
| Practice | 2 min | Neutral | no |
| **Block × 2** (one per Anger / Pride): | | | |
| ↳ Neutral baseline | 1 min | Neutral | no |
| ↳ Condition interaction | 10 min | Anger *or* Pride, with several topics | every 60–120 s (random) |
| ↳ Neutral recovery | 1 min | Neutral | no |
| ↳ Break (not after last block) | 1 min | — | no |

App time ≈ 28 min; pre/post questionnaires make up the rest of the 65–75 min.

**Screen layout:** Alex's emoji-style face is the main view. Subtitles appear below it,
and the participant's camera appears in a smaller tile in the side column. The emoji face
only changes expression in the other-mediated condition; in the other conditions only its
mouth moves while speaking. A small status tag shows *Speaking*, *Listening…*, *Thinking…*
or *Paused*. A thin bar at the top shows how
far through the session the participant is, without naming any strategy. On a phone,
check-ins slide up from the bottom of the screen.

**Transition notices:** 30 s before each break, and before the session ends, a calm banner
slides in at the top of the conversation screen ("A short break is coming up in about 30
seconds. Feel free to finish your thought."). During that window Alex doesn't start new
topics and no check-ins appear, and in the last 8 s Alex doesn't start a new reply, so the
participant isn't cut off mid-sentence. On the break screen, a line appears 15 s before
the next conversation starts.

4. **End screen** — click **Download data**, then **Show debrief to participant**.

**Hidden experimenter panel:** `Ctrl+Shift+E` — live affect estimate, current phase,
next-probe countdown, and buttons for skip phase / pause / add marker / probe now / end.
**Emergency stop:** `Ctrl+Shift+X`. The participant's **Stop** button is always visible.

**Piloting:** set *Time scale* to 5× or 20× and tick the skip boxes to run through quickly.

---

## 3. Reviewing sessions

Open **Sessions and review** (`/review.html`) while the server is running.

**Library:**
- Lists every session in `data/`, with its condition, date, length, check-ins answered,
  interruptions and status. Filter by condition, search by participant ID, or hide demos.
  On a phone the table becomes stacked cards.
- **Condition balance** counts completed real sessions per condition and says which
  condition to assign next.
- **Open a downloaded file** loads a `_full.json` or `.jsonl` file without the server,
  for example on another computer.

**Session view:**
- **Summary:** length, check-ins answered, mean agreement, report–estimate correlation for
  pleasantness and activation, and interruptions.
- **Affect over the session:** the system's estimated pleasantness and activation as lines,
  each check-in's reported values as dots (rescaled to −1…+1), and the Anger, Pride,
  rest and break periods shaded behind them. Hover for exact values; click to jump the
  transcript to that moment.
- **Check-ins:** each report next to the estimate averaged over the 30 s before the
  check-in appeared (the window in the analysis plan), with an agreement score.
- **Transcript:** everything said, grouped by part, including interruptions and speech cut
  off by a check-in. You can filter it to one part.
- **CSV exports** of the check-ins (with the 30-second estimates) and the affect samples.

> The agreement figures compare reports with the app's own face, voice and word estimate.
> The study's planned analysis compares reports with EmotiBit and EEG, which are recorded
> outside this app.

### Simulated sessions (for training and walkthroughs)

```bash
python tools/simulate_session.py          # writes 3 sessions, one per condition
python tools/simulate_session.py --n 6
python tools/simulate_session.py --clean  # removes them all
```

These write **clearly labelled simulated sessions** (IDs `SIM-001`…), so the review view
can be explored before any real participant has taken part. They're tagged *Simulated*,
excluded from condition balance and suggestions, and their affect signal is generated, not
measured. Remove them with `--clean` before real data collection.

### Project overview page

`/overview.html` explains the study for judges and visitors. Its main feature is a live
preview: drag a point on a pleasantness × activation grid and see exactly what a
participant would see in each feedback condition. The page also covers the session flow,
the system's parts with Alex's response styles, and the design choices that keep the
interface from becoming part of the stimulus.

---

## 4. The three feedback conditions

| Condition | What the participant sees |
|---|---|
| **Other-mediated projection** | Alex speaks the ordinary reply. A local rule rewrites only its subtitle with emotional phrasing, punctuation and emoji, while Alex's animated face expresses the selected affect cue. No spoken emotion attribution or label is shown. |
| **Direct feedback** | A panel shows the selected emotion cue. Alex's animated neutral face remains neutral while speaking. |
| **No feedback** | No affect display or emotion-styled subtitle. Alex's animated neutral face remains neutral while speaking. |

The same local face, voice, transcript and Light-MER models process answer windows in all
conditions. Press the microphone to start answering and press it again to finish; Alex waits for
the answer before responding. Local Whisper supplies the English transcript. Face-api.js runs in
the browser only after the camera is enabled, and its expression scores are pooled with the
Light-MER answer windows. A sensitivity-first threshold allows weak, sustained facial cues such as
a small smile to affect the next response; these exploratory labels can be wrong and are not
calibrated probabilities. Only the answer's selected affect cue styles Alex's next subtitle and
face in Other-mediated. The active induction target is logged separately and can influence the
displayed cue only after Alex completes a strategy-specific stimulating reply; raw estimates remain
available in the event log. The Minicons Animated SVG assets are included locally under the MIT
License; see `public/vendor/minicons-animated/NOTICE.txt`. Build-5
continues to save its transcript and event logs locally. In the Mac setup, keep the
`emotion_detector` folder beside `affective-echoes-build-5`; its launcher starts the local
service on `127.0.0.1:8770` if it is not already running. Camera and microphone processing
starts only after the researcher clicks **Start session**; answer audio is sent for analysis
only while the participant has the microphone button active.

---

## 5. Response strategies

Defined in `public/config.js` → `strategies`. The experiment now has two emotional strategies:
issue-focused Anger and specific, enthusiastic Pride; Neutral is used for practice, baseline and
recovery. The same spoken strategy is used in every feedback condition; only the feedback display
differs. Each strategy also has a **fallback** bank used if the LLM is unreachable. Alex never
criticizes the participant personally, and the participant can stop at any time.
Every bot message is logged with the strategy and engine (`llm` / `scripted` / `fixed`) that
produced it, and LLM messages include the exact system prompt used.

Each topic stays active for at least six completed participant-answer / AI-reply rounds. Alex
follows up on the participant's answer throughout those rounds, then opens another topic within
the same emotion block. A pause does not trigger a topic change. The 10-minute Anger and Pride
blocks are designed to allow several topics under each strategy.

**Keeping the built-in model on protocol.** The prompts were tuned against the real Llama 3.2 3B:
- **Anger:** Alex challenges the claim and asks the participant to defend it across several turns.
- **Pride:** Alex gives specific, enthusiastic praise for the participant's current contribution.
- **Anger** prompts give the model concrete examples, because a small model left to
  itself tends to soften criticism into praise.
- **Other-mediated styling:** the model generates and speaks the ordinary reply. After the
  participant finishes, local rules style only the next visible subtitle and change the emoji
  face. The app does not ask the chatbot to name or comment on the participant's emotion.

### Turn-taking

- **Waiting for the participant:** Alex asks a question and waits with the microphone off.
  The participant presses the mic to answer, then presses it again to submit. Local
  transcription and emotion analysis finish before Alex prepares the next reply.
- **Holding replies:** Alex never starts talking while the participant is speaking. If
  the participant adds more while a reply is being prepared, that reply is
  dropped and a new one is written that covers everything they said.
- **Pausing to listen (barge-in):** if the participant starts talking while Alex is speaking,
  Alex stops mid-sentence and listens. The full line stays in the subtitle window. Speech
  that matches Alex's own words (the mic picking up the speakers) is ignored, as are
  one-word backchannels like "yeah". **Use headphones if you can**; they remove echo
  entirely.
- All of these timings are in `config.js` → `conversation`.

### Check-ins

A check-in appears as a dialog over the chat. While it's open the chat and microphone are
**locked**, and any reply Alex was preparing waits until the check-in closes. A due check-in
waits up to 10 s for a natural gap (Alex finished speaking, participant finished talking)
before appearing.

Each question is a slider with numbered tick marks and labeled ends. Sliders start with
**no answer selected** (no handle shown) to avoid anchoring at the midpoint; the
participant clicks or drags on the line, or uses the arrow keys. **Submit** unlocks once
every slider has been set. Sliders have large handles, keyboard support and screen-reader
labels.

---

## 6. Data files

**Auto-saved by the server:** `data/<PID>/<PID>_<YYYYMMDD_HHMMSS>.jsonl` — one JSON event per line.
**Downloaded from the end screen:** `_full.json`, `_events.csv`, `_affect.csv`, `_probes.csv`, `_transcript.csv`.

Every row carries:

- `t_epoch_ms` — Unix time in ms (high-resolution, monotonic within the session). Use this
  to align with EmotiBit / EEG recorded on the **same computer**.
- `t_session_s`, `phase`, `phase_kind`, `block`, `strategy`, `condition`, `pid`
- server-side rows also have `server_recv_epoch_ms`, and `lsl_clock_s` if pylsl is installed

Key event types: `phase_start/end`, `bot_message`, `user_message`, `topic_start`,
`feedback_render` (whenever the displayed affect label changes), `probe_shown`,
`probe_response`, `probe_missed`, `tts_start/end`, `experimenter_marker`, `session_end`.

Turn-taking and transition events:
- `bot_interrupted`: the participant talked over Alex. Includes what was heard and how much of the line had been spoken.
- `reply_discarded`: the reason is `new_participant_input`, `phase_changed` or `session_end`.
- `bot_message.held_ms`: how long a ready reply waited for its turn.
- `user_message` with `cut_reason`: the participant was mid-sentence when a phase ended or a check-in opened. Their words are kept, and Alex doesn't reply.
- `transition_notice_shown` and `resume_notice_shown`.
- `probe_skipped`: the phase was ending.
- `input_blocked_checkin`.

Probe rows also include `deferred_ms` (how long the check-in waited for a gap) and
`<item>_n_changes` (how many times each slider was moved).

`affect.csv` holds a fused sample every 500 ms: `valence`, `arousal` (−1…1), `intensity`,
`label`, `source`, plus the per-channel values (face V/A + confidence + 7 expression
probabilities, voice arousal/dB/pitch, text V/A).

`probes.csv`: `valence` (1–9), `arousal` (1–9), `awareness` (1–7), RTs, shown/answered
times, and the affect estimate at the moment the probe appeared — the anchor for the
"30 s before each probe" windows in the analysis plan.

---

## 7. Affect detection & plugging in your CMU-MOSEI model

Built-in (in `public/affect.js`, runs in the browser):

- **Face** — face-api.js tiny face detector + 7-class expression net, mapped onto the
  valence/arousal circumplex.
- **Voice** — loudness relative to the ambient baseline (calibrated during the resting
  phase) and pitch variability → arousal.
- **Language** — small sentiment lexicon on each transcribed utterance → valence/arousal.

These are weighted (`config.js` → `affect.weights`) and smoothed. They are a working
stand-in, **not** the CMU-MOSEI model from the proposal.

To use your own model, set `affect.useExternalModel: true` in `config.js`, run
`model_server_stub.py` and replace `MyModel.predict()`. The browser then connects to
`ws://localhost:8765`, streams webcam frames + built-in
features every 500 ms and every transcript, and uses your model's
`{valence, arousal, label, confidence}` replies instead of its own while they keep arriving.

---

## 8. Configuration cheat sheet (`public/config.js`)

| Setting | Default |
|---|---|
| `timing.*` | protocol durations in seconds |
| `probes.minIntervalSec / maxIntervalSec` | 60 / 120 |
| `probes.autoDismissSec` | 25 (unanswered probe logged as missed) |
| `probes.maxDeferSec / minRemainingSec` | 10 / 15 |
| `conversation.endOfUtteranceMs` | 2500 (silence that ends a spoken answer) |
| `conversation.minReplyDelayMs` | 1200 (extra pause before Alex replies) |
| `conversation.silenceNudgeSec` | 60 |
| `conversation.ttsRate` | 0.95 |
| `conversation.bargeIn` | true (set false to keep the mic off while Alex speaks) |
| `transitions.noticeLeadSec / quietTailSec` | 30 / 8 |
| `transitions.breakNotice / endNotice` | banner wording |
| `affect.sampleMs` | 500 |
| `topics` | 17 everyday low-risk topics |
| `conversation.minTurnsPerTopic` | 6 completed answer / reply rounds |
| `timing.blockCondition` | 10 min per strategy |
| `strategies.*.prompt / fallback` | strategy prompts and scripted lines |
| other-mediated subtitle rules | local subtitle and emoji-face styling from the participant's last clear answer emotion |
| `probeItems` | probe questions, slider range and `step` |

LLM provider and model are set in `.env` (Anthropic by default; any OpenAI-compatible
endpoint also works).

---

## 9. Notes for the research team

- **Probe interval:** the slides list both 60–120 s and 30–60 s. This build uses 60–120 s
  (one line to change in `config.js`).
- **Probe wording:** the valence and arousal items now have distinct questions ("How
  pleasant…", "How calm or activated…") so each slider has its own label. Edit `probeItems`
  if your protocol specifies exact wording.
- **Pride example:** the slide's "You're doing a lot better than the other students"
  breaks the strategy's own "no derogatory comparisons" rule, so it is excluded from the
  prompt and the prompt forbids comparisons.
- **Deception and debrief:** Anger gives critical, argument-focused replies and Pride gives
  enthusiastic praise. A short debrief screen is included; check its wording against your IRB protocol.
- Keep the browser window **full-screen and focused** during sessions — background tabs
  throttle timers.


---

## 10. Building and publishing the Windows release

The release is built by **GitHub Actions** on a Windows machine. The workflow
(`.github/workflows/build-windows.yml`):

1. downloads llama.cpp's Windows builds (CPU + Vulkan), a portable Python 3.12 and the model
   (checking its SHA-256), plus the Llama license files;
2. assembles `Affective-Echoes/` and zips it (`tools/build_windows.py`);
3. **starts the finished app with the bundled Python and requires real replies from the
   model** (`tools/smoke_test.py`), so a broken build never gets published;
4. publishes the zip, checksums and install notes on the **Releases** page.

**First time:** create a GitHub repository, upload this project (the `.gitignore` keeps out
models, data and secrets), then **Actions → Build Windows app → Run workflow**. It takes about
20–40 minutes the first time (downloads are cached after that). For a numbered release, push
a tag: `git tag v1.0.0 && git push origin v1.0.0`.

**Build on your own PC instead** (any OS with Python and internet):

```bash
python tools/build_windows.py          # -> dist/Affective-Echoes-Windows-v1.0.0.zip
python tools/smoke_test.py dist/Affective-Echoes   # on Windows: tests the built app
```

Options: `--llama-tag b6xxx` pins a llama.cpp release, `--model-path file.gguf` reuses a
downloaded model, `--no-model` makes a small zip (the app then offers the download).
GitHub limits release files to 2 GB; if the zip is larger, the build also produces a
no-model zip and the model file separately, and the release notes explain how to combine them.

**Licensing:** Llama 3.2 is redistributed under the Llama 3.2 Community License. The build
includes the license and Acceptable Use Policy in `LICENSES/`, and the app credits
"Built with Llama" (see `LICENSES/NOTICE.md`). Credit it in publications too.
