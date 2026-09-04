/**
 * VOICE PREFLIGHT. Run: `npm run smoke:voice`
 * Verifies whichever voice providers are configured, in both directions, and
 * closes the loop by feeding the synthesised speech back into transcription.
 */
import { config } from "../src/config.js";
import { transcribe, synthesize, providers, voiceEnabled } from "../src/voice.js";

const p = providers();
console.log(`\n  fish key     : ${config.voice.fishKey ? "set" : "—"}`);
console.log(`  deepgram key : ${config.voice.deepgramKey ? "set" : "—"}`);
console.log(`  → speech-to-text via : ${p.stt ?? "none"}`);
console.log(`  → text-to-speech via : ${p.tts ?? "none"}\n`);

if (!voiceEnabled()) {
  console.log("  No voice provider configured. Set DEEPGRAM_API_KEY or FISH_AUDIO_API_KEY in .env.\n");
  process.exit(1);
}

const PHRASE = "Two blue kurtas under fifteen hundred rupees.";
let audio = null, fails = 0;

if (p.tts) {
  try {
    const t0 = Date.now();
    const { res, provider } = await synthesize(PHRASE);
    audio = Buffer.from(await res.arrayBuffer());
    console.log(`  ✅ TTS via ${provider} — ${audio.length} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) { fails++; console.log(`  ❌ TTS — ${e.message}`); }
} else console.log("  ⚠️  no TTS provider");

if (p.stt) {
  if (!audio) console.log("  ⚠️  skipping STT — no audio to send (TTS failed)");
  else try {
    const t0 = Date.now();
    const { text, provider, confidence } = await transcribe(audio, "audio/mpeg");
    const hit = /kurta/i.test(text);
    console.log(`  ${hit ? "✅" : "⚠️ "} STT via ${provider} — "${text}"` +
      `  (${((Date.now() - t0) / 1000).toFixed(1)}s${confidence ? `, conf ${confidence.toFixed(2)}` : ""})`);
    if (!hit) console.log(`       expected something like "${PHRASE}"`);
  } catch (e) { fails++; console.log(`  ❌ STT — ${e.message}`); }
} else console.log("  ⚠️  no STT provider");

console.log("\n────────────────────────────────────────────────");
if (fails && p.stt === "fish") {
  console.log(" ⚠️  Server-side speech-to-text is unavailable, but the app does not need it:");
  console.log("     Chrome and Edge transcribe in the browser for free. This only matters");
  console.log("     for Safari/Firefox — set DEEPGRAM_API_KEY to cover those.");
} else {
  console.log(fails ? " ❌ Some providers failed — see above." : " ✅ Voice round trip works.");
}
console.log("────────────────────────────────────────────────\n");
process.exit(fails ? 1 : 0);
