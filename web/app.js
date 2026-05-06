const STORAGE_KEYS = {
  plan: "jarvis-plan-v1",
  sessions: "jarvis-sessions-v1",
  activeSession: "jarvis-active-session-v1",
};

const WEIGHT_UNIT = "kg";
const API_URL = "/api/chat";
const JARVIS_WAKE_REPLY = "For you sir, always. Which muscles are we working on today?";
const JARVIS_DIALOGUE = `You: Hey Jarvis, you up?\nJarvis: ${JARVIS_WAKE_REPLY}`;

const MUSCLE_EXERCISE_MAP = {
  chest: [
    { canonical: "barbell bench press", alternatives: ["bench", "bench press", "flat bench"] },
    { canonical: "dumbbell bench press", alternatives: ["db press", "dumbell press"] },
    { canonical: "chest fly", alternatives: ["pec fly", "cable fly"] },
  ],
  biceps: [
    { canonical: "dumbbell bicep curl", alternatives: ["bicep curl", "bicep curls", "db curl"] },
    { canonical: "hammer curl", alternatives: ["neutral curl"] },
    { canonical: "preacher curl", alternatives: ["ez preacher curl"] },
  ],
};

const EXERCISE_ALIASES = {
  bench: "barbell bench press",
  benchpress: "barbell bench press",
  dumbell: "dumbbell",
  "dumbell press": "dumbbell bench press",
  "dumbbell press": "dumbbell bench press",
  "bicep curls": "dumbbell bicep curl",
};

const els = {
  homeView: document.getElementById("homeView"),
  workoutView: document.getElementById("workoutView"),
  tabHomeBtn: document.getElementById("tabHomeBtn"),
  tabWorkoutBtn: document.getElementById("tabWorkoutBtn"),
  assistantReply: document.getElementById("assistantReply"),
  transcriptInput: document.getElementById("transcriptInput"),
  processTypedBtn: document.getElementById("processTypedBtn"),
  holdToTalkBtn: document.getElementById("holdToTalkBtn"),
  statusText: document.getElementById("statusText"),
  ttsSourceText: document.getElementById("ttsSourceText"),
  setList: document.getElementById("setList"),
  sessionExerciseList: document.getElementById("sessionExerciseList"),
  weekHistoryList: document.getElementById("weekHistoryList"),
  savePlanBtn: document.getElementById("savePlanBtn"),
  chest1: document.getElementById("chest1"),
  chest2: document.getElementById("chest2"),
  chest3: document.getElementById("chest3"),
  biceps1: document.getElementById("biceps1"),
  biceps2: document.getElementById("biceps2"),
  biceps3: document.getElementById("biceps3"),
};

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const state = {
  activeTab: "home",
  recognitionListening: false,
  phase: "idle", // idle | awaiting_muscles | awaiting_plan_choice | awaiting_custom_exercises
  pendingMuscles: [],
  plan: safeParse(localStorage.getItem(STORAGE_KEYS.plan) || "null", null) || {
    chest: ["barbell bench press", "dumbbell bench press", "chest fly"],
    biceps: ["dumbbell bicep curl", "hammer curl", "preacher curl"],
  },
  sessions: safeParse(localStorage.getItem(STORAGE_KEYS.sessions) || "[]", []),
  activeSession: safeParse(localStorage.getItem(STORAGE_KEYS.activeSession) || "null", null),
};

function persistState() {
  localStorage.setItem(STORAGE_KEYS.plan, JSON.stringify(state.plan));
  localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(state.sessions));
  if (state.activeSession) {
    localStorage.setItem(STORAGE_KEYS.activeSession, JSON.stringify(state.activeSession));
  } else {
    localStorage.removeItem(STORAGE_KEYS.activeSession);
  }
}

function normalizeExercise(input) {
  const normalized = input.trim().toLowerCase();
  if (EXERCISE_ALIASES[normalized]) return EXERCISE_ALIASES[normalized];
  for (const muscleRows of Object.values(MUSCLE_EXERCISE_MAP)) {
    for (const row of muscleRows) {
      if (normalized === row.canonical) return row.canonical;
      if (row.alternatives.some((alt) => normalized.includes(alt))) return row.canonical;
    }
  }
  return normalized;
}

