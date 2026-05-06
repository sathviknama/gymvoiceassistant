import json
import os
import re
import asyncio
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

_backend_dir = Path(__file__).resolve().parent
_project_root = _backend_dir.parent
# Root .env then backend/.env so either location works; backend overrides root.
load_dotenv(_project_root / ".env")
load_dotenv(_backend_dir / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("EXPO_PUBLIC_GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY") or os.getenv("EXPO_PUBLIC_ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID") or os.getenv("EXPO_PUBLIC_ELEVENLABS_VOICE_ID")
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY") or os.getenv("EXPO_PUBLIC_DEEPGRAM_API_KEY")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-2")
DEEPGRAM_KEYWORDS = [
  "jarvis",
  "bench press",
  "barbell bench press",
  "incline bench",
  "incline dumbbell press",
  "chest fly",
  "dumbbell bicep curl",
  "hammer curl",
  "preacher curl",
  "cable curl",
  "lat pulldown",
  "romanian deadlift",
  "overhead press",
  "tricep extension",
  "pushdown",
  "kgs",
  "reps",
  "sets",
]
KNOWLEDGE_PATH = (
  Path(__file__).resolve().parents[1] / "knowledge-base" / "exercise-knowledge.json"
)

JARVIS_GREETING_REPLY = (
  "For you sir, always. How can I help you today?"
)

# ─────────────────────────────────────────────────────────────
# SYSTEM_PROMPT  –  intent parser
# Key change: added explicit anti-textbook rules to the `reply`
# field guidance so the LLM never dumps anatomy jargon lists.
# ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = f"""
You are a gym assistant command parser.
Output ONLY valid JSON and no markdown.

Supported intents:
- jarvis_greeting (user says hi to Jarvis, e.g. "Hey Jarvis you up?")
- start_workout
- end_workout
- log_set
- last_bench
- muscle_alternatives
- unknown

Focus semantic normalization on chest and biceps only.
Canonical chest exercises:
- barbell bench press
- dumbbell bench press
- incline barbell bench press
- incline dumbbell press
- chest fly

Canonical biceps exercises:
- dumbbell bicep curl
- hammer curl
- barbell curl
- preacher curl
- cable curl

Normalize user variants, including misspellings like "dumbell".
If user asks "list chest exercises" or "alternatives for biceps", use muscle_alternatives.

JSON schema:
{{
  "intent": "jarvis_greeting|start_workout|end_workout|log_set|last_bench|muscle_alternatives|unknown",
  "exercise": "string or null",
  "weight": "number or null",
  "reps": "integer or null",
  "sets_count": "integer or null",
  "muscle": "chest|biceps|null",
  "reply": "short assistant reply, warm coach voice, max 2 short sentences"
}}

Voice for the `reply` field — CRITICAL RULES:
- You are a real coach talking out loud between sets. NOT writing a textbook. NOT making a list.
- NEVER use semicolons to chain exercise descriptions. NEVER say "Muscle: anatomy detail (parenthetical)...".
- BAD example: "Biceps: long head (outer peak), short head (inner thickness). Barbell curl for overall size; preacher for short-head isolation."
- GOOD example: "Nice — I'd go with dumbbell curls to start, hammer curls for thickness, and a preacher curl to finish it off."
- Keep it to 1–2 short spoken sentences. Warm, direct, like a trainer standing next to you.
- Use contractions: you're, let's, that's, here's. One natural opener is fine: "Alright", "Got it", "Nice", "Okay so".
- Never use the words: intent, parser, logged, JSON. Say "saved" or "noted" instead.

Rules:
- For log_set, if sets are omitted set sets_count=1.
- For log_set, if reps are omitted set reps=10.
- Weight unit is kg.
- Understand natural language in any order, e.g.:
  - "log bicep curls 20 kg 10 reps 3 sets"
  - "add 3 sets of dumbbell press at 20 kg for 10 reps"
