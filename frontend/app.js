const API_URL = "/api/chat";
const COACH_URL = "/api/coach";
const TTS_URL = "/api/tts";
const STT_URL = "/api/stt";
const STT_STREAM_PATH = "/api/stt/stream";
const SAY_URL = "/api/say";
const HEALTH_URL = "/health";
/** ElevenLabs via `POST /api/tts` when true; browser SpeechSynthesis by default. Set `VITE_USE_BACKEND_TTS=true` in `.env` to use ElevenLabs. */
const USE_BACKEND_TTS = import.meta.env.VITE_USE_BACKEND_TTS === "true";
/** Deepgram STT via `POST /api/stt` when true; browser SpeechRecognition fallback otherwise. */
const USE_DEEPGRAM_STT = import.meta.env.VITE_USE_DEEPGRAM_STT === "true";
const WEIGHT_UNIT = "kg";

let ttsObjectUrl = null;
let ttsAudioEl = null;

function revokeTtsPlayback() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  if (ttsAudioEl) {
    ttsAudioEl.pause();
    ttsAudioEl.removeAttribute("src");
    ttsAudioEl = null;
  }
  if (ttsObjectUrl) {
    URL.revokeObjectURL(ttsObjectUrl);
    ttsObjectUrl = null;
  }
}
const STORAGE = {
  regular: "jarvis-regular-v2",
  sessions: "jarvis-sessions-v2",
  active: "jarvis-active-v2",
};

const MUSCLE_DEFS = [
  { id: "chest", title: "Chest" },
  { id: "biceps", title: "Biceps" },
  { id: "back", title: "Back" },
  { id: "legs", title: "Legs" },
  { id: "shoulders", title: "Shoulders" },
  { id: "triceps", title: "Triceps" },
];

const DEFAULT_REGULAR = {
  chest: ["barbell bench press", "incline dumbbell press", "chest fly"],
  biceps: ["dumbbell bicep curl", "hammer curl", "preacher curl"],
  back: ["lat pulldown", "barbell row", "face pull"],
  legs: ["back squat", "romanian deadlift", "leg press"],
  shoulders: ["overhead press", "lateral raise", "rear delt fly"],
  triceps: ["cable pushdown", "skull crusher", "overhead tricep extension"],
};

/** Curated lists for workout-plan dropdowns (merged with saved defaults per muscle). */
const EXERCISE_OPTIONS = {
  chest: [
    "barbell bench press",
    "incline dumbbell press",
    "decline bench press",
    "dumbbell bench press",
    "chest fly",
    "cable fly",
    "push-up",
    "dip",
    "machine chest press",
  ],
  biceps: [
    "dumbbell bicep curl",
    "hammer curl",
    "preacher curl",
    "incline dumbbell curl",
    "cable curl",
    "ez-bar curl",
    "concentration curl",
    "reverse curl",
  ],
  back: [
    "lat pulldown",
    "barbell row",
    "face pull",
    "pull-up",
    "chin-up",
    "seated cable row",
    "t-bar row",
    "deadlift",
    "dumbbell row",
    "straight-arm pulldown",
  ],
  legs: [
    "back squat",
    "front squat",
    "romanian deadlift",
    "leg press",
    "leg extension",
    "leg curl",
    "bulgarian split squat",
    "hack squat",
    "calf raise",
    "walking lunge",
  ],
  shoulders: [
    "overhead press",
    "dumbbell shoulder press",
    "lateral raise",
    "rear delt fly",
    "front raise",
    "arnold press",
    "upright row",
    "face pull",
  ],
  triceps: [
    "cable pushdown",
    "rope pushdown",
    "skull crusher",
    "overhead tricep extension",
    "dip",
    "close-grip bench press",
    "single-arm pushdown",
  ],
};

function exerciseChoicesForMuscle(muscleId) {
  const defaults = DEFAULT_REGULAR[muscleId] || [];
  const extra = EXERCISE_OPTIONS[muscleId] || [];
  return [...new Set([...defaults, ...extra])].sort((a, b) => a.localeCompare(b));
}

/** Display label: canonical names are stored lowercase; UI shows sentence case. */
function formatExerciseLabel(canonical) {
  if (!canonical) return "";
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

function ensureSelectOption(selectEl, value) {
  if (!value) return;
  const exists = [...selectEl.options].some((o) => o.value === value);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = formatExerciseLabel(value);
    selectEl.appendChild(opt);
  }
}
const JARVIS_WAKE_REPLY = "Hey, I'm here. So—what are we hitting today?";

const el = {
  pageHome: document.getElementById("pageHome"),
  pageWorkout: document.getElementById("pageWorkout"),
  pageTrainer: document.getElementById("pageTrainer"),
  tabHome: document.getElementById("tabHome"),
  tabWorkout: document.getElementById("tabWorkout"),
  tabTrainer: document.getElementById("tabTrainer"),
  trainerMicDock: document.getElementById("trainerMicDock"),
  micBtn: document.getElementById("micBtn"),
  transcriptInput: document.getElementById("transcriptInput"),
  sendBtn: document.getElementById("sendBtn"),
  assistantReply: document.getElementById("assistantReply"),
  statusText: document.getElementById("statusText"),
  ttsSourceText: document.getElementById("ttsSourceText"),
  sttSourceText: document.getElementById("sttSourceText"),
  aiSourceText: document.getElementById("aiSourceText"),
  trainerExerciseCards: document.getElementById("trainerExerciseCards"),
  homeWorkoutFeed: document.getElementById("homeWorkoutFeed"),
  homeFeedEmpty: document.getElementById("homeFeedEmpty"),
  workoutMuscleStack: document.getElementById("workoutMuscleStack"),
  saveAllPlanBtn: document.getElementById("saveAllPlanBtn"),
};

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function mergeRegularFromStorage(raw) {
  const parsed = safeParse(raw || "null", null);
  const base = { ...DEFAULT_REGULAR, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  MUSCLE_DEFS.forEach(({ id }) => {
    if (!Array.isArray(base[id])) {
      base[id] = [...(DEFAULT_REGULAR[id] || ["", "", ""])];
    }
    const cleaned = base[id].map((x) => String(x || "").trim()).filter(Boolean);
    base[id] = cleaned.length ? cleaned : [...(DEFAULT_REGULAR[id] || [])];
  });
  return base;
}

const state = {
  activePage: "home",
  jarvisAwake: true,
  listening: false,
  phase: "idle",
  pendingMuscles: [],
  pendingPlanned: [],
  saveCustomAsRegular: false,
  /** When set, Live Exercise Tracker shows last-two comparison for this muscle. */
  compareView: null,
  regular: mergeRegularFromStorage(localStorage.getItem(STORAGE.regular)),
  sessions: safeParse(localStorage.getItem(STORAGE.sessions) || "[]", []),
  activeSession: safeParse(localStorage.getItem(STORAGE.active) || "null", null),
  /** null=unknown/unreachable, true=Gemini configured, false=fallback templates */
  geminiConfigured: null,
  /** "deepgram" | "browser" | "browser-fallback" | "error" */
  sttSource: USE_DEEPGRAM_STT ? "deepgram" : "browser",
  /** Bumped each processCommand — aborts TTS/play from older dispatches after interrupt */
  dispatchGeneration: 0,
};

function seedMockDataIfNeeded() {
  if (state.sessions.length) return;
  state.sessions = [
    {
      id: uid(),
      startedAt: isoDaysAgo(1),
      muscles: ["chest"],
      entries: [
        { exercise: "barbell bench press", weight: 82.5, reps: 6, createdAt: isoDaysAgo(1) },
        { exercise: "incline dumbbell press", weight: 28, reps: 10, createdAt: isoDaysAgo(1) },
      ],
    },
    {
      id: uid(),
      startedAt: isoDaysAgo(2),
      muscles: ["biceps"],
      entries: [
        { exercise: "dumbbell bicep curl", weight: 16, reps: 12, createdAt: isoDaysAgo(2) },
        { exercise: "hammer curl", weight: 18, reps: 10, createdAt: isoDaysAgo(2) },
      ],
    },
    {
      id: uid(),
      startedAt: isoDaysAgo(3),
      muscles: ["triceps"],
      entries: [
        { exercise: "rope pushdown", weight: 35, reps: 12, createdAt: isoDaysAgo(3) },
        { exercise: "overhead tricep extension", weight: 22.5, reps: 10, createdAt: isoDaysAgo(3) },
      ],
    },
  ];
}

function persist() {
  localStorage.setItem(STORAGE.regular, JSON.stringify(state.regular));
  localStorage.setItem(STORAGE.sessions, JSON.stringify(state.sessions));
  if (state.activeSession) localStorage.setItem(STORAGE.active, JSON.stringify(state.activeSession));
  else localStorage.removeItem(STORAGE.active);
}

/** @param {number | null} cmdGen If set, skip UI + TTS when a newer processCommand has superseded this one */
async function respond(text, spokenText = null, cmdGen = null) {
  if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
  el.assistantReply.textContent = text;
  const toSpeak = (spokenText ?? text).trim();
  if (!toSpeak) {
    el.ttsSourceText.textContent = USE_BACKEND_TTS ? "TTS: ElevenLabs" : "TTS: Browser";
    return;
  }
  if (USE_BACKEND_TTS) {
    try {
      revokeTtsPlayback();
      const resp = await fetch(TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: toSpeak }),
      });
      if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
      if (!resp.ok) throw new Error("tts");
      const blob = await resp.blob();
      if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
      ttsObjectUrl = URL.createObjectURL(blob);
      ttsAudioEl = new Audio(ttsObjectUrl);
      const cleanup = () => {
        ttsAudioEl?.removeEventListener("ended", cleanup);
        ttsAudioEl?.removeEventListener("error", cleanup);
        revokeTtsPlayback();
      };
      ttsAudioEl.addEventListener("ended", cleanup);
      ttsAudioEl.addEventListener("error", cleanup);
      el.ttsSourceText.textContent = "TTS: ElevenLabs";
      await ttsAudioEl.play();
      return;
    } catch {
      if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
      revokeTtsPlayback();
    }
  } else {
    revokeTtsPlayback();
  }
  if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
  const utterance = new SpeechSynthesisUtterance(toSpeak);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  el.ttsSourceText.textContent = USE_BACKEND_TTS ? "TTS: Browser (fallback)" : "TTS: Browser";
}