function flattenEntries() {
  return state.sessions.flatMap((s) => s.entries || []);
}

function getRecentEntries(limit = 10) {
  return flattenEntries()
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

function extractMuscles(text) {
  const t = text.toLowerCase();
  const muscles = [];
  if (t.includes("chest")) muscles.push("chest");
  if (t.includes("biceps") || t.includes("bicep")) muscles.push("biceps");
  return muscles;
}

function isYes(text) {
  return /\b(yes|usual|same|default|normal|do usual)\b/i.test(text);
}

function isChange(text) {
  return /\b(change|custom|different|new exercises)\b/i.test(text);
}

function isJarvisWakePhrase(raw) {
  const t = raw.toLowerCase();
  return t.includes("jarvis") && (t.includes("you up") || t.includes("you there") || t.includes("are you up"));
}

function parseSetLogIntent(rawText) {
  const text = rawText.toLowerCase().trim();
  if (!/(?:log|add)/i.test(text)) return null;

  const weightMatch =
    text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs?)\b/i) || text.match(/(?:at|with)\s+(\d+(?:\.\d+)?)/i);
  const repsMatch = text.match(/(\d+)\s*reps?\b/i);
  const setsMatch = text.match(/(\d+)\s*sets?\b/i);
  const xFormat = text.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+)/i);

  const weight = weightMatch ? Number(weightMatch[1]) : xFormat ? Number(xFormat[1]) : null;
  const reps = repsMatch ? Number(repsMatch[1]) : xFormat ? Number(xFormat[2]) : 10;
  const setsCount = setsMatch ? Number(setsMatch[1]) : 1;

  let exerciseChunk = text
    .replace(/\b(?:log|add|workout|my|please|can you|today)\b/gi, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:kg|kgs?)\b/gi, " ")
    .replace(/\d+\s*reps?\b/gi, " ")
    .replace(/\d+\s*sets?\b/gi, " ")
    .replace(/\d+(?:\.\d+)?\s*x\s*\d+/gi, " ")
    .replace(/\b(?:at|with|for|of)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  exerciseChunk = exerciseChunk.replace(/\bcurls\b/g, "curl");

  if (!exerciseChunk || !weight) return null;

  return {
    exercise: normalizeExercise(exerciseChunk),
    weight,
    reps,
    setsCount,
    assumedReps: !repsMatch && !xFormat,
  };
}

function asksProgressFromLastWeek(text) {
  const t = text.toLowerCase();
  return t.includes("improve from last week") || t.includes("improvement from last week");
}

function inferExerciseFromQuestion(text) {
  const t = text.toLowerCase();
  if (t.includes("bench")) return "barbell bench press";
  if (t.includes("curl")) return "dumbbell bicep curl";
  return null;
}

function summarizeWeekHistory() {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentSessions = state.sessions.filter((s) => new Date(s.startedAt).getTime() >= sevenDaysAgo);
  return recentSessions
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((s) => {
      const totalSets = (s.entries || []).length;
      const muscles = (s.muscles || []).join(", ") || "unplanned";
      const date = new Date(s.startedAt).toLocaleDateString();
      return `${date} · ${muscles} · ${totalSets} sets`;
    });
}

async function speak(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  if (els.ttsSourceText) els.ttsSourceText.textContent = "TTS: Browser";
}

function respond(text, speakText = null) {
  els.assistantReply.textContent = text;
  speak(speakText || text).catch(() => {});
}

function respondJarvisWake() {
  respond(JARVIS_DIALOGUE, JARVIS_WAKE_REPLY);
}

function switchTab(tab) {
  state.activeTab = tab;
  const home = tab === "home";
  els.homeView.classList.toggle("hidden", !home);
  els.workoutView.classList.toggle("hidden", home);
  els.tabHomeBtn.classList.toggle("active", home);
  els.tabWorkoutBtn.classList.toggle("active", !home);
}

