const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 7;
const MIN_SECONDS = 2.5;
const INFER_INTERVAL_MS = 3500;
const RMS_THRESHOLD = 0.012;

let pipelineFactory = null;
let transcriber = null;
let loadingPromise = null;
let chunks = [];
let sampleCount = 0;
let busy = false;
let lastInferAt = 0;
let lastText = "";
let sourceLang = "zh-CN";

self.onmessage = async (event) => {
  const message = event.data ?? {};
  try {
    if (message.type === "load") {
      sourceLang = message.sourceLang || sourceLang;
      await loadModel(message.model);
      return;
    }
    if (message.type === "config") {
      sourceLang = message.sourceLang || sourceLang;
      resetAudio();
      return;
    }
    if (message.type === "reset") {
      resetAudio();
      return;
    }
    if (message.type === "audio") {
      sourceLang = message.sourceLang || sourceLang;
      handleAudio(message.samples);
    }
  } catch (error) {
    postMessage({ type: "error", message: error?.message || String(error) });
  }
};

async function loadModel(model) {
  if (transcriber) {
    postMessage({ type: "ready" });
    return;
  }
  if (!loadingPromise) {
    loadingPromise = (async () => {
      postMessage({ type: "status", text: "ASR Worker 正在加载模型..." });
      if (!pipelineFactory) {
        const transformers = await import(TRANSFORMERS_CDN);
        transformers.env.allowRemoteModels = true;
        transformers.env.allowLocalModels = false;
        pipelineFactory = transformers.pipeline;
      }
      transcriber = await pipelineFactory("automatic-speech-recognition", model, {
        dtype: "q8",
        progress_callback: (progressEvent) => {
          postMessage({ type: "progress", event: progressEvent });
        },
      });
      postMessage({ type: "ready" });
    })();
  }
  await loadingPromise;
}

function handleAudio(samples) {
  if (!transcriber || busy || !samples?.length) return;
  const level = rms(samples);
  if (level < RMS_THRESHOLD && sampleCount < SAMPLE_RATE * MIN_SECONDS) return;

  chunks.push(samples);
  sampleCount += samples.length;
  const maxSamples = SAMPLE_RATE * MAX_SECONDS;
  while (sampleCount > maxSamples && chunks.length > 1) {
    const removed = chunks.shift();
    sampleCount -= removed.length;
  }

  const now = Date.now();
  if (sampleCount >= SAMPLE_RATE * MIN_SECONDS && now - lastInferAt >= INFER_INTERVAL_MS) {
    lastInferAt = now;
    transcribeRecentAudio();
  }
}

async function transcribeRecentAudio() {
  if (busy || !transcriber) return;
  busy = true;
  try {
    const audio = concatAudio();
    const result = await transcriber(audio, {
      language: sourceLang === "zh-CN" ? "chinese" : "english",
      task: "transcribe",
      chunk_length_s: 6,
      stride_length_s: 1,
    });
    const text = normalizeTranscript(result?.text || result);
    if (text && text !== lastText && !looksLikeHallucination(text)) {
      lastText = text;
      postMessage({ type: "transcript", text });
    }
  } catch (error) {
    postMessage({ type: "error", message: error?.message || String(error) });
  } finally {
    busy = false;
  }
}

function concatAudio() {
  const audio = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  return audio;
}

function resetAudio() {
  chunks = [];
  sampleCount = 0;
  busy = false;
  lastInferAt = 0;
  lastText = "";
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

function normalizeTranscript(value) {
  return String(value ?? "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHallucination(text) {
  const normalized = text.toLowerCase();
  return (
    normalized === "you" ||
    normalized === "thank you" ||
    normalized === "thanks for watching" ||
    normalized.includes("subtitle") ||
    normalized.includes("watching")
  );
}