/**
 * Route every spoken UI reply through the backend so it gets the Jarvis coach voice.
 * If the backend is unreachable or slow (>6s), we fall back to the local string so the
 * user never gets stuck in silence.
 */
async function speak(kind, payload = {}, fallback = "", cmdGen = null) {
  // Never replace these with /api/say text — stale or wrong backends were overwriting good fallbacks.
  if (String(kind).startsWith("set_edit_") && String(fallback || "").trim()) {
    if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
    await respond(fallback.trim(), null, cmdGen);
    return;
  }
  let text = fallback || "";
  const enrich = !String(kind).startsWith("set_edit_");
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    const resp = await fetch(SAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, payload, enrich }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
    if (resp.ok) {
      const data = await resp.json();
      if (data?.reply) text = data.reply;
    }
  } catch {
    /* fall through to fallback text */
  }
  if (cmdGen != null && cmdGen !== state.dispatchGeneration) return;
  await respond(text, null, cmdGen);
}

function switchPage(page) {
  state.activePage = page;
  el.pageHome.classList.toggle("hidden", page !== "home");
  el.pageWorkout.classList.toggle("hidden", page !== "workout");
  el.pageTrainer.classList.toggle("hidden", page !== "trainer");
  el.tabHome.classList.toggle("active", page === "home");
  el.tabWorkout.classList.toggle("active", page === "workout");
  el.tabTrainer.classList.toggle("active", page === "trainer");
  el.trainerMicDock.classList.toggle("hidden", page !== "trainer");
  el.trainerMicDock.setAttribute("aria-hidden", page !== "trainer" ? "true" : "false");
}

function flattenEntries() {
  return state.sessions.flatMap((s) => s.entries || []);
}

function sessionVolume(entries) {
  return (entries || []).reduce((sum, e) => sum + (Number(e.weight) || 0) * (Number(e.reps) || 0), 0);
}

/** Group consecutive identical exercise/weight/reps for display (one row per logical block). */
function aggregateEntriesForDisplay(entries) {
  const list = entries || [];
  if (!list.length) return [];
  const out = [];
  for (const e of list) {
    const ex = e.exercise;
    const w = Number(e.weight) || 0;
    const r = Number(e.reps) || 0;
    const last = out[out.length - 1];
    if (last && last.exercise === ex && last.weight === w && last.reps === r) {
      last.count += 1;
    } else {
      out.push({ exercise: ex, weight: w, reps: r, count: 1 });
    }
  }
  return out;
}

function formatGroupedSetLine(g) {
  const name = formatExerciseLabel(g.exercise);
  if (g.count > 1) {
    return `${name} ${g.weight}${WEIGHT_UNIT} × ${g.reps} × ${g.count} sets`;
  }
  return `${name} ${g.weight}${WEIGHT_UNIT} × ${g.reps}`;
}

function deletePastSessionById(id) {
  if (!id) return;
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.sessions.length === before) return;
  clearCompareView();
  persist();
  renderHome();
  renderStatus();
}

function discardActiveWorkout(cmdGen = null) {
  if (!state.activeSession) {
    void speak("workout_no_active_discard", {}, "Nothing to discard — there's no workout running.", cmdGen);
    return;
  }
  revokeTtsPlayback();
  state.activeSession = null;
  state.phase = "idle";
  state.pendingMuscles = [];
  state.pendingPlanned = [];
  state.saveCustomAsRegular = false;
  clearCompareView();
  persist();
  renderHome();
  renderStatus();
  renderTrainerExerciseCards();
  void speak("workout_discarded", {}, "Done — that one's cleared. Nothing was saved.", cmdGen);
}

function renderHome() {
  el.homeWorkoutFeed.innerHTML = "";

  if (state.activeSession) {
    const banner = document.createElement("div");
    banner.className = "active-banner";
    const n = (state.activeSession.entries || []).length;
    banner.innerHTML = `<span class="active-banner-dot"></span><div><strong>Workout in progress</strong><span class="active-banner-sub">${n} sets logged · finish from Trainer</span></div>`;
    el.homeWorkoutFeed.appendChild(banner);
  }

  const rows = state.sessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (!rows.length) {
    el.homeFeedEmpty.classList.toggle("hidden", !!state.activeSession);
    if (!state.activeSession) return;
  } else {
    el.homeFeedEmpty.classList.add("hidden");
  }

  rows.forEach((session) => {
    const card = document.createElement("article");
    card.className = "activity-card";
    const when = new Date(session.startedAt);
    const muscles = (session.muscles || []).filter(Boolean).join(" · ") || "Workout";
    const entries = session.entries || [];
    const sets = entries.length;
    const vol = sessionVolume(entries);
    const groups = aggregateEntriesForDisplay(entries);
    const preview = groups
      .slice(0, 4)
      .map((g) => formatGroupedSetLine(g))
      .join(" · ");
    const rest =
      groups.length > 4 ? ` · +${groups.length - 4} more` : "";

    card.innerHTML = `
      <div class="activity-accent"></div>
      <div class="activity-body">
        <div class="activity-top">
          <div>
            <div class="activity-dow">${when.toLocaleDateString(undefined, { weekday: "long" })}</div>
            <div class="activity-meta">${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
          </div>
          <span class="activity-pill">${sets} sets</span>
        </div>
        <h3 class="activity-title">${muscles}</h3>
        <div class="activity-metrics">
          <div class="metric"><span class="metric-value">${vol ? Math.round(vol) : "—"}</span><span class="metric-label">${WEIGHT_UNIT}·reps vol.</span></div>
        </div>
        <p class="activity-preview">${preview || "No sets recorded"}${rest}</p>
        <div class="activity-actions">
          <button type="button" class="activity-delete" data-delete-session="${escapeHtml(session.id)}">Delete</button>
        </div>
      </div>
    `;
    el.homeWorkoutFeed.appendChild(card);
  });
}