function renderHome() {
  const { chest, biceps } = state.plan;
  els.chest1.value = chest[0] || "";
  els.chest2.value = chest[1] || "";
  els.chest3.value = chest[2] || "";
  els.biceps1.value = biceps[0] || "";
  els.biceps2.value = biceps[1] || "";
  els.biceps3.value = biceps[2] || "";

  const rows = summarizeWeekHistory();
  els.weekHistoryList.innerHTML = "";
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No sessions in the last 7 days yet.";
    els.weekHistoryList.appendChild(li);
    return;
  }
  rows.forEach((row) => {
    const li = document.createElement("li");
    li.textContent = row;
    els.weekHistoryList.appendChild(li);
  });
}

function renderWorkout() {
  els.statusText.textContent = `Session: ${state.activeSession ? "Active" : "Inactive"}${
    state.recognitionListening ? " | Mic: ON" : " | Mic: OFF"
  }`;

  els.setList.innerHTML = "";
  const recent = getRecentEntries();
  if (!recent.length) {
    const li = document.createElement("li");
    li.textContent = "No sets logged yet.";
    els.setList.appendChild(li);
  } else {
    recent.forEach((entry) => {
      const li = document.createElement("li");
      li.textContent = `${entry.exercise} - ${entry.weight} ${WEIGHT_UNIT} x ${entry.reps}`;
      els.setList.appendChild(li);
    });
  }

  els.sessionExerciseList.innerHTML = "";
  if (!state.activeSession) {
    const li = document.createElement("li");
    li.textContent = "No active workout.";
    els.sessionExerciseList.appendChild(li);
    return;
  }
  const planned = state.activeSession.plannedExercises || [];
  if (!planned.length) {
    const li = document.createElement("li");
    li.textContent = "No planned exercises selected.";
    els.sessionExerciseList.appendChild(li);
  } else {
    planned.forEach((exercise) => {
      const li = document.createElement("li");
      li.textContent = exercise;
      els.sessionExerciseList.appendChild(li);
    });
  }
}

function renderAll() {
  renderHome();
  renderWorkout();
}

function startWorkoutFlow() {
  if (state.activeSession) {
    respond("Workout already active. Keep logging sets.");
    return;
  }
  state.phase = "awaiting_muscles";
  respond("Which muscles are we working on today? For now I support chest and biceps.");
}

function startSessionWithPlan(muscles, plannedExercises, usedUsual) {
  state.activeSession = {
    id: uid(),
    startedAt: nowIso(),
    muscles,
    usedUsual,
    plannedExercises,
    entries: [],
  };
  state.phase = "idle";
  state.pendingMuscles = [];
  persistState();
  renderAll();
  respond(`Workout started for ${muscles.join(" and ")}. Log sets whenever you're ready.`);
}

function finalizeWorkout() {
  if (!state.activeSession) {
    respond("No active workout to end.");
    return;
  }
  const completed = {
    ...state.activeSession,
    endedAt: nowIso(),
  };
  state.sessions.push(completed);
  state.activeSession = null;
  state.phase = "idle";
  state.pendingMuscles = [];
  persistState();
  renderAll();
  respond("Workout ended and saved. Nice session.");
}

function logSet(parsed) {
  if (!state.activeSession) {
    state.activeSession = {
      id: uid(),
      startedAt: nowIso(),
      muscles: [],
      usedUsual: false,
      plannedExercises: [],
      entries: [],
    };
  }
  const entries = Array.from({ length: parsed.setsCount }, () => ({
    id: uid(),
    exercise: parsed.exercise,
    weight: parsed.weight,
    reps: parsed.reps,
    createdAt: nowIso(),
  }));
  state.activeSession.entries.push(...entries);
  persistState();
  renderAll();
  const repsNote = parsed.assumedReps ? " (defaulted reps to 10)" : "";
  respond(`Saved ${parsed.setsCount} set(s): ${parsed.exercise} ${parsed.weight} ${WEIGHT_UNIT} x ${parsed.reps}${repsNote}.`);
}

