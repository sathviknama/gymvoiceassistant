# Backend Setup (Python + Gemini)

## 1) Create virtual environment

```powershell
cd "c:\Users\Sathvik\Downloads\gymvoiceassistant\backend"
python -m venv .venv
.\.venv\Scripts\activate
```

## 2) Install dependencies

```powershell
pip install -r requirements.txt
```

## 3) Configure environment

Create `backend/.env` from `backend/.env.example` and set:

- `GEMINI_API_KEY`
- optional `GEMINI_MODEL` (default `gemini-2.0-flash`)
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- optional `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`)

## 4) Run backend

```powershell
uvicorn chat:app --reload --host 0.0.0.0 --port 8000
```

## 5) Run web app in another terminal

```powershell
cd "c:\Users\Sathvik\Downloads\gymvoiceassistant"
npm run site:dev
```

The web app proxies `/api/*` to `http://127.0.0.1:8000`.

## Notes

- `POST /api/tts` returns `audio/mpeg` from ElevenLabs and is used by the web UI for natural voice output.
- If ElevenLabs keys are missing or fail, frontend falls back to browser speech synthesis.
