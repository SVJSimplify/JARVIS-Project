# JINI — setup

JINI is two apps that work together:

- **JINI Desktop** (Electron, this repo root): the brain and the hands. Chat, memory, agents, tasks, browser and computer control.
- **JINI Mobile** (`mobile/`, Capacitor + React): your phone companion. Chat, send tasks to the desktop, follow progress, approve actions, browse and correct memory.

They talk directly over your own Wi‑Fi, end‑to‑end encrypted. No cloud service is needed.

---

## 1. Desktop

**Install:** run `JINI-Desktop-Setup.exe` (Windows x64). It is not code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

**From source** (Node.js 22+): `npm install`, then `npm run dev` (development) or `npm run build` (installer in `release/`).

### Connect an AI provider

Open **Settings → Provider & Voice** and fill in:

| Field | Example |
| --- | --- |
| API base URL | `https://api.openai.com/v1` · `https://openrouter.ai/api/v1` · `http://localhost:11434/v1` (Ollama) · `https://generativelanguage.googleapis.com/v1beta/openai` (Gemini) |
| API key | your key (not needed for local Ollama) |
| Model | e.g. `gpt-4o-mini`, `anthropic/claude-sonnet-4`, `llama3.1` |

Any **OpenAI‑compatible** endpoint works. The key is encrypted with your OS keychain. Alternatively set `JINI_BASE_URL` in the environment (see `.env.example`).

Your existing JARVIS data (memories, settings, tasks) is reused automatically: the app keeps the same data folder.

---

## 2. Phone

### Install the APK (Android)

Requires **Android 8.0 or newer**.

1. Copy `JINI-mobile-debug.apk` to the phone (or download it from the `builds-latest` branch of the repo).
2. Open it and allow "Install unknown apps" for your file manager or browser when asked.

It is a debug-signed build for your own testing, not for the Play Store. Every push to `jini-mvp` rebuilds the APK and the Windows installer (GitHub Actions → "JINI build") and publishes both to the `builds-latest` branch. The installer is stored in 90 MB parts there; join them in order (`copy /b part00+part01+part02 JINI-Desktop-Setup.exe` on Windows) and check the `.sha256`.

### Pair it with the desktop

1. Phone and computer on the **same Wi‑Fi**.
2. Desktop: **Settings → Devices → Allow phone connections**, then **Pair a phone**. A QR code appears (valid 2 minutes, one use).
3. Phone: **Pair with desktop JINI → Scan QR code**. If scanning is awkward, copy the code shown under the QR and paste it on the phone.
4. The first time, your OS firewall may ask to allow JINI on private networks — **allow it** (port `47621`).

Done. The status at the top of the phone says **Desktop connected**.

### Use the phone without the desktop

Phone: **Settings → AI provider** — same base URL / key / model fields. When the desktop is offline the phone answers chats itself (labelled *Answered on phone*), and desktop tasks are queued and sent automatically when the desktop is back.

---

## 3. Build the APK yourself (optional)

GitHub Actions builds it on every push (`.github/workflows/jini-build.yml`). Locally you need **Java 21** and the **Android SDK** (Android Studio installs both):

```bash
cd mobile
npm install
npm run android:apk
# → mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

iOS: on a Mac with Xcode, `cd mobile && npm run sync && npx cap open ios`, then run on your iPhone.

---

## What you need to set up — checklist

- [ ] Desktop: run `JINI-Desktop-Setup.exe`, then set base URL + API key + model in Settings → Provider & Voice.
- [ ] Desktop: Settings → Devices → turn on **Allow phone connections**; allow it through the firewall on private networks.
- [ ] Phone: install the APK, pair by QR.
- [ ] Optional: phone Settings → AI provider, for chat while the desktop is off.
- [ ] Optional (iPhone): build from a Mac with Xcode.

---

## Security model (short)

- Pairing uses a short‑lived, single‑use QR offer. No permanent secret is ever in the QR.
- Each phone gets its own key (ECDH P‑256 → HKDF → AES‑256‑GCM). Every request is encrypted, authenticated, timestamped and replay‑checked, including across restarts.
- Devices can be revoked on the desktop instantly. A phone unused for 30 days expires. Keys can be rotated from the phone.
- Approvals answered on the phone are written to the desktop's audit log with the phone's name, and they are never queued offline.
- The phone link is **off** until you turn it on, and it only accepts connections from devices you paired.

## Known limits of this MVP

- **No push notifications yet.** The phone updates live while JINI is open and syncs when you open it. Push needs a Firebase / APNs project, which isn't set up.
- **Same network only.** Reaching the desktop from outside your Wi‑Fi needs a relay or VPN (e.g. Tailscale works today: use the desktop's Tailscale IP).
- On Android, the phone's link key is stored in app-private storage, not the hardware keystore yet.
- iOS is generated and builds in Xcode, but it has not been tested on a device.