function getImprovementReply(text) {
  const exercise = inferExerciseFromQuestion(text);
  if (!exercise) {
    return "Ask improvement for a specific exercise, for example: How much did I improve from last week on bench?";
  }

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const entries = flattenEntries().filter((e) => e.exercise === exercise);
  const thisWeek = entries.filter((e) => new Date(e.createdAt).getTime() >= sevenDaysAgo);
  const lastWeek = entries.filter((e) => {
    const ts = new Date(e.createdAt).getTime();
    return ts >= fourteenDaysAgo && ts < sevenDaysAgo;
  });
  if (!thisWeek.length || !lastWeek.length) {
    return "Not enough data to compare this week vs last week yet.";
  }
  const maxThis = Math.max(...thisWeek.map((e) => e.weight));
  const maxLast = Math.max(...lastWeek.map((e) => e.weight));
  const diff = maxThis - maxLast;
  if (diff === 0) return `No change on ${exercise} versus last week (top set ${maxThis} ${WEIGHT_UNIT}).`;
  if (diff > 0) return `Great progress: +${diff} ${WEIGHT_UNIT} on ${exercise} compared to last week.`;
  return `You are ${Math.abs(diff)} ${WEIGHT_UNIT} below last week on ${exercise}.`;
}

function processPhase(text) {
  if (state.phase === "awaiting_muscles") {
    const muscles = extractMuscles(text);
    if (!muscles.length) {
      respond("I caught that, but please mention chest and/or biceps.");
      return true;
    }
    state.pendingMuscles = muscles;
    state.phase = "awaiting_plan_choice";
    respond("Nice. Do you want your usual exercises, or do you want to change them for today?");
    return true;
  }
  if (state.phase === "awaiting_plan_choice") {
    if (isYes(text)) {
      const planned = state.pendingMuscles.flatMap((m) => (state.plan[m] || []).filter(Boolean));
      startSessionWithPlan(state.pendingMuscles, planned, true);
      return true;
    }
    if (isChange(text)) {
      state.phase = "awaiting_custom_exercises";
      respond("Tell me your custom exercises separated by commas.");
      return true;
    }
    respond("Please say 'usual' or 'change'.");
    return true;
  }
  if (state.phase === "awaiting_custom_exercises") {
    const exercises = text
      .split(",")
      .map((s) => normalizeExercise(s))
      .filter(Boolean);
    if (!exercises.length) {
      respond("Please provide at least one exercise, separated by commas.");
      return true;
    }
    startSessionWithPlan(state.pendingMuscles, exercises, false);
    return true;
  }
  return false;
}

async function interpretWithBackend(message) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) throw new Error("Backend parse failed");
  return response.json();
}

function applyBackendIntent(parsed, rawText) {
  if (parsed.intent === "jarvis_greeting") {
    respondJarvisWake();
    return true;
  }
  if (parsed.intent === "start_workout") {
    startWorkoutFlow();
    return true;
  }
  if (parsed.intent === "end_workout") {
    finalizeWorkout();
    return true;
  }
  if (parsed.intent === "log_set") {
    const setsCount = Math.max(1, Number(parsed.sets_count || 1));
    const reps = Math.max(1, Number(parsed.reps || 10));
    const weight = Number(parsed.weight || 0);
    const exercise = normalizeExercise(parsed.exercise || "");
    if (!weight || !exercise) return false;
    logSet({ setsCount, reps, weight, exercise, assumedReps: !parsed.reps });
    return true;
  }
  if (parsed.intent === "last_bench") {
    const bench = flattenEntries()
      .filter((e) => e.exercise === "barbell bench press")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!bench) {
      respond("No bench history yet.");
      return true;
    }
    respond(`Last bench: ${bench.weight} ${WEIGHT_UNIT} x ${bench.reps}.`);
    return true;
  }
  if (parsed.intent === "muscle_alternatives") {
    const muscle = (parsed.muscle || "").toLowerCase();
    const list = (state.plan[muscle] || []).join(", ");
    respond(list ? `${muscle}: ${list}` : "I currently support chest and biceps.");
    return true;
  }
  if (asksProgressFromLastWeek(rawText)) {
    respond(getImprovementReply(rawText));
    return true;
  }
  return false;
}