function buildWorkoutPanels() {
  el.workoutMuscleStack.innerHTML = MUSCLE_DEFS.map((m) => {
    const choices = exerciseChoicesForMuscle(m.id);
    const optionsHtml = choices
      .map((name) => {
        const safeVal = name.replace(/"/g, "&quot;");
        const label = formatExerciseLabel(name).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        return `<option value="${safeVal}">${label}</option>`;
      })
      .join("");
    const slots = [0, 1, 2]
      .map(
        (slot) => `
      <div class="ex-slot">
        <label class="ex-slot-label" for="ex-${m.id}-${slot}">Exercise ${slot + 1}</label>
        <select id="ex-${m.id}-${slot}" class="field ex-select" data-muscle="${m.id}" data-slot="${slot}" aria-label="${m.title} exercise ${slot + 1}">
          <option value="">Choose exercise…</option>
          ${optionsHtml}
        </select>
      </div>
    `
      )
      .join("");
    return `
    <div class="muscle-panel" data-muscle="${m.id}">
      <div class="muscle-panel-head">
        <p class="muscle-panel-title">${m.title}</p>
      </div>
      <div class="stack ex-stack">${slots}</div>
    </div>
  `;
  }).join("");
}

function renderWorkoutConfig() {
  el.workoutMuscleStack.querySelectorAll(".ex-select").forEach((select) => {
    const muscle = select.dataset.muscle;
    const slot = Number(select.dataset.slot);
    const plan = state.regular[muscle] || ["", "", ""];
    const val = plan[slot] || "";
    ensureSelectOption(select, val);
    select.value = val;
  });
}

function renderStatus() {
  el.statusText.textContent = `Session: ${state.activeSession ? "Active" : "Inactive"}${
    state.listening ? " | Mic: ON" : " | Mic: OFF"
  }`;
  if (el.sttSourceText) {
    const sttLabel =
      state.sttSource === "deepgram"
        ? "Deepgram"
        : state.sttSource === "browser-fallback"
          ? "Browser (fallback)"
          : state.sttSource === "error"
            ? "Unavailable"
            : "Browser";
    el.sttSourceText.textContent = `STT: ${sttLabel}`;
  }
  if (el.aiSourceText) {
    const label =
      state.geminiConfigured === true
        ? "Gemini"
        : state.geminiConfigured === false
          ? "Fallback"
          : "Unknown";
    el.aiSourceText.textContent = `AI: ${label}`;
  }
}

async function refreshAiStatus() {
  try {
    const resp = await fetch(HEALTH_URL);
    if (!resp.ok) throw new Error("health");
    const data = await resp.json();
    state.geminiConfigured = !!data?.gemini_configured;
  } catch {
    state.geminiConfigured = null;
  }
  renderStatus();
}

function renderTrainerExerciseCards() {
  if (!el.trainerExerciseCards) return;
  if (state.compareView) {
    const { muscle, newer, older } = state.compareView;
    el.trainerExerciseCards.innerHTML = renderCompareViewHtml(muscle, newer, older);
    return;
  }
  const session = state.activeSession;
  if (!session) {
    el.trainerExerciseCards.innerHTML =
      '<p class="status subtle">No active workout yet. Name muscles to start, ask a training question, or say <strong>start workout</strong>.</p>';
    return;
  }

  const planned = (session.planned || []).map((x) => normalizeExercise(x)).filter(Boolean);
  const logged = (session.entries || []).map((x) => normalizeExercise(x.exercise)).filter(Boolean);
  const exercises = [...new Set([...planned, ...logged])];

  if (!exercises.length) {
    el.trainerExerciseCards.innerHTML =
      '<p class="status subtle">Exercises will appear here once the workout starts.</p>';
    return;
  }

  const cards = exercises
    .slice(0, 6)
    .map((exercise) => {
      const matches = (session.entries || []).filter((entry) => normalizeExercise(entry.exercise) === exercise);
      const latest = matches[matches.length - 1];
      const sets = matches.length ? String(matches.length) : "--";
      const weight = latest ? `${latest.weight} ${WEIGHT_UNIT}` : "--";
      const reps = latest ? `${latest.reps}` : "--";
      return `
        <article class="exercise-card">
          <p class="exercise-name">${formatExerciseLabel(exercise)}</p>
          <div class="exercise-fields">
            <div class="exercise-field">
              <span class="exercise-field-label">Weight</span>
              <span class="exercise-field-value">${weight}</span>
            </div>
            <div class="exercise-field">
              <span class="exercise-field-label">Reps</span>
              <span class="exercise-field-value">${reps}</span>
            </div>
            <div class="exercise-field">
              <span class="exercise-field-label">Sets</span>
              <span class="exercise-field-value">${sets}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.trainerExerciseCards.innerHTML = cards;
}

function extractMuscles(text) {
  const t = text.toLowerCase();
  const m = [];
  if (t.includes("chest")) m.push("chest");
  if (t.includes("bicep")) m.push("biceps");
  if (t.includes("back") && !t.includes("feedback")) m.push("back");
  if (t.includes("leg") || t.includes("squat")) m.push("legs");
  if (t.includes("shoulder") || t.includes("delt")) m.push("shoulders");
  if (t.includes("tricep")) m.push("triceps");
  return m;
}

function normalizeMuscleQuery(text) {
  const t = text.toLowerCase();
  if (t.includes("bicep")) return "biceps";
  if (t.includes("tricep")) return "triceps";
  if (t.includes("shoulder") || t.includes("delt")) return "shoulders";
  if (t.includes("leg") || t.includes("quad") || t.includes("hamstring")) return "legs";
  if (t.includes("back")) return "back";
  if (t.includes("chest")) return "chest";
  return null;
}

function findCompletedSessionsForMuscle(muscle) {
  return state.sessions
    .filter((s) => (s.muscles || []).includes(muscle))
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function sessionStats(session) {
  const entries = session.entries || [];
  const sets = entries.length;
  const volume = sessionVolume(entries);
  const byExercise = {};
  entries.forEach((e) => {
    if (!byExercise[e.exercise]) byExercise[e.exercise] = [];
    byExercise[e.exercise].push(e);
  });
  const topLines = Object.entries(byExercise)
    .map(([exercise, logs]) => {
      const topWeight = logs.reduce((max, x) => Math.max(max, Number(x.weight) || 0), 0);
      const bestAtTop = logs
        .filter((x) => Number(x.weight) === topWeight)
        .reduce((maxR, x) => Math.max(maxR, Number(x.reps) || 0), 0);
      return `${exercise}: ${topWeight}${WEIGHT_UNIT} x ${bestAtTop}`;
    })
    .slice(0, 4);
  return { sets, volume, topLines };
}

function summarizeLastWorkoutForMuscle(muscle) {
  const sessions = findCompletedSessionsForMuscle(muscle);
  if (!sessions.length) {
    return {
      kind: "summary_no_data",
      payload: { muscle },
      fallback: `Hmm, no saved ${muscle} workout yet. Finish one and I'll have something to summarize.`,
    };
  }
  const latest = sessions[0];
  const stats = sessionStats(latest);
  const date = new Date(latest.startedAt).toLocaleDateString();
  const topJoin = stats.topLines.length ? stats.topLines.join(" | ") : "No set data logged.";
  return {
    kind: "summary_last_workout",
    payload: {
      muscle,
      date,
      sets: stats.sets,
      volume: Math.round(stats.volume),
      unit: WEIGHT_UNIT,
      top: stats.topLines,
    },
    fallback: `Last ${muscle} workout on ${date}: ${stats.sets} sets, around ${Math.round(stats.volume)} ${WEIGHT_UNIT}-reps. Top sets: ${topJoin}.`,
  };
}

function summarizeImprovementForMuscle(muscle) {
  const sessions = findCompletedSessionsForMuscle(muscle);
  if (sessions.length < 2) {
    return {
      kind: "improvement_need_more",
      payload: { muscle },
      fallback: `Hmm, I need at least two saved ${muscle} workouts to talk progress.`,
    };
  }
  const latest = sessionStats(sessions[0]);
  const previous = sessionStats(sessions[1]);
  const deltaVolume = Math.round(latest.volume - previous.volume);
  const pct =
    previous.volume > 0
      ? Number((((latest.volume - previous.volume) / previous.volume) * 100).toFixed(1))
      : null;
  const deltaSets = latest.sets - previous.sets;
  const direction = deltaVolume >= 0 ? "up" : "down";
  const volumePart =
    pct !== null
      ? `${Math.abs(deltaVolume)} ${WEIGHT_UNIT}-reps (about ${Math.abs(pct)}% ${direction})`
      : `${Math.abs(deltaVolume)} ${WEIGHT_UNIT}-reps`;
  const setsPart = `${Math.abs(deltaSets)} ${deltaSets >= 0 ? "more" : "fewer"} sets`;
  return {
    kind: "improvement_summary",
    payload: {
      muscle,
      deltaVolume,
      deltaPct: pct,
      deltaSets,
      unit: WEIGHT_UNIT,
    },
    fallback: `Compared to your last ${muscle} workout, volume's ${direction} by ${volumePart}, with ${setsPart}.`,
  };
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSessionDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Per-exercise best weight in a session (for comparison hints). */
function bestWeightByExercise(session) {
  const map = {};
  (session.entries || []).forEach((e) => {
    const ex = e.exercise;
    const w = Number(e.weight) || 0;
    if (!map[ex] || w > map[ex].weight) map[ex] = { weight: w, reps: e.reps };
  });
  return map;
}

function compareWeightUps(newer, older) {
  const n = bestWeightByExercise(newer);
  const o = bestWeightByExercise(older);
  const ups = [];
  Object.keys(n).forEach((ex) => {
    if (o[ex] && n[ex].weight > o[ex].weight) {
      ups.push(
        `${formatExerciseLabel(ex)}: ${o[ex].weight}→${n[ex].weight} ${WEIGHT_UNIT}`
      );
    }
  });
  return ups;
}

function buildCompareTwoWorkoutsAnalysis(muscle, newer, older) {
  const a = sessionStats(newer);
  const b = sessionStats(older);
  const deltaVolume = Math.round(a.volume - b.volume);
  const pct = b.volume > 0 ? Number((((a.volume - b.volume) / b.volume) * 100).toFixed(1)) : null;
  const deltaSets = a.sets - b.sets;
  const direction = deltaVolume >= 0 ? "up" : "down";
  const ups = compareWeightUps(newer, older);
  const volLine =
    pct !== null
      ? `Volume's ${direction} by about ${Math.abs(deltaVolume)} ${WEIGHT_UNIT}-reps (${Math.abs(pct)}% ${direction}).`
      : `Volume difference: about ${Math.abs(deltaVolume)} ${WEIGHT_UNIT}-reps.`;
  const setsLine = `${Math.abs(deltaSets)} ${deltaSets >= 0 ? "more" : "fewer"} sets in the latest session.`;
  const prLine =
    ups.length > 0
      ? ` Heavier top sets on ${ups.slice(0, 3).join(", ")}.`
      : " Top weights were similar across the board.";
  const fallback = `Here's your ${muscle} comparison. ${volLine} ${setsLine}${prLine}`;
  return {
    kind: "compare_result",
    payload: {
      muscle,
      newer: { sets: a.sets, volume: Math.round(a.volume), top: a.topLines },
      older: { sets: b.sets, volume: Math.round(b.volume), top: b.topLines },
      deltaPct: pct,
      ups,
      unit: WEIGHT_UNIT,
    },
    fallback,
  };
}

/** Pure-string variant for in-card display (Live Exercise Tracker compare view). */
function buildCompareTwoWorkoutsText(muscle, newer, older) {
  return buildCompareTwoWorkoutsAnalysis(muscle, newer, older).fallback;
}

function formatSessionEntriesList(session) {
  const entries = session.entries || [];
  if (!entries.length) return '<p class="compare-empty">No sets logged.</p>';
  const groups = aggregateEntriesForDisplay(entries);
  return `<ul class="compare-set-list">${groups
    .map((g) => {
      const line = formatGroupedSetLine(g);
      return `<li>${escapeHtml(line)}</li>`;
    })
    .join("")}</ul>`;
}

function renderCompareViewHtml(muscle, newer, older) {
  const a = sessionStats(newer);
  const b = sessionStats(older);
  const analysisShort = buildCompareTwoWorkoutsText(muscle, newer, older);
  return `
    <div class="compare-wrap">
      <p class="compare-intro">${escapeHtml(analysisShort)}</p>
      <div class="compare-grid">
        <div class="compare-session compare-session-newer">
          <p class="compare-session-label">Most recent</p>
          <p class="compare-session-date">${escapeHtml(formatSessionDate(newer.startedAt))}</p>
          <p class="compare-session-meta">${a.sets} sets · ${Math.round(a.volume)} ${WEIGHT_UNIT}·reps vol.</p>
          ${formatSessionEntriesList(newer)}
        </div>
        <div class="compare-session compare-session-older">
          <p class="compare-session-label">Previous</p>
          <p class="compare-session-date">${escapeHtml(formatSessionDate(older.startedAt))}</p>
          <p class="compare-session-meta">${b.sets} sets · ${Math.round(b.volume)} ${WEIGHT_UNIT}·reps vol.</p>
          ${formatSessionEntriesList(older)}
        </div>
      </div>
    </div>
  `;
}

function clearCompareView() {
  state.compareView = null;
}

/** Digits or spoken English before "rep(s)" / "set(s)" in log phrases. */
const SPOKEN_COUNT_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const SPOKEN_COUNT_PATTERN = Object.keys(SPOKEN_COUNT_WORDS).join("|");

/** @param {"rep"|"set"} unit */
function parseSpelledOrDigitUnit(t, unit) {
  const u = unit === "rep" ? "reps?" : "sets?";
  const digit = t.match(new RegExp(`(\\d+)\\s*${u}\\b`, "i"));
  if (digit) return Number(digit[1]);
  const w = t.match(new RegExp(`\\b(${SPOKEN_COUNT_PATTERN})\\s*${u}\\b`, "i"));
  if (w) {
    const n = SPOKEN_COUNT_WORDS[w[1].toLowerCase()];
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseLog(text) {
  const t = text.toLowerCase();
  if (!/(log|add)/.test(t)) return null;
  const weight = (t.match(/(\d+(?:\.\d+)?)\s*(kg|kgs?)/) || [])[1];
  const reps = (t.match(/(\d+)\s*reps?/) || [])[1];
  const repsN = reps != null ? Number(reps) : parseSpelledOrDigitUnit(t, "rep");
  const setsN = parseSpelledOrDigitUnit(t, "set");
  if (!weight) return null;
  const exercise = t
    .replace(/\b(log|add|workout|today|please|my|just)\b/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(kg|kgs?)\b/g, " ")
    .replace(/\d+\s*(reps?|sets?)\b/g, " ")
    .replace(new RegExp(`\\b(?:${SPOKEN_COUNT_PATTERN})\\s*(reps?|sets?)\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    exercise,
    weight: Number(weight),
    reps: Number(repsN ?? 10),
    sets: Number(setsN ?? 1),
  };
}

function normalizeExercise(name) {
  const n = name.toLowerCase().trim();
  if (!n) return "";
  // Keep incline bench variants distinct from flat barbell bench.
  if (n.includes("incline") && n.includes("bench")) {
    if (n.includes("dumbbell") || n.includes("db")) return "incline dumbbell press";
    return "incline barbell bench press";
  }
  if (n.includes("bench")) return "barbell bench press";
  if (n.includes("incline") && n.includes("dumbbell")) return "incline dumbbell press";
  if (n.includes("fly")) return "chest fly";
  if (n.includes("hammer")) return "hammer curl";
  if (n.includes("preacher")) return "preacher curl";
  if (n.includes("curl")) return "dumbbell bicep curl";
  return n;
}

function formatPlanForSpeech(planned) {
  if (!planned.length) return "No regular exercises saved yet.";
  return planned.map((x, i) => `${i + 1}) ${formatExerciseLabel(x)}`).join(" | ");
}

function promptUsualOrChangeForMuscles(muscles, cmdGen = null) {
  state.pendingMuscles = muscles.slice();
  state.pendingPlanned = muscles
    .flatMap((m) => state.regular[m] || [])
    .map((x) => normalizeExercise(x))
    .filter(Boolean);
  state.phase = "awaiting_plan_adjustment";
  const label = muscles.join(" and ");
  const planned = state.pendingPlanned.slice();
  const fallback = planned.length
    ? `Alright, ${label} day. Your usual lineup is ${planned.map(formatExerciseLabel).join(", ")}. Want to keep it, or add, remove, or swap something before we start?`
    : `Alright, ${label} day. Your saved plan is empty — say "add" followed by exercise names, then "start workout" when you're set.`;
  void speak("muscles_chosen", { muscles, planned }, fallback, cmdGen);
}

function startFlow(cmdGen = null) {
  if (state.activeSession) {
    void speak(
      "workout_already_active",
      {},
      "Hmm, you've already got a workout going. Say 'end workout' first if you want to start a new one.",
      cmdGen
    );
    return;
  }
  clearCompareView();
  state.phase = "awaiting_muscles";
  state.saveCustomAsRegular = false;
  renderTrainerExerciseCards();
  void speak(
    "flow_start_prompt",
    {},
    "Alright, what are we hitting today? Just tell me the muscle groups—or ask me anything first.",
    cmdGen
  );
}

function createSession(muscles, planned, usingUsual, cmdGen = null) {
  clearCompareView();
  state.activeSession = {
    id: uid(),
    startedAt: new Date().toISOString(),
    muscles,
    planned,
    usingUsual,
    entries: [],
  };
  state.phase = "idle";
  state.pendingMuscles = [];
  state.pendingPlanned = [];
  state.saveCustomAsRegular = false;
  persist();
  renderStatus();
  renderHome();
  renderTrainerExerciseCards();
  const label = muscles.join(" and ") || "your";
  const fallback = planned.length
    ? `Alright, ${label} workout is on — I've got ${planned.length} exercises queued. Let's get to it.`
    : `Alright, ${label} workout is on. Just call your sets out as you finish them.`;
  void speak("workout_started", { muscles, plannedCount: planned.length }, fallback, cmdGen);
}

function endSession(cmdGen = null) {
  if (!state.activeSession) {
    void speak(
      "workout_no_active_end",
      {},
      "Hmm, no workout running right now. Say 'start workout' or just name the muscles when you're ready.",
      cmdGen
    );
    return;
  }
  state.sessions.push({ ...state.activeSession, endedAt: new Date().toISOString() });
  state.activeSession = null;
  state.phase = "idle";
  state.pendingMuscles = [];
  state.pendingPlanned = [];
  clearCompareView();
  persist();
  renderHome();
  renderStatus();
  renderTrainerExerciseCards();
  void speak("workout_saved", {}, "That's a wrap. Solid session — I've got it saved for you.", cmdGen);
}

function logSet(parsed, cmdGen = null) {
  if (!state.activeSession) {
    state.activeSession = {
      id: uid(),
      startedAt: new Date().toISOString(),
      muscles: [],
      planned: [],
      entries: [],
      usingUsual: false,
    };
  }
  const exercise = normalizeExercise(parsed.exercise);
  for (let i = 0; i < parsed.sets; i += 1) {
    state.activeSession.entries.push({
      id: uid(),
      exercise,
      weight: parsed.weight,
      reps: parsed.reps,
      createdAt: new Date().toISOString(),
    });
  }
  persist();
  renderStatus();
  renderHome();
  renderTrainerExerciseCards();
  const niceName = formatExerciseLabel(exercise);
  const fallback =
    parsed.sets === 1
      ? `Got it — ${niceName} at ${parsed.weight} ${WEIGHT_UNIT} for ${parsed.reps}. Nice work.`
      : `Got it — ${parsed.sets} sets of ${niceName} at ${parsed.weight} ${WEIGHT_UNIT} for ${parsed.reps}. Keep it up.`;
  void speak(
    "set_logged",
    {
      exercise,
      weight: parsed.weight,
      reps: parsed.reps,
      sets: parsed.sets,
      unit: WEIGHT_UNIT,
    },
    fallback,
    cmdGen
  );
}

function extractSetCorrectionCount(input) {
  const t = input.toLowerCase().trim();
  if (!/\b(edit|change|correct|fix|update)\b/.test(t)) return null;
  if (!/\b(set|sets|set count|number of sets)\b/.test(t)) return null;
  const notPattern = t.match(/(\d+)\s*sets?\s*(?:not|instead of)\s*\d+/i);
  if (notPattern) return Number(notPattern[1]);
  const direct = t.match(/(?:to|it's|its|it is)\s*(\d+)\s*sets?/i);
  if (direct) return Number(direct[1]);
  const withSets = [...t.matchAll(/(\d+)\s*sets?/gi)];
  if (withSets.length) return Number(withSets[withSets.length - 1][1]);
  const plain = t.match(/(?:to|it's|its|it is)\s*(\d+)\b/i);
  if (plain) return Number(plain[1]);
  return null;
}

function extractEditInstruction(inputRaw) {
  const input = inputRaw.toLowerCase().trim();
  if (!/\b(edit|change|correct|fix|update)\b/.test(input)) return null;

  const weightKeywords =
    /\b(weight|kg|kgs|kilo|kilos|pounds?|lbs?)\b/.test(input) ||
    (/\bway\b/.test(input) && /\b(kg|kgs|kilo|kilos|lb|lbs|pounds?)\b/.test(input));
  const hasMassUnit = /\b(kg|kgs|kilo|kilos|lb|lbs|pounds?)\b/.test(input);
  const setsLike = /\b(set|sets|set count|number of sets)\b/.test(input);
  const repsLike = /\b(rep|reps|repetition|repetitions)\b/.test(input);
  // Reps first; then weight (any mass unit beats a bare "set" token, e.g. "change set to 10 kgs").
  let field = null;
  if (repsLike) field = "reps";
  else if (weightKeywords || hasMassUnit) field = "weight";
  else if (setsLike) field = "sets";
  if (!field) return null;

  const exerciseTargetMatch = input.match(/\bin\s+(.+?)\s+\b(?:to|it's|its|it is|not|instead of)\b/i);
  const exerciseTarget = exerciseTargetMatch ? normalizeExercise(exerciseTargetMatch[1]) : null;

  let value = null;
  if (field === "weight") {
    const notPattern = input.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs?)?\s*(?:not|instead of)\s*\d+(?:\.\d+)?/i);
    const direct = input.match(/(?:to|it's|its|it is)\s*(\d+(?:\.\d+)?)\s*(?:kg|kgs?)?/i);
    value = Number((notPattern && notPattern[1]) || (direct && direct[1]));
    if (!Number.isFinite(value)) {
      const any = [...input.matchAll(/(\d+(?:\.\d+)?)\s*(?:kg|kgs?)?/gi)];
      if (any.length) value = Number(any[any.length - 1][1]);
    }
  } else {
    const notPattern = input.match(/(\d+)\s*(?:sets?|reps?)?\s*(?:not|instead of)\s*\d+/i);
    const direct = input.match(/(?:to|it's|its|it is)\s*(\d+)\s*(?:sets?|reps?)?/i);
    value = Number((notPattern && notPattern[1]) || (direct && direct[1]));
    if (!Number.isFinite(value)) {
      const any = [...input.matchAll(/(\d+)\s*(?:sets?|reps?)?/gi)];
      if (any.length) value = Number(any[any.length - 1][1]);
    }
  }
  if (!Number.isFinite(value)) return null;
  return { field, value, exerciseTarget };
}

function findLatestEditableRun(entries, exerciseTarget = null) {
  if (!entries.length) return null;
  let idx = entries.length - 1;
  if (exerciseTarget) {
    const target = normalizeExercise(exerciseTarget);
    idx = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (normalizeExercise(entries[i].exercise) === target) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
  }
  const pivot = entries[idx];
  const same = (e) =>
    normalizeExercise(e.exercise) === normalizeExercise(pivot.exercise) &&
    Number(e.weight) === Number(pivot.weight) &&
    Number(e.reps) === Number(pivot.reps);

  let start = idx;
  while (start - 1 >= 0 && same(entries[start - 1])) start -= 1;
  let end = idx;
  while (end + 1 < entries.length && same(entries[end + 1])) end += 1;
  return { start, end, pivot, count: end - start + 1 };
}

function extractExerciseSwapInstruction(inputRaw) {
  const input = inputRaw.toLowerCase().trim();
  if (!/\b(change|swap|replace)\b/.test(input) || !/\b(to|with)\b/.test(input)) return null;
  const m = input.match(
    /(?:^|.*\b)(?:change|swap|replace)\s+(?:exercise\s+)?(.+?)\s+(?:to|with)\s+(?:exercise\s+)?(.+)$/i
  );
  if (!m) return null;
  const from = normalizeExercise(m[1].trim());
  const to = normalizeExercise(m[2].trim());
  if (!from || !to || from === to) return null;
  // Ignore metric edits like "change weight to..." which are handled elsewhere.
  if (/\b(weight|kg|kgs|set|sets|rep|reps)\b/.test(`${from} ${to}`)) return null;
  return { from, to };
}

async function applyExerciseSwapInstruction(swap, cmdGen = null) {
  const session = state.activeSession;
  if (!session) {
    await speak(
      "workout_no_active_end",
      {},
      "No active workout yet. Say 'start workout' first, then I can swap exercises.",
      cmdGen
    );
    return;
  }
  const planned = Array.isArray(session.planned) ? session.planned : [];
  if (!planned.length) {
    await speak(
      "plan_replace_not_found",
      { oldEx: swap.from },
      "Got you — this session doesn't have a planned exercise list yet, so there's nothing to swap.",
      cmdGen
    );
    return;
  }
  const idx = planned.findIndex((x) => normalizeExercise(x) === swap.from);
  if (idx < 0) {
    await speak(
      "plan_replace_not_found",
      { oldEx: swap.from },
      `Hmm, I couldn't find ${formatExerciseLabel(swap.from)} in today's plan.`,
      cmdGen
    );
    return;
  }
  const dupIdx = planned.findIndex((x, i) => i !== idx && normalizeExercise(x) === swap.to);
  if (dupIdx >= 0) {
    await speak(
      "plan_replace_already",
      { oldEx: swap.from, newEx: swap.to },
      `${formatExerciseLabel(swap.to)} is already in today's plan, so I left it as-is.`,
      cmdGen
    );
    return;
  }
  planned[idx] = swap.to;
  session.planned = planned;
  persist();
  renderStatus();
  renderHome();
  renderTrainerExerciseCards();
  await speak(
    "plan_replaced",
    { oldEx: swap.from, newEx: swap.to, planned: planned.slice() },
    `Okay, no problem — swapped ${formatExerciseLabel(swap.from)} to ${formatExerciseLabel(swap.to)} for this workout.`,
    cmdGen
  );
}

async function applyEditInstruction(edit, cmdGen = null) {
  const session = state.activeSession;
  const entries = session?.entries || [];
  if (!session || !entries.length) {
    await speak("set_edit_no_entries", {}, "Hmm, there isn't a recent set to edit yet.", cmdGen);
    return;
  }

  const run = findLatestEditableRun(entries, edit.exerciseTarget);
  if (!run) {
    const target = edit.exerciseTarget ? formatExerciseLabel(edit.exerciseTarget) : "that exercise";
    await speak(
      "set_edit_not_found",
      { exercise: target },
      `Hmm, I couldn't find ${target} in your recent logged sets.`,
      cmdGen
    );
    return;
  }

  const { start, end, pivot, count } = run;
  const fromSets = count;
  const fromWeight = Number(pivot.weight);
  const fromReps = Number(pivot.reps);
  const field = edit.field;
  const toValue = edit.value;

  if (!Number.isFinite(toValue) || toValue <= 0) {
    await speak(
      "set_edit_invalid",
      { field, requested: toValue },
      "Hmm, I can only set this to a whole number greater than zero.",
      cmdGen
    );
    return;
  }

  if (field === "sets") {
    const newCount = Math.floor(toValue);
    if (newCount === fromSets) {
      await speak(
        "set_edit_same",
        { field, exercise: pivot.exercise, value: fromSets },
        `It's already set to ${fromSets} for ${formatExerciseLabel(pivot.exercise)}.`,
        cmdGen
      );
      return;
    }
    if (newCount < fromSets) {
      entries.splice(start + newCount, fromSets - newCount);
    } else {
      const addN = newCount - fromSets;
      const clones = [];
      for (let i = 0; i < addN; i += 1) {
        clones.push({
          id: uid(),
          exercise: pivot.exercise,
          weight: pivot.weight,
          reps: pivot.reps,
          createdAt: new Date().toISOString(),
        });
      }
      entries.splice(end + 1, 0, ...clones);
    }
    persist();
    renderStatus();
    renderHome();
    renderTrainerExerciseCards();
    await speak(
      "set_edit_success",
      {
        field,
        changedField: "sets",
        exercise: pivot.exercise,
        from: fromSets,
        to: newCount,
        weight: fromWeight,
        reps: fromReps,
        unit: WEIGHT_UNIT,
      },
      `Got it — updated ${formatExerciseLabel(pivot.exercise)} from ${fromSets} set${fromSets === 1 ? "" : "s"} to ${newCount}.`,
      cmdGen
    );
    return;
  }

  if (field === "weight") {
    const newWeight = Number(toValue);
    if (newWeight === fromWeight) {
      await speak(
        "set_edit_same",
        { field, exercise: pivot.exercise, value: fromWeight, unit: WEIGHT_UNIT },
        `It's already ${fromWeight} ${WEIGHT_UNIT} for ${formatExerciseLabel(pivot.exercise)}.`,
        cmdGen
      );
      return;
    }
    for (let i = start; i <= end; i += 1) entries[i].weight = newWeight;
    persist();
    renderStatus();
    renderHome();
    renderTrainerExerciseCards();
    await speak(
      "set_edit_success",
      {
        field,
        changedField: "weight",
        exercise: pivot.exercise,
        from: fromWeight,
        to: newWeight,
        sets: fromSets,
        reps: fromReps,
        unit: WEIGHT_UNIT,
      },
      `Got it — changed ${formatExerciseLabel(pivot.exercise)} from ${fromWeight} ${WEIGHT_UNIT} to ${newWeight} ${WEIGHT_UNIT}.`,
      cmdGen
    );
    return;
  }

  const newReps = Math.floor(toValue);
  if (newReps === fromReps) {
    await speak(
      "set_edit_same",
      { field, exercise: pivot.exercise, value: fromReps },
      `It's already ${fromReps} reps for ${formatExerciseLabel(pivot.exercise)}.`,
      cmdGen
    );
    return;
  }
  for (let i = start; i <= end; i += 1) entries[i].reps = newReps;
  persist();
  renderStatus();
  renderHome();
  renderTrainerExerciseCards();
  await speak(
    "set_edit_success",
    {
      field,
      changedField: "reps",
      exercise: pivot.exercise,
      from: fromReps,
      to: newReps,
      sets: fromSets,
      weight: fromWeight,
      unit: WEIGHT_UNIT,
    },
    `Got it — changed ${formatExerciseLabel(pivot.exercise)} to ${newReps} reps for that set block.`,
    cmdGen
  );
}

async function handlePhase(input, cmdGen) {
  if (state.phase === "awaiting_muscles") {
    const muscles = extractMuscles(input);
    if (!muscles.length) {
      const reply = await answerCoach(input);
      if (reply) return await respond(reply, null, cmdGen);
      return await speak(
        "backend_unreachable",
        {},
        "Hmm, can't reach my brain right now. Make sure the backend is running and try again.",
        cmdGen
      );
    }
    promptUsualOrChangeForMuscles(muscles, cmdGen);
    return;
  }
  if (state.phase === "awaiting_plan_adjustment") {
    if (/\b(start|begin|go|done)\b/i.test(input)) {
      const planned = state.pendingPlanned.slice();
      if (!planned.length) {
        return await speak(
          "plan_start_empty",
          {},
          "Hmm, your list is empty. Say 'add' and the exercise names first, then we can start.",
          cmdGen
        );
      }
      return createSession(state.pendingMuscles, planned, false, cmdGen);
    }
    if (/\bshow|list\b/i.test(input)) {
      const planned = state.pendingPlanned.slice();
      const fallback = planned.length
        ? `Right now you've got ${planned.map(formatExerciseLabel).join(", ")}.`
        : "Your list is empty right now. Add an exercise or two first.";
      return await speak("plan_show", { planned }, fallback, cmdGen);
    }
    if (/\b(save|regular)\b/i.test(input)) {
      if (!state.pendingPlanned.length) {
        return await speak(
          "plan_save_empty",
          {},
          "Can't save an empty plan. Add at least one exercise first.",
          cmdGen
        );
      }
      state.pendingMuscles.forEach((m) => {
        state.regular[m] = state.pendingPlanned.slice();
      });
      persist();
      renderWorkoutConfig();
      return await speak(
        "plan_saved",
        { muscles: state.pendingMuscles, planned: state.pendingPlanned.slice() },
        "Saved — that's your regular plan now.",
        cmdGen
      );
    }
    if (/\breplace\b/i.test(input) && /\bwith\b/i.test(input)) {
      const m = input.match(/replace\s+(.+?)\s+with\s+(.+)/i);
      if (!m) {
        return await speak(
          "plan_replace_usage",
          {},
          "Try it like this: 'replace preacher curl with cable curl'.",
          cmdGen
        );
      }
      const oldEx = normalizeExercise(m[1]);
      const newEx = normalizeExercise(m[2]);
      const idx = state.pendingPlanned.findIndex((x) => normalizeExercise(x) === oldEx);
      if (idx < 0) {
        return await speak(
          "plan_replace_not_found",
          { oldEx },
          `Hmm, I couldn't find ${formatExerciseLabel(oldEx)} in your list.`,
          cmdGen
        );
      }
      const newAlreadyExists = state.pendingPlanned.some(
        (x, i) => i !== idx && normalizeExercise(x) === newEx
      );
      if (newAlreadyExists) {
        return await speak(
          "plan_replace_already",
          { oldEx, newEx },
          `${formatExerciseLabel(newEx)} is already in your list, so I left it alone. Say "remove ${formatExerciseLabel(oldEx)}" if you want fewer exercises.`,
          cmdGen
        );
      }
      state.pendingPlanned[idx] = newEx;
      const planned = state.pendingPlanned.slice();
      return await speak(
        "plan_replaced",
        { oldEx, newEx, planned },
        `Updated. Your list is now ${planned.map(formatExerciseLabel).join(", ")}.`,
        cmdGen
      );
    }
    if (/\b(remove|delete|drop)\b/i.test(input)) {
      const raw = input.replace(/\b(remove|delete|drop)\b/gi, "").trim();
      const targets = raw
        .split(",")
        .map((x) => normalizeExercise(x))
        .filter(Boolean);
      if (!targets.length) {
        return await speak(
          "plan_remove_empty",
          {},
          "Tell me which one to remove — like 'remove preacher curl'.",
          cmdGen
        );
      }
      const before = state.pendingPlanned.length;
      state.pendingPlanned = state.pendingPlanned.filter(
        (x) => !targets.some((t) => normalizeExercise(x).includes(t) || t.includes(normalizeExercise(x)))
      );
      if (state.pendingPlanned.length === before) {
        return await speak(
          "plan_remove_not_found",
          { targets },
          "Hmm, I couldn't find that one in your list.",
          cmdGen
        );
      }
      const planned = state.pendingPlanned.slice();
      const fallback = planned.length
        ? `Removed. Your list is now ${planned.map(formatExerciseLabel).join(", ")}.`
        : "Removed. Your list is empty now — add something before we start.";
      return await speak("plan_removed", { planned, removed: targets }, fallback, cmdGen);
    }
    if (/\badd\b/i.test(input)) {
      const raw = input.replace(/\badd\b/gi, "").trim();
      const adds = raw
        .split(",")
        .map((x) => normalizeExercise(x))
        .filter(Boolean);
      if (!adds.length) {
        return await speak(
          "plan_add_empty",
          {},
          "Tell me what to add — like 'add cable curl, incline curl'.",
          cmdGen
        );
      }
      state.pendingPlanned = [...new Set([...state.pendingPlanned, ...adds])];
      const planned = state.pendingPlanned.slice();
      return await speak(
        "plan_added",
        { planned, added: adds },
        `Added. Your list is now ${planned.map(formatExerciseLabel).join(", ")}.`,
        cmdGen
      );
    }
    return await speak(
      "plan_help",
      {},
      "You can say add, remove, replace one with another, save as regular, show the list, or just say start workout when you're ready.",
      cmdGen
    );
  }
  return null;
}

const API_UNREACHABLE_HINT =
  "Cannot reach the workout API (no exercise names without it). From the project folder: run `npm run backend:dev` and leave it running, then `npm run site:dev` and open http://localhost:5173 — do not open index.html as a file. Firewall must allow Python on port 8000.";

async function answerKnowledge(query) {
  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: query }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.reply) return data.reply;
  } catch {
    return null;
  }
  return null;
}

async function answerCoach(query) {
  let networkFailed = false;
  const tryPost = async (url) => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: query }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.reply || null;
    } catch {
      networkFailed = true;
      return null;
    }
  };
  const fromCoach = await tryPost(COACH_URL);
  if (fromCoach) return fromCoach;
  const fromChat = await tryPost(API_URL);
  if (fromChat) return fromChat;
  if (networkFailed) return API_UNREACHABLE_HINT;
  return null;
}

async function transcribeWithDeepgram(blob) {
  const file = new File([blob], "speech.webm", { type: blob.type || "audio/webm" });
  const form = new FormData();
  form.append("audio", file);
  const resp = await fetch(STT_URL, { method: "POST", body: form });
  if (!resp.ok) throw new Error("stt");
  const data = await resp.json();
  return String(data?.transcript || "").trim();
}

function sttStreamUrl() {
  const override = import.meta.env.VITE_BACKEND_WS_URL;
  if (override) {
    return `${String(override).replace(/\/$/, "")}${STT_STREAM_PATH}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${STT_STREAM_PATH}`;
}

/**
 * Command bus: each handler declares when it matches and performs an action.
 * Returning true means "handled", false means continue to next handler.
 */
function createCommandHandlers() {
  return [
    {
      name: "wake_greeting",
      match: ({ lowerInput }) => lowerInput.includes("jarvis") && lowerInput.includes("you up"),
      run: async ({ cmdGen }) => {
        state.jarvisAwake = true;
        state.phase = "idle";
        await speak("wake_greeting", {}, JARVIS_WAKE_REPLY, cmdGen);
      },
    },
    {
      name: "end_workout",
      match: ({ input }) =>
        /\b(end|finish|complete|stop)\s+(the\s+)?workout\b/i.test(input) || /\bworkout\s+(done|finished|over)\b/i.test(input),
      run: async ({ cmdGen }) => {
        endSession(cmdGen);
      },
    },
    {
      name: "delete_last_workout",
      match: ({ lowerInput }) =>
        /\bdelete\s+last\s+workout\b/i.test(lowerInput) || /\b(remove|delete)\s+most\s+recent\s+workout\b/i.test(lowerInput),
      run: async ({ cmdGen }) => {
        const rows = state.sessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        if (!rows.length) {
          await speak(
            "delete_no_saved",
            {},
            "Hmm, you don't have any saved workouts yet — nothing to delete.",
            cmdGen
          );
          return;
        }
        deletePastSessionById(rows[0].id);
        await speak("deleted_last_saved", {}, "Done — your most recent workout is gone.", cmdGen);
      },
    },
    {
      name: "discard_active_workout",
      match: ({ lowerInput }) => /\b(discard|cancel)\s+(the\s+)?(active\s+)?workout\b/i.test(lowerInput),
      run: async ({ cmdGen }) => {
        discardActiveWorkout(cmdGen);
      },
    },
    {
      name: "casual_acknowledgement",
      match: ({ input }) =>
        /^(no(pe)?|nah|no that's fine|no thats fine|that's fine|thats fine|all good|we're good|we are good)\b/i.test(
          input.trim()
        ),
      run: async ({ cmdGen }) => {
        await speak("unknown_help", {}, "Okay, no problem.", cmdGen);
      },
    },
    {
      name: "swap_session_exercise",
      match: ({ input }) => Boolean(extractExerciseSwapInstruction(input)),
      run: async ({ input, cmdGen }) => {
        const swap = extractExerciseSwapInstruction(input);
        if (!swap) return false;
        await applyExerciseSwapInstruction(swap, cmdGen);
      },
    },
    {
      name: "edit_logged_set",
      match: ({ input }) => Boolean(extractEditInstruction(input)),
      run: async ({ input, cmdGen }) => {
        const edit = extractEditInstruction(input);
        if (!edit) return;
        await applyEditInstruction(edit, cmdGen);
      },
    },
    {
      name: "phase_handler",
      match: () => state.phase !== "idle",
      run: async ({ input, cmdGen }) => {
        await handlePhase(input, cmdGen);
      },
    },
    {
      name: "summary_last_workout",
      match: ({ input }) => /\b(summary|summarize|summarise)\b/i.test(input) && /\b(last|previous)\b/i.test(input),
      run: async ({ input, cmdGen }) => {
        const muscle = normalizeMuscleQuery(input);
        if (!muscle) return false;
        const s = summarizeLastWorkoutForMuscle(muscle);
        await speak(s.kind, s.payload, s.fallback, cmdGen);
      },
    },
    {
      name: "improvement_summary",
      match: ({ input }) => /\b(improve|improved|improvement|progress)\b/i.test(input) && /\b(last|previous)\b/i.test(input),
      run: async ({ input, cmdGen }) => {
        const muscle = normalizeMuscleQuery(input);
        if (!muscle) return false;
        const s = summarizeImprovementForMuscle(muscle);
        await speak(s.kind, s.payload, s.fallback, cmdGen);
      },
    },
    {
      name: "compare_sessions",
      match: ({ lowerInput }) => /\bcompare\b/i.test(lowerInput),
      run: async ({ input, cmdGen }) => {
        const muscle = normalizeMuscleQuery(input);
        if (!muscle) {
          await speak(
            "compare_no_muscle",
            {},
            "Tell me which muscle to compare — like 'compare my last two chest workouts'.",
            cmdGen
          );
          return;
        }
        const list = findCompletedSessionsForMuscle(muscle);
        if (list.length < 2) {
          clearCompareView();
          renderTrainerExerciseCards();
          await speak(
            "compare_need_more",
            { muscle },
            `Hmm, I need at least two saved ${muscle} workouts to compare. Finish another and we'll line them up.`,
            cmdGen
          );
          return;
        }
        state.compareView = { muscle, newer: list[0], older: list[1] };
        renderTrainerExerciseCards();
        const c = buildCompareTwoWorkoutsAnalysis(muscle, list[0], list[1]);
        await speak(c.kind, c.payload, c.fallback, cmdGen);
      },
    },
    {
      name: "muscle_only_auto_start",
      match: ({ input }) =>
        !state.activeSession &&
        /^(chest|biceps|back|legs|shoulders|triceps)(\s+and\s+(chest|biceps|back|legs|shoulders|triceps))*$/i.test(
          input.replace(/\s+/g, " ").trim()
        ),
      run: async ({ input, cmdGen }) => {
        const muscles = extractMuscles(input);
        promptUsualOrChangeForMuscles(muscles, cmdGen);
      },
    },
    {
      name: "start_workout",
      match: ({ input }) => /start workout/i.test(input),
      run: async ({ cmdGen }) => {
        startFlow(cmdGen);
      },
    },
    {
      name: "log_set",
      match: ({ input }) => Boolean(parseLog(input)),
      run: async ({ input, cmdGen }) => {
        const parsed = parseLog(input);
        if (!parsed) return;
        logSet(parsed, cmdGen);
      },
    },
    {
      name: "bench_progress",
      match: ({ input }) => /improve from last week/i.test(input),
      run: async ({ cmdGen }) => {
        const entries = flattenEntries().filter((e) => e.exercise === "barbell bench press");
        if (entries.length < 2) {
          await speak(
            "bench_no_data",
            {},
            "Hmm, not enough bench history yet for a week-over-week comparison.",
            cmdGen
          );
          return;
        }
        const sorted = entries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const latest = sorted[0].weight;
        const prior = sorted[Math.min(3, sorted.length - 1)].weight;
        const diff = latest - prior;
        const fallback =
          diff >= 0
            ? `Nice — you're up ${diff} ${WEIGHT_UNIT} on bench compared to before.`
            : `You're ${Math.abs(diff)} ${WEIGHT_UNIT} below your previous bench. Don't sweat it.`;
        await speak("bench_progress", { diff, unit: WEIGHT_UNIT }, fallback, cmdGen);
      },
    },
    {
      name: "coach_answer",
      match: ({ input }) => input.replace(/\s+/g, " ").trim().length >= 3,
      run: async ({ input, cmdGen }) => {
        const reply = await answerCoach(input);
        if (!reply) return false;
        await respond(reply, null, cmdGen);
      },
    },
  ];
}

const COMMAND_HANDLERS = createCommandHandlers();

async function processCommand(inputRaw) {
  const input = inputRaw.trim();
  const lowerInput = input.toLowerCase();
  if (!input) return;

  state.dispatchGeneration += 1;
  const cmdGen = state.dispatchGeneration;
  revokeTtsPlayback();
  const ctx = { input, lowerInput, cmdGen };
  for (const handler of COMMAND_HANDLERS) {
    if (!handler.match(ctx)) continue;
    const outcome = await handler.run(ctx);
    if (outcome !== false) return;
  }

  await speak(
    "unknown_help",
    {},
    "Hmm, I didn't quite catch that. You can name a muscle to start, log a set like 'log bench 60 kilos for 8', or just ask me anything about training.",
    cmdGen
  );
}

function saveAllExercises() {
  MUSCLE_DEFS.forEach(({ id }) => {
    const selects = el.workoutMuscleStack.querySelectorAll(`.ex-select[data-muscle="${id}"]`);
    const vals = [...selects].map((node) => node.value.trim());
    state.regular[id] = [vals[0] || "", vals[1] || "", vals[2] || ""];
  });
  persist();
  renderWorkoutConfig();
}

function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const setListeningUi = (on) => {
    state.listening = on;
    el.micBtn.classList.toggle("listening", on);
    renderStatus();
  };

  // Preferred path: capture audio and transcribe via backend Deepgram.
  if (USE_DEEPGRAM_STT && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
    let mediaStream = null;
    let mediaRecorder = null;
    let pendingStop = false;
    let ws = null;
    let chunks = [];
    let latestTranscript = "";
    let processedTranscript = "";
    let finalizeRequested = false;

    const start = async () => {
      if (state.listening) return;
      pendingStop = false;
      latestTranscript = "";
      processedTranscript = "";
      finalizeRequested = false;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(mediaStream);
        ws = new WebSocket(sttStreamUrl());
        ws.binaryType = "arraybuffer";
        chunks = [];
        state.sttSource = "deepgram";
        renderStatus();

        const wsReady = await new Promise((resolve) => {
          let settled = false;
          const done = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
          };
          ws.onopen = () => done(true);
          ws.onerror = () => done(false);
          setTimeout(() => done(false), 1400);
        });
        if (!wsReady) throw new Error("stt_ws_open_failed");

        ws.onmessage = async (event) => {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!payload || typeof payload !== "object") return;
          if (payload.type === "error") {
            state.sttSource = "error";
            renderStatus();
            return;
          }
          if (payload.type !== "transcript") return;
          const transcript = String(payload.transcript || "").trim();
          if (!transcript) return;
          latestTranscript = transcript;
          el.transcriptInput.value = transcript;
          const isFinal = !!payload.is_final || !!payload.speech_final;
          if (!isFinal) return;
          if (transcript === processedTranscript) return;
          if (!payload.speech_final && !(finalizeRequested && payload.is_final)) return;
          processedTranscript = transcript;
          await processCommand(transcript);
        };

        ws.onclose = () => {
          ws = null;
        };

        mediaRecorder.ondataavailable = async (e) => {
          if (!e.data || !e.data.size) return;
          chunks.push(e.data);
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          try {
            const ab = await e.data.arrayBuffer();
            ws.send(ab);
          } catch {
            /* ignore chunk send failures */
          }
        };
        mediaRecorder.onstop = async () => {
          const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
          chunks = [];
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              finalizeRequested = true;
              ws.send(JSON.stringify({ type: "finalize" }));
              setTimeout(() => {
                try {
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "close" }));
                    ws.close();
                  }
                } catch {
                  /* ignore */
                }
              }, 80);
            }
            // If no final packet arrived but we have text, still run command once.
            setTimeout(() => {
              if (latestTranscript && latestTranscript !== processedTranscript) {
                processedTranscript = latestTranscript;
                void processCommand(latestTranscript);
                return;
              }
              // Stream path failed silently? Fall back to one-shot STT with recorded blob.
              if (blob.size && !processedTranscript) {
                void (async () => {
                  try {
                    const spoken = await transcribeWithDeepgram(blob);
                    if (!spoken) return;
                    el.transcriptInput.value = spoken;
                    processedTranscript = spoken;
                    await processCommand(spoken);
                  } catch {
                    state.sttSource = "error";
                    renderStatus();
                    await speak("voice_error", {}, "Hmm, I missed that one. Mind saying it again?");
                  }
                })();
              }
            }, 140);
          } finally {
            mediaStream?.getTracks().forEach((t) => t.stop());
            mediaStream = null;
          }
        };

        mediaRecorder.start(120);
        setListeningUi(true);
        if (pendingStop) {
          // Mouse/touch released before getUserMedia/mediaRecorder finished starting.
          stop();
        }
      } catch {
        // Deepgram path unavailable (permissions/device). Keep app usable via browser STT.
        state.sttSource = "browser-fallback";
        setListeningUi(false);
        renderStatus();
      }
    };

    const stop = () => {
      if (!state.listening) {
        pendingStop = true;
        return;
      }
      setListeningUi(false);
      try {
        if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
      } catch {
        /* ignore */
      }
    };

    // Hold-to-talk behavior, with pendingStop guard for async startup race.
    el.micBtn.addEventListener("mousedown", () => void start());
    el.micBtn.addEventListener("mouseup", stop);
    el.micBtn.addEventListener("mouseleave", stop);
    el.micBtn.addEventListener("touchstart", () => void start(), { passive: true });
    el.micBtn.addEventListener("touchend", stop);
    el.micBtn.addEventListener("touchcancel", stop);
    return;
  }

  // Fallback path: browser built-in SpeechRecognition.
  if (!SR) {
    el.micBtn.disabled = true;
    state.sttSource = "error";
    renderStatus();
    return;
  }
  state.sttSource = USE_DEEPGRAM_STT ? "browser-fallback" : "browser";
  renderStatus();
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  const start = () => {
    if (state.listening) return;
    setListeningUi(true);
    rec.start();
  };
  const stop = () => {
    if (!state.listening) return;
    setListeningUi(false);
    rec.stop();
  };

  el.micBtn.addEventListener("mousedown", start);
  el.micBtn.addEventListener("mouseup", stop);
  el.micBtn.addEventListener("mouseleave", stop);
  el.micBtn.addEventListener("click", () => (state.listening ? stop() : start()));

  rec.onresult = (e) => {
    const spoken = e.results[0][0].transcript || "";
    el.transcriptInput.value = spoken;
    processCommand(spoken).catch(() =>
      speak("voice_error", {}, "Hmm, I missed that one. Mind saying it again?")
    );
  };
  rec.onerror = () => {
    setListeningUi(false);
  };
  rec.onend = () => {
    setListeningUi(false);
  };
}

function bindEvents() {
  el.tabHome.addEventListener("click", () => switchPage("home"));
  el.tabWorkout.addEventListener("click", () => switchPage("workout"));
  el.tabTrainer.addEventListener("click", () => switchPage("trainer"));

  el.saveAllPlanBtn.addEventListener("click", saveAllExercises);

  el.sendBtn.addEventListener("click", () => processCommand(el.transcriptInput.value).catch(() => {}));
  el.transcriptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      processCommand(el.transcriptInput.value).catch(() => {});
    }
  });

  el.homeWorkoutFeed.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-delete-session]");
    if (!btn) return;
    const id = btn.getAttribute("data-delete-session");
    if (!id) return;
    if (!confirm("Delete this workout from history?")) return;
    deletePastSessionById(id);
  });
}

seedMockDataIfNeeded();
persist();
buildWorkoutPanels();
bindEvents();
setupSpeech();
switchPage("home");
renderHome();
renderWorkoutConfig();
renderStatus();
renderTrainerExerciseCards();
void refreshAiStatus();