- For jarvis_greeting, set reply exactly to: {JARVIS_GREETING_REPLY!r}
""".strip()

try:
  KNOWLEDGE_BASE = json.loads(KNOWLEDGE_PATH.read_text(encoding="utf-8"))
except Exception:
  KNOWLEDGE_BASE = {"muscles": {}}


class ChatRequest(BaseModel):
  message: str


class ChatResponse(BaseModel):
  intent: str
  exercise: Optional[str] = None
  weight: Optional[float] = None
  reps: Optional[int] = None
  sets_count: Optional[int] = None
  muscle: Optional[str] = None
  reply: str


class CoachRequest(BaseModel):
  message: str


class CoachResponse(BaseModel):
  reply: str


class TtsRequest(BaseModel):
  text: str


class SayRequest(BaseModel):
  kind: str
  payload: Optional[Dict[str, Any]] = None
  enrich: bool = True


class SayResponse(BaseModel):
  reply: str


class SttResponse(BaseModel):
  transcript: str


app = FastAPI(title="Gym Voice Assistant Backend")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)


def extract_json(raw_text: str) -> Dict[str, Any]:
  clean = raw_text.strip()
  if clean.startswith("```"):
    clean = re.sub(r"^```(?:json)?", "", clean, flags=re.IGNORECASE).strip()
    clean = re.sub(r"```$", "", clean).strip()
  first = clean.find("{")
  last = clean.rfind("}")
  if first >= 0 and last >= 0 and first < last:
    clean = clean[first : last + 1]
  return json.loads(clean)


def deepgram_query_string(streaming: bool = False) -> str:
  full: list[tuple[str, str]] = [
    ("model", DEEPGRAM_MODEL),
    ("smart_format", "true"),
    ("punctuate", "true"),
    ("numerals", "true"),
    ("utterance_end_ms", "700"),
  ]
  full.extend([("keywords", f"{kw}:2") for kw in DEEPGRAM_KEYWORDS])
  if streaming:
    full.extend([
      ("interim_results", "true"),
      ("endpointing", "150"),
      ("vad_events", "true"),
    ])
  return urlencode(full, doseq=True)


def is_jarvis_wake(message: str) -> bool:
  text = message.lower().strip()
  if "jarvis" not in text:
    return False
  if parse_log_from_text(text):
    return False
  return (
    "you up" in text
    or "are you up" in text
    or "you there" in text
    or ("awake" in text and "?" in text)
  )


def fallback_parse(message: str) -> Dict[str, Any]:
  text = message.lower().strip()
  if is_jarvis_wake(text):
    return {
      "intent": "jarvis_greeting",
      "reply": JARVIS_GREETING_REPLY,
    }
  if "start workout" in text:
    return {
      "intent": "start_workout",
      "reply": "Alright, let's get to work. Call out your sets when you're done with each one.",
    }
  if "end workout" in text:
    return {
      "intent": "end_workout",
      "reply": "Nice session. That's a wrap—I've got it saved for you.",
    }
  if "last bench" in text or "how much did i bench" in text:
    return {
      "intent": "last_bench",
      "reply": "Hmm, let me pull up your last bench day for you.",
    }
  if "chest" in text and ("list" in text or "alternative" in text):
    return {
      "intent": "muscle_alternatives",
      "muscle": "chest",
      "reply": "Sure, here are some solid chest options to pick from.",
    }
  if ("bicep" in text or "biceps" in text) and ("list" in text or "alternative" in text):
    return {
      "intent": "muscle_alternatives",
      "muscle": "biceps",
      "reply": "Sure, here are some solid biceps options to pick from.",
    }
  knowledge_reply = answer_knowledge_query(text)
  if knowledge_reply:
    return {"intent": "knowledge_answer", "reply": knowledge_reply}
  parsed_log = parse_log_from_text(text)
  if parsed_log:
    return parsed_log
  return {
    "intent": "unknown",
    "reply": "Hmm, I didn't quite catch that. Try something like 'log bench 100 for 5'—or just tell me which muscle you're training.",
  }


# ─────────────────────────────────────────────────────────────
# answer_knowledge_query
# Key change: replies are now written as spoken coach sentences,
# not anatomy-label dumps. The raw JSON data is used as a source
# of truth but the reply is always composed as natural speech.
# ─────────────────────────────────────────────────────────────
def answer_knowledge_query(text: str) -> Optional[str]:
  """Rule-based answers from `exercise-knowledge.json` (no LLM)."""
  lower = text.lower().strip()
  if not lower:
    return None

  muscles = KNOWLEDGE_BASE.get("muscles", {})

  # Match anatomy / region labels (e.g. "upper chest", "long head")
  for muscle_name, muscle_data in muscles.items():
    for part in muscle_data.get("parts", []):
      part_hit = bool(part and part in lower)
      if part and not part_hit and part == "calves":
        part_hit = bool(re.search(r"\bcalf\b|calf muscle", lower))
      if part and part_hit:
        picks: list[str] = []
        for ex in muscle_data.get("exercises", []):
          targets = " ".join(ex.get("targets", []))
          if part in targets:
            n = ex.get("name")
            if n:
              picks.append(n)
        if picks:
          uniq: list[str] = []
          for p in picks:
            if p not in uniq:
              uniq.append(p)
          # Compose as natural spoken sentences, not a semicolon list
          exercise_list = ", ".join(uniq[:4])
          if len(uniq) > 4:
            exercise_list = ", ".join(uniq[:4]) + f", and {uniq[4]}" if len(uniq) == 5 else ", ".join(uniq[:4]) + " and a few more"
          extra = ""
          if "upper chest" in part or (muscle_name == "chest" and "upper" in lower):
            extra = " Set the bench around 30 to 45 degrees — any steeper and your shoulders take over."
          return (
            f"Alright, for your {part} I'd go with {exercise_list}.{extra} "
            f"Want me to put together a rep range based on your goal?"
          )

  # Match specific exercise names mentioned in the question
  for _muscle_name, muscle_data in muscles.items():
    for exercise in muscle_data.get("exercises", []):
      name = exercise.get("name", "")
      if name and name in lower:
        targets = ", ".join(exercise.get("targets", [])) or "the primary muscle"
        secondary = ", ".join(exercise.get("secondary", [])) or "supporting muscles"
        notes = exercise.get("notes", "")
        # Compose as spoken sentences
        line = (
          f"Good pick. {name.capitalize()} is great for {targets}, "
          f"and you'll get some work in on {secondary} too."
        )
        if notes:
          line = f"{line} {notes}"
        return line.strip()

  # List exercises for a muscle when asked generally
  for muscle_name, muscle_data in muscles.items():
    muscle_word = bool(re.search(rf"\b{re.escape(muscle_name)}\b", lower))
    if (
      f"for {muscle_name}" in lower
      or f"{muscle_name} exercise" in lower
      or f"{muscle_name} exercises" in lower
      or (
        muscle_word
        and any(p in lower for p in ("what to", "movements", "ideas for", "suggest", "good exercises", "target", "should i do"))
      )
    ):
      ex_list = muscle_data.get("exercises", [])[:5]
      names = [e["name"] for e in ex_list]
      # Build a natural spoken sentence instead of a comma dump
      if len(names) >= 3:
        spoken = f"{', '.join(names[:-1])}, and {names[-1]}"
      else:
        spoken = " and ".join(names)
      return (
        f"Nice, {muscle_name} day. I'd go with {spoken} — that covers all the bases. "
        "Want me to put together a quick 3-move combo with sets and reps?"
      )

  ref = match_guide_sections(lower)
  if ref:
    return ref

  return None


def match_guide_sections(lower: str) -> Optional[str]:
  """Keyword match against guide_sections from exercise-knowledge.json (no LLM)."""
  sections = KNOWLEDGE_BASE.get("guide_sections") or []
  if not sections:
    return None
  words = set(re.findall(r"[a-z]{3,}", lower))
  if not words:
    return None
  best_body: Optional[str] = None
  best_score = 0
  for sec in sections:
    if not isinstance(sec, dict):
      continue
    title = (sec.get("title") or "").lower()
    content = (sec.get("content") or "").lower()
    keys = [str(k).lower() for k in sec.get("keywords", []) if k]
    blob = f"{title} {' '.join(keys)} {content}"
    score = sum(1 for w in words if w in blob)
    for k in keys:
      if k and k in lower:
        score += 4
    if score > best_score:
      best_score = score
      best_body = sec.get("content")
  if best_score >= 4 and best_body:
    return str(best_body).strip()
  return None


def answer_social_or_smalltalk(text: str) -> Optional[str]:
  """Short pleasantries (no LLM). Only for messages that look like pure chitchat, not training."""
  low = text.lower().strip()
  if len(low) > 160:
    return None
  # "Thank you, Jarvis" / "thanks Jarvis" — strip trailing name so thanks-only patterns match.
  t = re.sub(r"[, ]+jarvis\s*[!?.]*\s*$", "", low).strip()

  if re.match(
    r"^(thanks?|thank\s+you)(\s+(so\s+much|very\s+much|a\s+lot))?\s*[!.\s]*$",
    t,
  ) or re.match(r"^(thx|ty|cheers|much\s+obliged|much\s+appreciated)\s*[!.\s]*$", t):
    return "Anytime—that's what I'm here for. So, what's next on the plan?"
  if re.match(r"^(ok(ay)?|cool)[, ]+(thanks?|thank\s+you)\s*[!.\s]*$", t):
    return "You got it. Let me know whenever you're ready for the next set."
  if re.match(
    r"^(hi|hello|hey|hiya|good\s+(morning|afternoon|evening))\s*[!.\s]*$",
    t,
  ) or re.match(r"^(what\'?s\s+up|sup)\s*\??\s*$", t):
    return "Hey, good to hear from you. So—what are we training today?"
  if re.match(r"^(bye|good\s*bye|see\s+ya|see\s+you|later|cya|peace)\s*[!.\s]*$", t):
    return "Alright, go crush it. Catch you next session."
  if re.match(r"^how(\'?re|r)\s+you\s*\??\s*$", t):
    return "Honestly? Ready to put in some work. How about you—what are we hitting?"
  return None


# ─────────────────────────────────────────────────────────────
# COACH_SYSTEM  –  free-form coaching replies
# Key changes:
#   1. Explicit "NEVER do this" examples using the bad pattern
#      from the screenshot so the LLM knows exactly what to avoid.
#   2. Added "mirror the Maya prompt style" guidance — one thing
#      at a time, spoken out loud, warm but not robotic.
#   3. Stronger ban on anatomy-label formatting.
# ─────────────────────────────────────────────────────────────
COACH_SYSTEM = """You are Jarvis — a warm, encouraging personal trainer speaking through a voice assistant.
The user HEARS your reply out loud, so every word must sound natural spoken, not read.