function fallbackProcess(text) {
  if (isJarvisWakePhrase(text)) return respondJarvisWake();
  if (processPhase(text)) return;

  const lower = text.toLowerCase();
  if (lower.includes("start workout")) return startWorkoutFlow();
  if (lower.includes("end workout")) return finalizeWorkout();
  if (asksProgressFromLastWeek(text)) return respond(getImprovementReply(text));

  const parsed = parseSetLogIntent(text);
  if (parsed) return logSet(parsed);

  respond("Try: start workout, then tell me muscles, then log sets like 'log bench 80 kg 8 reps 3 sets'.");
}

async function processCommand(text) {
  const input = text.trim();
  if (!input) {
    respond("I did not catch that.");
    return;
  }
  if (isJarvisWakePhrase(input)) {
    respondJarvisWake();
    els.transcriptInput.value = "";
    return;
  }
  if (processPhase(input)) {
    els.transcriptInput.value = "";
    return;
  }
  try {
    const parsed = await interpretWithBackend(input);
    const handled = applyBackendIntent(parsed, input);
    if (!handled) fallbackProcess(input);
  } catch {
    fallbackProcess(input);
  }
  els.transcriptInput.value = "";
}

function savePlanFromInputs() {
  state.plan = {
    chest: [els.chest1.value, els.chest2.value, els.chest3.value].map((x) => normalizeExercise(x)).filter(Boolean),
    biceps: [els.biceps1.value, els.biceps2.value, els.biceps3.value]
      .map((x) => normalizeExercise(x))
      .filter(Boolean),
  };
  persistState();
  renderHome();
  respond("Usual plan saved.");
}

function setupEvents() {
  els.tabHomeBtn.addEventListener("click", () => switchTab("home"));
  els.tabWorkoutBtn.addEventListener("click", () => switchTab("workout"));
  els.savePlanBtn.addEventListener("click", savePlanFromInputs);
  els.processTypedBtn.addEventListener("click", () => {
    processCommand(els.transcriptInput.value).catch(() => respond("Could not process command."));
  });
  els.transcriptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      processCommand(els.transcriptInput.value).catch(() => respond("Could not process command."));
    }
  });
}

function setupSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.holdToTalkBtn.disabled = true;
    els.statusText.textContent = "Session: Inactive | Mic: unsupported";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  const startListening = () => {
    if (state.recognitionListening) return;
    state.recognitionListening = true;
    els.holdToTalkBtn.classList.add("listening");
    recognition.start();
    renderWorkout();
  };

  const stopListening = () => {
    if (!state.recognitionListening) return;
    state.recognitionListening = false;
    els.holdToTalkBtn.classList.remove("listening");
    recognition.stop();
    renderWorkout();
  };

  els.holdToTalkBtn.addEventListener("mousedown", startListening);
  els.holdToTalkBtn.addEventListener("mouseup", stopListening);
  els.holdToTalkBtn.addEventListener("mouseleave", stopListening);
  els.holdToTalkBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startListening();
  });
  els.holdToTalkBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    stopListening();
  });
  els.holdToTalkBtn.addEventListener("click", () => {
    if (state.recognitionListening) stopListening();
    else startListening();
  });

  recognition.onresult = (event) => {
    const spoken = event.results[0][0].transcript || "";
    els.transcriptInput.value = spoken;
    processCommand(spoken).catch(() => respond("Could not process voice command."));
  };
  recognition.onerror = () => {
    state.recognitionListening = false;
    els.holdToTalkBtn.classList.remove("listening");
    renderWorkout();
    respond("Voice capture failed. You can still type commands.");
  };
  recognition.onend = () => {
    state.recognitionListening = false;
    els.holdToTalkBtn.classList.remove("listening");
    renderWorkout();
  };
}

setupEvents();
setupSpeech();
switchTab("home");
persistState();
renderAll();
