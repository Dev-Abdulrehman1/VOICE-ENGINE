# VOICE-ENGINE

Turn a script into natural-sounding speech from a browser. Type or paste text, press
**Generate**, and the audio plays right there — every generation is kept in a local
history you can replay or delete.

- **Backend:** Python + FastAPI, calling OpenRouter's text-to-speech endpoint
- **Speech model:** Fish Audio `s2.1-pro-free` (multilingual, expressive narration)
- **Frontend:** one dark page, plain HTML/CSS/JS, no build step
- **Storage:** SQLite file + mp3 files on disk (stdlib only, no ORM)
- **Access control:** every API route requires the access key set in `.env`

```
Browser ──POST /api/generate (X-Access-Key)──▶ FastAPI
                                                 │  POST /api/v1/audio/speech
                                                 ▼
                                     OpenRouter ──▶ Fish Audio S2.1 Pro
                                                 │  raw mp3 bytes
   ◀── mp3 (played as a blob) ───────────────────┤
                                                 └──▶ data/audio/<id>.mp3
                                                      data/history.db
```

## Features

| | |
| --- | --- |
| Script to speech | Paste a script, get audio back in a few seconds |
| Built-in player | Fixed player bar at the bottom plays what was just generated |
| History | Every attempt stored with timestamp, size and round-trip time; replay or delete any of it |
| Failure visibility | Failed generations are kept too, with the provider's error message |
| Access key | The app will not start without `ACCESS_KEY`, and no API route answers without it |
| No build step | The API and the UI are served by the same process, so there is no CORS setup |
| No DB dependency | History uses Python's standard-library `sqlite3` |

## Requirements

- Python 3.9 or newer
- An OpenRouter API key — <https://openrouter.ai/keys>
- Free models require opting in to prompt/data publication in your OpenRouter account
  privacy settings, otherwise requests fail with a routing error

## Quickstart

```bash
git clone https://github.com/Dev-Abdulrehman1/VOICE-ENGINE.git
cd VOICE-ENGINE

python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
```

Now edit `.env` and fill in two values: your `OPENROUTER_API_KEY`, and an `ACCESS_KEY`
you invent (this is the password you type in the UI):

```bash
python -c "import secrets; print('ACCESS_KEY=' + secrets.token_urlsafe(32))"
```

Start the server:

```bash
uvicorn backend.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000>, enter the access key on the lock screen, and start
generating. `⌘/Ctrl + Enter` in the script box also triggers Generate.

## Configuration

All settings live in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | Required. Your OpenRouter key |
| `ACCESS_KEY` | — | Required. The key you type in the UI; pick something long and random |
| `OPENROUTER_MODEL` | `fish-audio/s2.1-pro-free:free` | Any TTS model slug on OpenRouter |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for a proxy |
| `DATA_DIR` | `data` | Where the SQLite file and audio files are written |
| `MAX_CHARS` | `4000` | Maximum script length per request |
| `REQUEST_TIMEOUT` | `180` | Seconds to wait for the speech request |
| `AUDIO_FORMAT` | `mp3` | `mp3` (player friendly) or `pcm` (raw) |

`OPENROUTER_API_KEY` and `ACCESS_KEY` are mandatory: the app exits with a clear error
at startup rather than running unprotected.

## Usage

1. **Generate** tab — paste the script, press **Generate audio**. The request is
   synchronous, so the button stays disabled until the audio arrives.
2. The **player** at the bottom plays the result; the title shows the first words of the
   script, the subtitle shows model, timestamp and file size.
3. **History** tab — newest first, with timestamp, size and round-trip time.
   **Play** loads an item into the player, **Delete** removes both the row and the mp3.
   Items that failed are listed with the provider error instead of a Play button.

Fish Audio models accept inline delivery directions in square brackets, which you can
write straight into the script:

```
[whispering] Nobody answered the door that night.
[pause] Then the lights went out.
```

## API

Every route except `/api/health` requires the header `X-Access-Key: <ACCESS_KEY>`.
Anyone without a valid key gets `401`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ok, model}` |
| `GET` | `/api/config` | — | `{model, max_chars, format}` |
| `POST` | `/api/generate` | `{"text": "...", "voice"?, "instructions"?}` | Saved generation |
| `GET` | `/api/history` | `?limit=50&offset=0` | `{items, total, limit, offset}` |
| `DELETE` | `/api/history/{id}` | — | `{deleted}` |
| `GET` | `/api/audio/{id}` | — | `audio/mpeg` bytes |

Example:

```bash
curl -s http://127.0.0.1:8000/api/generate \
  -H "X-Access-Key: $ACCESS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from Voice Engine"}' | python -m json.tool
```

Audio is fetched with the access key as a header and turned into a blob URL in the
browser, so no audio endpoint is ever left open.

## Project structure

```
backend/
  main.py       FastAPI app: auth, generate, history, audio, static UI
  db.py         SQLite history store (stdlib sqlite3)
frontend/
  index.html    Navbar (Generate / History), script box, audio player, lock screen
  styles.css    Dark theme
  app.js        Access-key gate, generate, playback, history
requirements.txt
.env.example
```

## Data and storage

- `data/history.db` — one row per attempt: script, model, status, file name, byte size,
  round-trip time, provider generation id, timestamp, error
- `data/audio/<id>.mp3` — the generated audio (ids are random hex, so files are
  unguessable and cannot escape the directory)
- Both are gitignored. To start over, stop the server and delete `data/`

## Security notes

- The access key is compared in constant time and required on every API call
- The key is kept in `sessionStorage` in the browser, so it disappears when the tab closes
- Secrets live only in `.env`, which is gitignored; no key is ever sent to the browser
- Security headers (`nosniff`, `no-referrer`) are added, and API responses are `no-store`
- This is a single shared key, not a multi-user account system. If you expose it beyond
  localhost, put it behind TLS and consider real per-user authentication first

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Startup error about a missing key | `OPENROUTER_API_KEY` or `ACCESS_KEY` is empty in `.env` |
| Lock screen says the key was rejected | The key in the UI does not match `ACCESS_KEY`; it is case sensitive |
| `No endpoints found matching your data policy` | Free models need the data-publication opt-in in your OpenRouter account settings |
| Model-not-found error | The free slug may be unavailable for your account; set `OPENROUTER_MODEL=fish-audio/s2.1-pro-free` (paid) instead |
| Generation fails with a timeout | Raise `REQUEST_TIMEOUT`; long scripts take longer to synthesize |
| History row says the audio file is missing | The mp3 was deleted from `data/audio` while the row stayed; delete the row |