# The golden rule
Imagine a trainer standing next to someone at the gym, talking between sets.
That's the voice. Short. Warm. Direct. Human.

# What you must NEVER do (critical)
- NEVER structure replies like a textbook or anatomy lesson.
- NEVER use the pattern "Muscle: detail (parenthetical); next item; next item."
  BAD: "Biceps: long head (outer peak), short head (inner thickness), brachialis. Barbell curl for overall size; incline curl for long head stretch; preacher for short-head isolation; hammer for brachialis and forearms."
  That response sounds like Wikipedia read aloud. It is robotic. Do not do it.
- NEVER use semicolons to chain exercise descriptions.
- NEVER open with an anatomy breakdown. Lead with the exercise recommendation.
- NEVER use markdown: no asterisks, no numbered lists with periods, no headers.

# What you MUST do instead
- Lead with the answer, spoken naturally.
  GOOD: "Yeah sure, biceps day. I'd go with dumbbell curls first, then hammer curls for thickness, and finish with a preacher curl for that deep stretch. Want a rep range?"
- Keep it to 2-4 short sentences, or 3-5 short dashed bullets at most (voice-friendly).
- Use contractions: I'd, you're, let's, that's, here's, we'll, gonna, kinda.
- Open with ONE casual human filler. Vary it every reply. Pull freely from:
  "Yeah,", "Yeah sure,", "Sure,", "Okay,", "Okay so—", "Alright,", "Right,",
  "Hmm,", "Mhm,", "Yep,", "Totally,", "Oh nice,", "Nice,", "Got it,",
  "Honestly,", "Good one,", "For sure,", "Cool,", "No problem,".
- Never start two replies in a row with the same word.
- End with a short follow-up question when it feels natural: "Want me to suggest a rep range?", "Going heavy or light today?". Skip it if the user just wants a quick fact.
- Occasional encouragement is great — "you've got this", "love that question" — but once per reply max.

# Personality
- Warm, upbeat, a little witty. Confident, never preachy.
- You genuinely care about the user's progress.
- You speak the way a great trainer talks — suggest, don't lecture.

# Content rules
- Use the exercise knowledge JSON and guide sections when they fit; give safe mainstream guidance otherwise.
- Answer only what the user asked. Don't dump unrelated muscle groups.
- Avoid medical claims. For pain or injury, suggest checking with a physio.
- Use kg unless the user specifies another unit.
- Never offer features this app doesn't support. Do NOT ask things like "Should I create a plan?" or promise actions you cannot perform.
- Don't say "as an AI", "I am a model", "based on the JSON", "according to my data". You're a coach.
- Don't say "logged", "parsed", "intent", "fallback", "system". Say "saved", "noted", "got it".

# Examples of ideal replies
User: "what exercises should I do to target my biceps"
You: "Nice, biceps day. I'd start with dumbbell curls for overall size, then hammer curls for that thickness through the middle, and finish with a preacher curl for the stretch. Going for size or strength today?"

User: "is incline bench good for upper chest?"
You: "Yeah, it's one of the best for it. Set the bench around 30 to 45 degrees — any steeper and your shoulders start taking over. Want a quick upper-chest combo?"

