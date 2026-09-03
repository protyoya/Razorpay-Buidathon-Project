import { config } from "./config.js";

/**
 * Voice provider router.
 *
 * Two providers, chosen per direction so each runs on whatever is free:
 *
 *   Deepgram  STT  POST https://api.deepgram.com/v1/listen   (raw audio body)
 *             TTS  POST https://api.deepgram.com/v1/speak    ({text} JSON)
 *             auth: "Authorization: Token <key>"
 *
 *   Fish      STT  POST https://api.fish.audio/v1/asr        (multipart "audio")
 *             TTS  POST https://api.fish.audio/v1/tts        ({text} JSON, `model` header)
 *             auth: "Authorization: Bearer <key>"
 *
 * Defaults reflect what each free tier actually covers: Fish TTS is free on
 * s2.1-pro-free, while Fish ASR needs paid API credit — so speech-to-text
 * prefers Deepgram, whose free credits cover both.
 */
const FISH = "https://api.fish.audio/v1";
const DG = "https://api.deepgram.com/v1";

const has = { fish: () => !!config.voice.fishKey, deepgram: () => !!config.voice.deepgramKey };

/** Resolve "auto" against which keys actually exist. */
function pick(direction) {
  const want = direction === "stt" ? config.voice.sttProvider : config.voice.ttsProvider;
  if (want !== "auto") return has[want]?.() ? want : null;
  if (direction === "stt") return has.deepgram() ? "deepgram" : has.fish() ? "fish" : null;
  return has.fish() ? "fish" : has.deepgram() ? "deepgram" : null;   // Fish TTS is free
}

export const providers = () => ({ stt: pick("stt"), tts: pick("tts") });
export const voiceEnabled = () => !!(pick("stt") || pick("tts"));

export class VoiceError extends Error {
  constructor(status, body, provider) {
    super(body?.message || body?.err_msg || body?.reason || `${provider} HTTP ${status}`);
    this.name = "VoiceError"; this.status = status; this.provider = provider;
  }
}

const asJson = async (res) => { try { return await res.json(); } catch { return {}; } };

// ── speech to text ───────────────────────────────────────────────────────────

export async function transcribe(buffer, contentType = "audio/webm") {
  const p = pick("stt");
  if (!p) throw new VoiceError(503, { message: "No speech-to-text provider configured." }, "none");
  const out = p === "deepgram" ? await dgListen(buffer, contentType) : await fishAsr(buffer);
  return { ...out, provider: p };
}

async function dgListen(buffer, contentType) {
  const q = new URLSearchParams({ model: config.voice.dgSttModel, smart_format: "true" });
  if (config.voice.language) q.set("language", config.voice.language);
  const res = await fetch(`${DG}/listen?${q}`, {
    method: "POST",
    headers: { Authorization: `Token ${config.voice.deepgramKey}`, "Content-Type": contentType },
    body: buffer,
  });
  if (!res.ok) throw new VoiceError(res.status, await asJson(res), "deepgram");
  const j = await res.json();
  const alt = j.results?.channels?.[0]?.alternatives?.[0];
  return { text: (alt?.transcript ?? "").trim(), confidence: alt?.confidence, duration: j.metadata?.duration };
}

async function fishAsr(buffer) {
  const form = new FormData();
  form.append("audio", new Blob([buffer]), "clip.webm");
  if (config.voice.language) form.append("language", config.voice.language);
  const res = await fetch(`${FISH}/asr`, {
    method: "POST", headers: { Authorization: `Bearer ${config.voice.fishKey}` }, body: form,
  });
  if (!res.ok) throw new VoiceError(res.status, await asJson(res), "fish");
  const j = await res.json();
  return { text: (j.text ?? "").trim(), duration: j.duration };
}

// ── text to speech ───────────────────────────────────────────────────────────

/** Returns the upstream response so the caller can pipe chunks straight through. */
export async function synthesize(text) {
  const p = pick("tts");
  if (!p) throw new VoiceError(503, { message: "No text-to-speech provider configured." }, "none");
  const res = p === "deepgram" ? await dgSpeak(text) : await fishTts(text);
  return { res, provider: p };
}

async function dgSpeak(text) {
  const res = await fetch(`${DG}/speak?model=${encodeURIComponent(config.voice.dgTtsModel)}`, {
    method: "POST",
    headers: { Authorization: `Token ${config.voice.deepgramKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1900) }),   // Aura caps at 2000 chars
  });
  if (!res.ok) throw new VoiceError(res.status, await asJson(res), "deepgram");
  return res;
}

async function fishTts(text) {
  const res = await fetch(`${FISH}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.voice.fishKey}`,
      "Content-Type": "application/json",
      model: config.voice.fishModel,
    },
    body: JSON.stringify({
      text, format: "mp3",
      ...(config.voice.fishVoiceId ? { reference_id: config.voice.fishVoiceId } : {}),
      prosody: { speed: config.voice.speed },
    }),
  });
  if (!res.ok) throw new VoiceError(res.status, await asJson(res), "fish");
  return res;
}