User: "I'm sore from yesterday"
You: "Hmm, that's pretty normal after a heavy day. Light movement and stretching usually helps more than total rest. Where are you feeling it most?"
"""


async def generate_coach_reply(message: str) -> str:
  """LLM-backed coaching when GEMINI_API_KEY is set; otherwise knowledge heuristics."""
  trimmed = message.strip()
  low = trimmed.lower()
  kb_fallback = answer_knowledge_query(low)
  social = answer_social_or_smalltalk(trimmed)

  if not GEMINI_API_KEY:
    if kb_fallback:
      return kb_fallback
    if social:
      return social
    return (
      "Hmm, I'm not sure I caught that one. Try asking me something like "
      "\"give me biceps exercises\", \"what should I do for chest\", or "
      "\"how many reps for hypertrophy?\""
    )

  if social:
    return social
  if kb_fallback:
    return kb_fallback

  kb_text = json.dumps(KNOWLEDGE_BASE, ensure_ascii=False)
  url = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    f"?key={GEMINI_API_KEY}"
  )
  user_block = (
    f"{COACH_SYSTEM}\n\nExercise knowledge (JSON):\n{kb_text}\n\nUser question:\n{trimmed}"
  )
  payload: Dict[str, Any] = {
    "contents": [{"role": "user", "parts": [{"text": user_block}]}],
    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
  }
  try:
    async with httpx.AsyncClient(timeout=45) as client:
      response = await client.post(url, json=payload)
  except Exception:
    return kb_fallback or "Hmm, I'm having trouble reaching my brain right now. Give me a sec and try again."

  if response.status_code >= 400:
    social_retry = answer_social_or_smalltalk(trimmed)
    if social_retry:
      return social_retry
    return kb_fallback or "Hmm, something's off on my end. Try that again in a moment?"

  data = response.json()
  text = (
    data.get("candidates", [{}])[0]
    .get("content", {})
    .get("parts", [{}])[0]
    .get("text", "")
  )
  text = (text or "").strip()
  if text:
    return text
  return kb_fallback or "Hmm, I drew a blank there. Mind asking that a different way?"


def normalize_exercise_name(exercise: str) -> str:
  value = exercise.lower().strip()
  alias_map = {
    "bench": "barbell bench press",
    "bench press": "barbell bench press",
    "barbell bench": "barbell bench press",
    "dumbell press": "dumbbell bench press",
    "db press": "dumbbell bench press",
    "dumbbell press": "dumbbell bench press",
    "flat db press": "dumbbell bench press",
    "bicep curl": "dumbbell bicep curl",
    "bicep curls": "dumbbell bicep curl",
    "biceps curl": "dumbbell bicep curl",
    "arm curl": "dumbbell bicep curl",
    "db curl": "dumbbell bicep curl",
    "dumbell curl": "dumbbell bicep curl",
  }
  if value in alias_map:
    return alias_map[value]
  for key, canonical in alias_map.items():
    if key in value:
      return canonical
  return value


def parse_log_from_text(text: str) -> Optional[Dict[str, Any]]:
  if not any(word in text for word in ["log", "add"]):
    return None

  weight_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:kg|kgs?)\b", text)
  if not weight_match:
    weight_match = re.search(r"(?:at|with)\s+(\d+(?:\.\d+)?)\b", text)
  reps_match = re.search(r"(\d+)\s*reps?\b", text)
  sets_match = re.search(r"(\d+)\s*sets?\b", text)
  x_format = re.search(r"(\d+(?:\.\d+)?)\s*x\s*(\d+)", text)

  weight = float(weight_match.group(1)) if weight_match else None
  reps = int(reps_match.group(1)) if reps_match else None
  sets_count = int(sets_match.group(1)) if sets_match else None

  if x_format and not weight:
    weight = float(x_format.group(1))
  if x_format and not reps:
    reps = int(x_format.group(2))

  # Remove command/numeric phrases and treat remaining chunk as exercise name.
  exercise_text = text
  exercise_text = re.sub(r"\b(?:log|add|workout|my|please|can you)\b", " ", exercise_text)
  exercise_text = re.sub(r"\d+(?:\.\d+)?\s*(?:kg|kgs?)\b", " ", exercise_text)
  exercise_text = re.sub(r"\d+\s*reps?\b", " ", exercise_text)
  exercise_text = re.sub(r"\d+\s*sets?\b", " ", exercise_text)
  exercise_text = re.sub(r"\d+(?:\.\d+)?\s*x\s*\d+", " ", exercise_text)
  exercise_text = re.sub(r"\b(?:at|with|for|of)\b", " ", exercise_text)
  exercise_text = re.sub(r"\s+", " ", exercise_text).strip()
  exercise = normalize_exercise_name(exercise_text)

  if not exercise or weight is None:
    return None

  final_sets = sets_count if sets_count else 1
  final_reps = reps if reps else 10
  return {
    "intent": "log_set",
    "exercise": exercise,
    "weight": weight,
    "reps": final_reps,
    "sets_count": final_sets,
    "reply": f"Got it—{final_sets} set of {exercise} at {weight:g} kg for {final_reps}. Nice work."
    if final_sets == 1
    else f"Got it—{final_sets} sets of {exercise} at {weight:g} kg for {final_reps}. Keep it up.",
  }


def merge_log_fields_with_fallback(message: str, parsed: Dict[str, Any]) -> Dict[str, Any]:
  if parsed.get("intent") != "log_set":
    return parsed

  fallback = parse_log_from_text(message.lower().strip())
  if not fallback:
    return parsed

  merged = dict(parsed)
  for key in ["exercise", "weight", "reps", "sets_count"]:
    if merged.get(key) in [None, "", 0]:
      merged[key] = fallback.get(key)

  if not merged.get("reply"):
    merged["reply"] = fallback.get("reply", "Saved workout set.")
  return merged


async def call_gemini_parser(message: str) -> Dict[str, Any]:
  if not GEMINI_API_KEY:
    return fallback_parse(message)

  url = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    f"?key={GEMINI_API_KEY}"
  )
  payload = {
    "contents": [
      {
        "role": "user",
        "parts": [
          {"text": SYSTEM_PROMPT},
          {"text": f'User message: "{message}"'},
        ],
      }
    ]
  }

  async with httpx.AsyncClient(timeout=20) as client:
    response = await client.post(url, json=payload)

  if response.status_code >= 400:
    return fallback_parse(message)

  data = response.json()
  text = (
    data.get("candidates", [{}])[0]
    .get("content", {})
    .get("parts", [{}])[0]
    .get("text", "")
  )
  if not text:
    return fallback_parse(message)

  try:
    parsed = extract_json(text)
    return merge_log_fields_with_fallback(message, parsed)
  except Exception:
    return fallback_parse(message)


# ─────────────────────────────────────────────────────────────
# /api/say — single endpoint every spoken UI reply goes through.
# Frontend sends {kind, payload}; backend returns a Jarvis-voice
# string. Gemini phrases it when configured, otherwise a humanized
# template handles it instantly.
# ─────────────────────────────────────────────────────────────

COACH_VOICE_BRIEF = """You are Jarvis — a warm, casual gym coach speaking out loud to a user mid-session.
Talk like a real person at the gym, not like a chatbot.

# Voice rules
- Use contractions: you're, that's, let's, here's, we'll, gonna, kinda.
- Open with ONE casual human filler. Vary it every time. Pull from this list freely:
  "Yeah,", "Yeah sure,", "Sure,", "Okay,", "Okay so—", "Alright,", "Right,",
  "Hmm,", "Mhm,", "Yep,", "Totally,", "Oh nice,", "Nice,", "Got it,",
  "Honestly,", "Good one,", "For sure,", "Cool,", "No problem,".
- 1 to 3 short sentences, voice-friendly. No markdown, no numbered lists with periods, no semicolons chaining items.
- Light encouragement is good ("nice work", "you got this", "keep it up") but max once per reply.
- Sound like a coach standing next to the user — never like a system message.

# Hard rules
- Use ONLY facts in DATA. Never invent numbers, exercises, dates, weights, or muscles.
- Never say: "logged", "parsed", "intent", "JSON", "system", "as an AI", "based on the data".
  Say "saved", "noted", "got it", "I hear you" instead.
- When listing exercises, speak them naturally ("dumbbell curls, hammer curls, and a preacher curl"), NEVER as "1) ... 2) ...".

# Tone examples (mimic this energy)
- "Yeah sure, biceps day. Your usual is dumbbell curls, hammer curls, and a preacher curl. Want to keep it as is?"
- "Got it — dumbbell curl at 16 kilos for 10. Nice work, keep it up."
- "Hmm, no workout running right now. Just say 'start workout' whenever you're ready."
- "Okay, that one's saved. Solid session."
"""


def _natlist(items: Any, conj: str = "and") -> str:
  """Join items into a natural phrase: ['a','b','c'] -> 'a, b, and c'."""
  parts = [str(x).strip() for x in (items or []) if str(x).strip()]
  if not parts:
    return ""
  if len(parts) == 1:
    return parts[0]
  if len(parts) == 2:
    return f"{parts[0]} {conj} {parts[1]}"
  return f"{', '.join(parts[:-1])}, {conj} {parts[-1]}"


def _exname(name: Any) -> str:
  if not name:
    return ""
  s = str(name).strip()
  return (s[:1].upper() + s[1:]) if s else ""


def _set_edit_success_field(p: Dict[str, Any]) -> str:
  """Which quantity changed — prefer explicit marker from client, else infer from payload keys."""
  explicit = p.get("changedField") or p.get("editField")
  if explicit in ("weight", "reps", "sets"):
    return str(explicit)
  has_sets = "sets" in p
  has_weight = "weight" in p
  has_reps = "reps" in p
  if has_weight and has_reps and not has_sets:
    return "sets"
  if has_sets and has_reps and not has_weight:
    return "weight"
  if has_sets and has_weight and not has_reps:
    return "reps"
  raw = p.get("field")
  if raw in ("weight", "reps", "sets"):
    return str(raw)
  return "sets"


def _ex_phrase(planned: Any) -> str:
  return _natlist([_exname(x).lower() for x in (planned or [])])


SAY_TEMPLATES: Dict[str, Any] = {}


def _t(kind: str):
  def deco(fn):
    SAY_TEMPLATES[kind] = fn
    return fn
  return deco


@_t("wake_greeting")
def _t_wake(_p):
  return JARVIS_GREETING_REPLY


@_t("flow_start_prompt")
def _t_flow_start(_p):
  return "Alright, what are we hitting today? Just tell me the muscle groups—or ask me anything first."


@_t("muscles_chosen")
def _t_muscles_chosen(p):
  label = _natlist(p.get("muscles") or []) or "your workout"
  planned = _ex_phrase(p.get("planned") or [])
  if not planned:
    return (
      f"Alright, {label} day. Looks like your saved plan is empty — "
      "say 'add' followed by exercise names, then 'start workout' when you're set."
    )
  return (
    f"Alright, {label} day. Your usual lineup is {planned}. "
    "Want to keep it, or add, remove, or swap something before we start?"
  )


@_t("workout_already_active")
def _t_already_active(_p):
  return "Hmm, you've already got a workout going. Say 'end workout' first if you want to start a new one."


@_t("workout_started")
def _t_started(p):
  label = _natlist(p.get("muscles") or []) or "your"
  count = int(p.get("plannedCount") or 0)
  if count == 0:
    return f"Alright, {label} workout is on. Just call your sets out as you finish them."
  return f"Alright, {label} workout is on — I've got {count} exercises queued. Let's get to it."


@_t("workout_saved")
def _t_saved(_p):
  return "That's a wrap. Solid session — I've got it saved for you."


@_t("workout_no_active_end")
def _t_no_active_end(_p):
  return "Hmm, no workout running right now. Say 'start workout' or just name the muscles when you're ready."


@_t("workout_no_active_discard")
def _t_no_active_discard(_p):
  return "Nothing to discard — there's no workout running."


@_t("workout_discarded")
def _t_discarded(_p):
  return "Done — that one's cleared. Nothing was saved."


@_t("set_logged")
def _t_set_logged(p):
  name = _exname(p.get("exercise") or "that one").lower()
  weight = p.get("weight")
  reps = p.get("reps")
  sets = int(p.get("sets") or 1)
  unit = p.get("unit") or "kg"
  if sets == 1:
    return f"Got it — {name} at {weight} {unit} for {reps}. Nice work."
  return f"Got it — {sets} sets of {name} at {weight} {unit} for {reps}. Keep it up."


@_t("set_edit_no_entries")
def _t_set_edit_no_entries(_p):
  return "Hmm, there isn't a recent set to edit yet."


@_t("set_edit_invalid")
def _t_set_edit_invalid(_p):
  return "Hmm, give me a whole set count above zero."


@_t("set_edit_same")
def _t_set_edit_same(p):
  name = _exname(p.get("exercise") or "that lift").lower()
  field = str(p.get("field") or "sets")
  value = p.get("value")
  unit = p.get("unit") or "kg"
  if field == "weight":
    return f"Yep, {name} is already at {value} {unit}."
  if field == "reps":
    return f"Yep, {name} is already at {value} reps."
  return f"Yep, {name} is already set to {value}."


@_t("set_edit_not_found")
def _t_set_edit_not_found(p):
  name = p.get("exercise") or "that exercise"
  return f"Hmm, I couldn't find {name} in your recent logged sets."


@_t("set_edit_success")
def _t_set_edit_success(p):
  name = _exname(p.get("exercise") or "that lift").lower()
  field = _set_edit_success_field(p)
  frm = p.get("from")
  to = p.get("to")
  unit = p.get("unit") or "kg"
  if field == "weight":
    return f"Got it — I changed {name} from {frm} {unit} to {to} {unit}. Nice catch."
  if field == "reps":
    return f"Got it — I changed {name} from {frm} reps to {to} reps. Nice catch."
  try:
    fi = int(frm) if frm is not None else 0
    ti = int(to) if to is not None else 0
  except (TypeError, ValueError):
    fi = ti = 0
  fs = "set" if fi == 1 else "sets"
  ts = "set" if ti == 1 else "sets"
  return f"Got it — I changed {name} from {frm} {fs} to {to} {ts}. Nice catch."


@_t("plan_show")
def _t_plan_show(p):
  planned = _ex_phrase(p.get("planned") or [])
  if not planned:
    return "Your list is empty right now. Add an exercise or two first."
  return f"Right now you've got {planned}."


@_t("plan_start_empty")
def _t_plan_start_empty(_p):
  return "Hmm, your list is empty. Say 'add' and the exercise names first, then we can start."


@_t("plan_save_empty")
def _t_plan_save_empty(_p):
  return "Can't save an empty plan. Add at least one exercise first."


@_t("plan_saved")
def _t_plan_saved(_p):
  return "Saved — that's your regular plan now."


@_t("plan_help")
def _t_plan_help(_p):
  return (
    "You can say add, remove, replace one with another, save as regular, "
    "show the list, or just say start workout when you're ready."
  )


@_t("plan_added")
def _t_plan_added(p):
  planned = _ex_phrase(p.get("planned") or [])
  return f"Added. Your list is now {planned}." if planned else "Added."


@_t("plan_add_empty")
def _t_plan_add_empty(_p):
  return "Tell me what to add — like 'add cable curl, incline curl'."


@_t("plan_removed")
def _t_plan_removed(p):
  planned = _ex_phrase(p.get("planned") or [])
  if not planned:
    return "Removed. Your list is empty now — add something before we start."
  return f"Removed. Your list is now {planned}."


@_t("plan_remove_empty")
def _t_plan_remove_empty(_p):
  return "Tell me which one to remove — like 'remove preacher curl'."


@_t("plan_remove_not_found")
def _t_plan_remove_not_found(_p):
  return "Hmm, I couldn't find that one in your list."


@_t("plan_replaced")
def _t_plan_replaced(p):
  planned = _ex_phrase(p.get("planned") or [])
  return f"Updated. Your list is now {planned}." if planned else "Updated."


@_t("plan_replace_usage")
def _t_plan_replace_usage(_p):
  return "Try it like this: 'replace preacher curl with cable curl'."


@_t("plan_replace_not_found")
def _t_plan_replace_not_found(p):
  old = _exname(p.get("oldEx") or "that one").lower()
  return f"Hmm, I couldn't find {old} in your list."


@_t("plan_replace_already")
def _t_plan_replace_already(p):
  old = _exname(p.get("oldEx") or "that one").lower()
  new = _exname(p.get("newEx") or "the new one").lower()
  return (
    f"{new[:1].upper() + new[1:]} is already in your list, so I left it alone. "
    f"Say 'remove {old}' if you want fewer exercises."
  )


@_t("delete_no_saved")
def _t_delete_no_saved(_p):
  return "Hmm, you don't have any saved workouts yet — nothing to delete."


@_t("deleted_last_saved")
def _t_deleted_last_saved(_p):
  return "Done — your most recent workout is gone."


@_t("summary_no_data")
def _t_summary_no_data(p):
  muscle = p.get("muscle") or "that muscle"
  return (
    f"Hmm, I don't see any saved {muscle} workouts yet. "
    "Finish one and I'll have something to summarize."
  )


@_t("summary_last_workout")
def _t_summary_last_workout(p):
  muscle = p.get("muscle") or "your last"
  sets = p.get("sets") or 0
  volume = p.get("volume") or 0
  unit = p.get("unit") or "kg"
  date = p.get("date") or ""
  top = p.get("top") or []
  top_part = ""
  if top:
    top_part = f" Your top sets were {_natlist(top[:2])}."
  date_part = f" on {date}" if date else ""
  return (
    f"Last {muscle} day{date_part}: {sets} sets, around {volume} {unit}-reps total.{top_part}"
  )


@_t("improvement_need_more")
def _t_improvement_need_more(p):
  muscle = p.get("muscle") or "that muscle"
  return (
    f"Hmm, I need at least two saved {muscle} workouts before I can talk progress. "
    "Get one more done and I'll have something to compare."
  )


@_t("improvement_summary")
def _t_improvement_summary(p):
  muscle = p.get("muscle") or "that muscle"
  dv = p.get("deltaVolume") or 0
  pct = p.get("deltaPct")
  ds = p.get("deltaSets") or 0
  unit = p.get("unit") or "kg"
  direction = "up" if dv >= 0 else "down"
  pct_part = f" (about {abs(pct)} percent {direction})" if pct is not None else ""
  sets_part = f"{abs(ds)} {'more' if ds >= 0 else 'fewer'} sets"
  encouragement = "Nice progress." if dv >= 0 else "Don't sweat it — recovery weeks happen."
  return (
    f"Compared to last time, your {muscle} volume's {direction} by about {abs(dv)} {unit}-reps{pct_part}, "
    f"with {sets_part}. {encouragement}"
  )


@_t("compare_no_muscle")
def _t_compare_no_muscle(_p):
  return "Tell me which muscle to compare — like 'compare my last two chest workouts'."


@_t("compare_need_more")
def _t_compare_need_more(p):
  muscle = p.get("muscle") or "that muscle"
  return (
    f"Hmm, I need at least two saved {muscle} workouts to compare. "
    "Finish another one and we'll line them up."
  )


@_t("compare_result")
def _t_compare_result(p):
  muscle = p.get("muscle") or "your"
  newer = p.get("newer") or {}
  older = p.get("older") or {}
  dv = (newer.get("volume") or 0) - (older.get("volume") or 0)
  pct = p.get("deltaPct")
  ds = (newer.get("sets") or 0) - (older.get("sets") or 0)
  ups = p.get("ups") or []
  unit = p.get("unit") or "kg"
  direction = "up" if dv >= 0 else "down"
  pct_part = f" (about {abs(pct)} percent {direction})" if pct is not None else ""
  sets_part = f"{abs(ds)} {'more' if ds >= 0 else 'fewer'} sets in the latest"
  pr_part = (
    f" You went heavier on {_natlist(ups[:3])}." if ups else " Top weights were similar across the board."
  )
  return (
    f"Here's your {muscle} comparison. Volume's {direction} by about {abs(dv)} {unit}-reps{pct_part}, "
    f"with {sets_part}.{pr_part}"
  )


@_t("bench_no_data")
def _t_bench_no_data(_p):
  return "Hmm, not enough bench history yet for a week-over-week comparison."


@_t("bench_progress")
def _t_bench_progress(p):
  diff = p.get("diff") or 0
  unit = p.get("unit") or "kg"
  if diff >= 0:
    return f"Nice — you're up {diff} {unit} on bench compared to before. Keep it going."
  return f"You're {abs(diff)} {unit} below your previous bench mark. Don't sweat it — happens to everyone."


@_t("unknown_help")
def _t_unknown_help(_p):
  return (
    "Hmm, I didn't quite catch that. You can name a muscle to start, log a set "
    "like 'log bench 60 kilos for 8', or just ask me anything about training."
  )


@_t("backend_unreachable")
def _t_backend_unreachable(_p):
  return "Hmm, can't reach my brain right now. Make sure the backend is running and try again."


@_t("voice_error")
def _t_voice_error(_p):
  return "Hmm, I missed that one. Mind saying it again?"


SAY_INSTRUCTIONS: Dict[str, str] = {
  "wake_greeting": "User just woke you up. Greet them warmly and ask what we're training today.",
  "flow_start_prompt": "User asked to start a workout but hasn't picked muscles yet. Ask which muscles in a friendly way.",
  "muscles_chosen": "User picked one or more muscles for today. Confirm warmly, read their saved plan exercises naturally (NOT numbered), and ask if they want to keep it, add, remove, or swap something before starting.",
  "workout_already_active": "User tried to start a new workout, but one is already active. Tell them gently and offer to end the current one first.",
  "workout_started": "Workout has just begun. Briefly hype them up; mention how many exercises are queued if greater than zero.",
  "workout_saved": "Workout just ended and was saved. Brief congrats.",
  "workout_no_active_end": "User tried to end a workout but none is active.",
  "workout_no_active_discard": "User tried to discard a workout, but none is running.",
  "workout_discarded": "An active workout was discarded — nothing was saved. Confirm calmly.",
  "set_logged": "A set was just logged. Confirm with exercise, weight, reps, and number of sets, in a coach voice. Brief encouragement at the end.",
  "set_edit_no_entries": "User asked to edit set count, but there is no recent set entry to edit.",
  "set_edit_not_found": "User asked to edit an exercise that wasn't found in recent logged entries.",
  "set_edit_invalid": "User gave an invalid value while editing sets/reps/weight (zero/negative/non-sense). Ask for a valid positive number.",
  "set_edit_same": "User asked to edit sets/reps/weight, but that field is already the requested value. Confirm briefly.",
  "set_edit_success": "User corrected sets/reps/weight for the latest logged set block. Confirm old value to new value in a natural coach tone.",
  "plan_show": "User asked to see their planned exercises. Read them naturally, not as a numbered list.",
  "plan_start_empty": "User said start but plan is empty. Tell them to add exercises first.",
  "plan_save_empty": "User wanted to save plan but it's empty.",
  "plan_saved": "Saved their planned exercises as their new regular plan.",
  "plan_help": "User said something we couldn't parse during plan editing. Briefly remind them of the verbs they can use: add, remove, replace, save, show, start.",
  "plan_added": "User added one or more exercises to today's plan. Confirm and read the new full list naturally.",
  "plan_add_empty": "User said 'add' but didn't say what. Ask for exercise names with a quick example.",
  "plan_removed": "User removed one or more exercises. Confirm and read the new full list naturally.",
  "plan_remove_empty": "User said 'remove' without naming one. Ask which one with a quick example.",
  "plan_remove_not_found": "User tried to remove an exercise that wasn't in the list.",
  "plan_replaced": "User swapped one exercise for another. Confirm and read the updated list naturally.",
  "plan_replace_usage": "User said 'replace' but format wasn't clear. Show the right phrasing.",
  "plan_replace_not_found": "User tried to replace an exercise that's not in the list.",
  "plan_replace_already": "User tried to replace an exercise but the new one is already in the list. Suggest 'remove <old>' instead.",
  "delete_no_saved": "User tried to delete their last saved workout but they have none.",
  "deleted_last_saved": "Just deleted the most recent saved workout. Confirm briefly.",
  "summary_no_data": "User asked for a summary of a muscle they haven't trained yet.",
  "summary_last_workout": "Briefly summarize the user's most recent workout for that muscle. Use only the data given.",
  "improvement_need_more": "User asked about improvement but needs more sessions logged.",
  "improvement_summary": "Compare the user's latest session vs the previous one, encouragingly.",
  "compare_no_muscle": "User said 'compare' without naming a muscle. Ask which one with an example.",
  "compare_need_more": "User asked to compare workouts but only one (or none) is logged for that muscle.",
  "compare_result": "Speak the comparison data naturally — volume difference, set difference, and any heavier top sets. Be encouraging.",
  "bench_no_data": "Not enough bench data for week-over-week comparison.",
  "bench_progress": "Tell them how their latest bench compares — encouraging either way.",
  "unknown_help": "Couldn't understand the user's request. Suggest 1-2 example things they can say.",
  "backend_unreachable": "Backend service seems unreachable.",
  "voice_error": "Couldn't process the voice command this time.",
}


def _render_template(kind: str, payload: Dict[str, Any]) -> str:
  fn = SAY_TEMPLATES.get(kind)
  if fn is None:
    return "Got it."
  try:
    return str(fn(payload))
  except Exception:
    return "Got it."


async def call_gemini_say(kind: str, payload: Dict[str, Any], default_text: str) -> str:
  """One-shot Gemini call to phrase a UI event in coach voice. Falls back to default_text."""
  if not GEMINI_API_KEY:
    return default_text
  instruction = SAY_INSTRUCTIONS.get(kind, "Confirm the action briefly in coach voice.")
  facts = json.dumps(payload, ensure_ascii=False)
  prompt = (
    f"{COACH_VOICE_BRIEF}\n\n"
    f"EVENT: {instruction}\n"
    f"DATA: {facts}\n"
    "REPLY (spoken, 1-3 short sentences):"
  )
  url = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    f"?key={GEMINI_API_KEY}"
  )
  body = {
    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
    "generationConfig": {"temperature": 0.8, "maxOutputTokens": 120},
  }
  try:
    async with httpx.AsyncClient(timeout=8) as client:
      resp = await client.post(url, json=body)
  except Exception:
    return default_text
  if resp.status_code >= 400:
    return default_text
  try:
    data = resp.json()
    text = (
      data.get("candidates", [{}])[0]
      .get("content", {})
      .get("parts", [{}])[0]
      .get("text", "")
    )
    text = (text or "").strip()
    return text or default_text
  except Exception:
    return default_text


@app.get("/health")
def health() -> Dict[str, Any]:
  return {
    "status": "ok",
    "gemini_configured": bool(GEMINI_API_KEY),
  }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
  parsed = await call_gemini_parser(request.message)
  if is_jarvis_wake(request.message):
    parsed = {
      "intent": "jarvis_greeting",
      "reply": JARVIS_GREETING_REPLY,
    }
  return ChatResponse(
    intent=parsed.get("intent", "unknown"),
    exercise=parsed.get("exercise"),
    weight=parsed.get("weight"),
    reps=parsed.get("reps"),
    sets_count=parsed.get("sets_count"),
    muscle=parsed.get("muscle"),
    reply=parsed.get("reply", "Done."),
  )


@app.post("/api/coach", response_model=CoachResponse)
async def coach(request: CoachRequest) -> CoachResponse:
  reply = await generate_coach_reply(request.message)
  return CoachResponse(reply=reply)


@app.post("/api/say", response_model=SayResponse)
async def say(request: SayRequest) -> SayResponse:
  payload = request.payload or {}
  base = _render_template(request.kind, payload)
  if str(request.kind).startswith("set_edit_"):
    return SayResponse(reply=base)
  if request.enrich and GEMINI_API_KEY:
    text = await call_gemini_say(request.kind, payload, base)
    return SayResponse(reply=text)
  return SayResponse(reply=base)


@app.post("/api/tts")
async def tts(request: TtsRequest) -> Response:
  text = request.text.strip()
  if not text:
    raise HTTPException(status_code=400, detail="Text is required for TTS")
  if not ELEVENLABS_API_KEY or not ELEVENLABS_VOICE_ID:
    raise HTTPException(status_code=500, detail="Missing ElevenLabs API key or voice ID")

  url = (
    f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    "?output_format=mp3_44100_128"
  )
  payload = {
    "text": text,
    "model_id": ELEVENLABS_MODEL_ID,
  }
  headers = {
    "Content-Type": "application/json",
    "xi-api-key": ELEVENLABS_API_KEY,
  }

  async with httpx.AsyncClient(timeout=30) as client:
    response = await client.post(url, json=payload, headers=headers)

  if response.status_code >= 400:
    raise HTTPException(status_code=502, detail=f"ElevenLabs API error: {response.text}")

  return Response(content=response.content, media_type="audio/mpeg")


@app.post("/api/stt", response_model=SttResponse)
async def stt(audio: UploadFile = File(...)) -> SttResponse:
  if not DEEPGRAM_API_KEY:
    raise HTTPException(status_code=500, detail="Missing Deepgram API key")
  payload = await audio.read()
  if not payload:
    raise HTTPException(status_code=400, detail="Audio payload is empty")

  url = f"https://api.deepgram.com/v1/listen?{deepgram_query_string(streaming=False)}"
  headers = {
    "Authorization": f"Token {DEEPGRAM_API_KEY}",
    "Content-Type": audio.content_type or "application/octet-stream",
  }

  async with httpx.AsyncClient(timeout=30) as client:
    response = await client.post(url, content=payload, headers=headers)

  if response.status_code >= 400:
    raise HTTPException(status_code=502, detail=f"Deepgram API error: {response.text}")

  try:
    data = response.json()
    transcript = (
      data.get("results", {})
      .get("channels", [{}])[0]
      .get("alternatives", [{}])[0]
      .get("transcript", "")
      .strip()
    )
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f"Deepgram response parse error: {exc}") from exc

  return SttResponse(transcript=transcript)


@app.websocket("/api/stt/stream")
async def stt_stream(ws: WebSocket) -> None:
  await ws.accept()
  if not DEEPGRAM_API_KEY:
    await ws.send_json({"type": "error", "message": "Missing Deepgram API key"})
    await ws.close(code=1011)
    return

  dg_url = f"wss://api.deepgram.com/v1/listen?{deepgram_query_string(streaming=True)}"

  try:
    async with websockets.connect(
      dg_url,
      additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
      max_size=None,
    ) as dg:
      await ws.send_json({"type": "ready"})

      async def client_to_deepgram() -> None:
        while True:
          message = await ws.receive()
          if message["type"] == "websocket.disconnect":
            break
          data_bytes = message.get("bytes")
          if data_bytes:
            await dg.send(data_bytes)
            continue
          data_text = message.get("text")
          if not data_text:
            continue
          try:
            payload = json.loads(data_text)
          except json.JSONDecodeError:
            continue
          mtype = str(payload.get("type") or "").lower()
          if mtype == "finalize":
            await dg.send(json.dumps({"type": "Finalize"}))
          elif mtype == "close":
            await dg.send(json.dumps({"type": "CloseStream"}))
            break

      async def deepgram_to_client() -> None:
        async for raw in dg:
          if not raw:
            continue
          try:
            payload = json.loads(raw)
          except json.JSONDecodeError:
            continue
          if payload.get("type") != "Results":
            continue
          alt = (
            payload.get("channel", {})
            .get("alternatives", [{}])[0]
          )
          transcript = str(alt.get("transcript") or "").strip()
          if not transcript:
            continue
          await ws.send_json(
            {
              "type": "transcript",
              "transcript": transcript,
              "is_final": bool(payload.get("is_final")),
              "speech_final": bool(payload.get("speech_final")),
            }
          )

      t1 = asyncio.create_task(client_to_deepgram())
      t2 = asyncio.create_task(deepgram_to_client())
      done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
      for task in pending:
        task.cancel()
      for task in done:
        exc = task.exception()
        if exc:
          raise exc
  except WebSocketDisconnect:
    return
  except Exception as exc:
    try:
      await ws.send_json({"type": "error", "message": f"STT stream error: {exc}"})
      await ws.close(code=1011)
    except Exception:
      pass
