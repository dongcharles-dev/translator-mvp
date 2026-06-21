const APP_VERSION = "0.1.0";
const STORE_NAME = "mate30-translator-store";
const MODEL_DB_NAME = "mate30-translator-models";
const MODEL_STORE = "modelFiles";
const DEVICE_PROFILE = {
  device: "HUAWEI Mate30 Pro",
  os: "HarmonyOS 4.2.0.136",
  browser: "Huawei Browser",
  scenario: "实时字幕",
  runtime: "WASM/SIMD 优先，WebGPU 检测到再启用",
  audio: "16 kHz mono PCM, 0.5s chunk",
  modelBudget: "首次联网下载，后续尽量缓存",
  asrModel: "Xenova/whisper-tiny",
  translateModel: "Xenova/opus-mt-zh-en + Xenova/opus-mt-en-zh",
};
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const TRANSLATOR_MODELS = {
  "zh-CN->en-US": "Xenova/opus-mt-zh-en",
  "en-US->zh-CN": "Xenova/opus-mt-en-zh",
};
const ASR_MODEL = "Xenova/whisper-tiny";

const $ = (selector) => document.querySelector(selector);

const els = {
  offlineStatus: $("#offlineStatus"),
  installButton: $("#installButton"),
  sourceLang: $("#sourceLang"),
  targetLang: $("#targetLang"),
  swapLangs: $("#swapLangs"),
  speechMode: $("#speechMode"),
  asrBadge: $("#asrBadge"),
  translatorBadge: $("#translatorBadge"),
  startButton: $("#startButton"),
  stopButton: $("#stopButton"),
  translateButton: $("#translateButton"),
  sourceOutput: $("#sourceOutput"),
  translationOutput: $("#translationOutput"),
  manualInput: $("#manualInput"),
  meterFill: $("#meterFill"),
  capabilityList: $("#capabilityList"),
  refreshCapabilities: $("#refreshCapabilities"),
  storageText: $("#storageText"),
  persistStorage: $("#persistStorage"),
  asrModelInput: $("#asrModelInput"),
  translatorModelInput: $("#translatorModelInput"),
  loadTranslatorModels: $("#loadTranslatorModels"),
  loadAsrModel: $("#loadAsrModel"),
  modelProgress: $("#modelProgress"),
  modelPlan: $("#modelPlan"),
  modelState: $("#modelState"),
  historyList: $("#historyList"),
};

const state = {
  deferredInstallPrompt: null,
  recognition: null,
  mediaStream: null,
  audioContext: null,
  audioWorkletNode: null,
  silenceGain: null,
  analyser: null,
  meterFrame: 0,
  pcmChunks: 0,
  finalTranscript: "",
  interimTranscript: "",
  history: loadJson("history", []),
  transformers: null,
  translatorPipelines: {},
  translatorLoading: null,
  asrPipeline: null,
  asrLoading: null,
  audioChunks: [],
  audioSampleCount: 0,
  asrBusy: false,
  lastAsrAt: 0,
  settings: loadJson("settings", {
    sourceLang: "zh-CN",
    targetLang: "en-US",
    speechMode: "auto",
  }),
};

const phraseBook = {
  "zh-CN->en-US": [
    [/你好/g, "hello"],
    [/谢谢/g, "thank you"],
    [/早上好/g, "good morning"],
    [/晚上好/g, "good evening"],
    [/请稍等/g, "please wait"],
    [/我需要帮助/g, "I need help"],
    [/这个多少钱/g, "how much is this"],
    [/请说慢一点/g, "please speak more slowly"],
    [/我听不懂/g, "I do not understand"],
    [/请问洗手间在哪里/g, "where is the restroom"],
  ],
  "en-US->zh-CN": [
    [/\bhello\b/gi, "你好"],
    [/\bthank you\b/gi, "谢谢"],
    [/\bgood morning\b/gi, "早上好"],
    [/\bgood evening\b/gi, "晚上好"],
    [/\bplease wait\b/gi, "请稍等"],
    [/\bi need help\b/gi, "我需要帮助"],
    [/\bhow much is this\b/gi, "这个多少钱"],
    [/\bplease speak more slowly\b/gi, "请说慢一点"],
    [/\bi do not understand\b/gi, "我听不懂"],
    [/\bwhere is the restroom\b/gi, "请问洗手间在哪里"],
  ],
};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`${STORE_NAME}:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(`${STORE_NAME}:${key}`, JSON.stringify(value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setBadge(el, text, tone = "neutral") {
  el.textContent = text;
  el.className = `badge ${tone}`;
}

function renderText() {
  const combined = [state.finalTranscript, state.interimTranscript].filter(Boolean).join("\n");
  els.sourceOutput.textContent = combined;
}

function translateLocally(text) {
  const source = els.sourceLang.value;
  const target = els.targetLang.value;
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (source === target) return trimmed;

  const key = `${source}->${target}`;
  const rules = phraseBook[key] ?? [];
  let translated = trimmed;
  for (const [pattern, replacement] of rules) {
    translated = translated.replace(pattern, replacement);
  }

  if (translated === trimmed) {
    const label = target === "zh-CN" ? "本地模型待接入" : "local model pending";
    return `[${label}] ${trimmed}`;
  }
  return translated;
}

async function runTranslation(text = getActiveInput()) {
  const source = text.trim();
  const translated = await translateText(source);
  els.translationOutput.textContent = translated;
  if (source && translated) {
    state.history = [
      {
        source,
        translated,
        pair: `${els.sourceLang.value} -> ${els.targetLang.value}`,
        time: new Date().toLocaleTimeString(),
      },
      ...state.history,
    ].slice(0, 5);
    saveJson("history", state.history);
    renderHistory();
  }
}

async function translateText(source) {
  if (!source) return "";
  const sourceLang = els.sourceLang.value;
  const targetLang = els.targetLang.value;
  if (sourceLang === targetLang) return source;

  const pair = `${sourceLang}->${targetLang}`;
  const pipe = state.translatorPipelines[pair];
  if (!pipe) {
    return translateLocally(source);
  }

  try {
    setBadge(els.translatorBadge, "翻译中", "good");
    const output = await pipe(source, { max_new_tokens: 96 });
    const first = Array.isArray(output) ? output[0] : output;
    const translated = first?.translation_text ?? first?.generated_text ?? String(output);
    setBadge(els.translatorBadge, "本地模型", "good");
    return translated;
  } catch (error) {
    console.warn("Model translation failed", error);
    setBadge(els.translatorBadge, "模型失败", "bad");
    return translateLocally(source);
  }
}

async function loadTransformers() {
  if (!state.transformers) {
    setModelProgress("加载 Transformers.js...");
    state.transformers = await import(TRANSFORMERS_CDN);
    state.transformers.env.allowRemoteModels = true;
    state.transformers.env.allowLocalModels = false;
  }
  return state.transformers;
}

function setModelProgress(text) {
  els.modelProgress.textContent = text;
}

function progressText(kind, event) {
  if (!event) return `${kind}: 下载中`;
  if (event.status === "progress") {
    const loaded = formatBytes(event.loaded ?? 0);
    const total = formatBytes(event.total ?? 0);
    const file = event.file ? ` · ${event.file}` : "";
    return `${kind}: ${loaded} / ${total}${file}`;
  }
  if (event.status) return `${kind}: ${event.status}${event.file ? ` · ${event.file}` : ""}`;
  return `${kind}: 下载中`;
}

async function loadTranslatorModels() {
  if (state.translatorLoading) return state.translatorLoading;
  state.translatorLoading = (async () => {
    els.loadTranslatorModels.disabled = true;
    setBadge(els.translatorBadge, "下载中", "warn");
    const { pipeline } = await loadTransformers();
    const options = {
      dtype: "q8",
      progress_callback: (event) => setModelProgress(progressText("翻译模型", event)),
    };
    state.translatorPipelines["zh-CN->en-US"] = await pipeline(
      "translation",
      TRANSLATOR_MODELS["zh-CN->en-US"],
      options,
    );
    state.translatorPipelines["en-US->zh-CN"] = await pipeline(
      "translation",
      TRANSLATOR_MODELS["en-US->zh-CN"],
      options,
    );
    setBadge(els.translatorBadge, "本地模型", "good");
    setModelProgress("翻译模型已就绪。之后断网时能否直接使用，取决于 Huawei Browser 是否保留模型缓存。");
    els.loadTranslatorModels.textContent = "翻译模型已就绪";
    if (getActiveInput()) await runTranslation();
  })().catch((error) => {
    console.error("Translator model load failed", error);
    setBadge(els.translatorBadge, "下载失败", "bad");
    setModelProgress(`翻译模型下载失败：${error.message ?? error}`);
    els.loadTranslatorModels.disabled = false;
    state.translatorLoading = null;
  });
  return state.translatorLoading;
}

async function loadAsrModel() {
  if (state.asrLoading) return state.asrLoading;
  state.asrLoading = (async () => {
    els.loadAsrModel.disabled = true;
    setBadge(els.asrBadge, "ASR 下载中", "warn");
    const { pipeline } = await loadTransformers();
    state.asrPipeline = await pipeline("automatic-speech-recognition", ASR_MODEL, {
      dtype: "q8",
      progress_callback: (event) => setModelProgress(progressText("ASR 模型", event)),
    });
    setBadge(els.asrBadge, "ASR 模型", "good");
    els.loadAsrModel.textContent = "ASR 模型已就绪";
    setModelProgress("ASR 模型已就绪。点击开始后，会用最近几秒音频生成字幕。");
  })().catch((error) => {
    console.error("ASR model load failed", error);
    setBadge(els.asrBadge, "ASR 下载失败", "bad");
    setModelProgress(`ASR 模型下载失败：${error.message ?? error}`);
    els.loadAsrModel.disabled = false;
    state.asrLoading = null;
  });
  return state.asrLoading;
}

function getActiveInput() {
  return state.finalTranscript || els.manualInput.value || state.interimTranscript;
}

function renderHistory() {
  els.historyList.innerHTML = "";
  for (const item of state.history) {
    const row = document.createElement("div");
    row.className = "history-item";
    row.textContent = `${item.time} · ${item.pair}\n${item.source}\n${item.translated}`;
    els.historyList.append(row);
  }
}

function renderModelPlan() {
  const rows = [
    ["设备", `${DEVICE_PROFILE.device} · ${DEVICE_PROFILE.os} · ${DEVICE_PROFILE.browser}`],
    ["场景", DEVICE_PROFILE.scenario],
    ["运行", DEVICE_PROFILE.runtime],
    ["音频", DEVICE_PROFILE.audio],
    ["预算", DEVICE_PROFILE.modelBudget],
    ["ASR", DEVICE_PROFILE.asrModel],
    ["翻译", DEVICE_PROFILE.translateModel],
  ];
  els.modelPlan.innerHTML = "";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "plan-row";
    const title = document.createElement("strong");
    title.textContent = label;
    const text = document.createElement("span");
    text.textContent = value;
    row.append(title, text);
    els.modelPlan.append(row);
  }
}

function updateOnlineStatus() {
  els.offlineStatus.textContent = navigator.onLine ? "在线可缓存" : "离线可用";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;
    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installButton.hidden = false;
  });

  els.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });
}

async function detectCapabilities() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const capabilities = [
    ["安全上下文", window.isSecureContext, window.isSecureContext ? "HTTPS / localhost / file" : "需要 HTTPS 或 localhost"],
    ["PWA 缓存", "serviceWorker" in navigator, "serviceWorker" in navigator ? "可注册离线缓存" : "浏览器不支持"],
    ["麦克风", !!navigator.mediaDevices?.getUserMedia, navigator.mediaDevices?.getUserMedia ? "可请求录音权限" : "不可用"],
    ["AudioWorklet", !!window.AudioWorkletNode, window.AudioWorkletNode ? "低延迟音频线程可用" : "降级到 Analyser"],
    ["MediaRecorder", !!window.MediaRecorder, window.MediaRecorder ? "可分段采集音频" : "不可用"],
    ["WebAssembly", typeof WebAssembly === "object", typeof WebAssembly === "object" ? "WASM 推理基础可用" : "不可用"],
    ["WebGPU", !!navigator.gpu, navigator.gpu ? "可尝试 GPU 推理" : "按 WASM 路线运行"],
    ["浏览器 ASR", !!SpeechRecognition, SpeechRecognition ? "SpeechRecognition 可用" : "不可用"],
    ["端侧 ASR", !!SpeechRecognition?.available, SpeechRecognition?.available ? "可检测本地语音包" : "不可检测"],
  ];

  renderCapabilities(capabilities);
  await renderStorageEstimate();
  await probeLocalSpeech(SpeechRecognition);
}

function renderCapabilities(capabilities) {
  els.capabilityList.innerHTML = "";
  for (const [name, ok, detail] of capabilities) {
    const row = document.createElement("div");
    row.className = "capability";

    const title = document.createElement("strong");
    title.textContent = name;

    const description = document.createElement("span");
    description.textContent = detail;

    const dot = document.createElement("i");
    dot.className = `dot ${ok ? "good" : name === "WebGPU" ? "warn" : "bad"}`;

    row.append(title, description, dot);
    els.capabilityList.append(row);
  }
}

async function renderStorageEstimate() {
  if (!navigator.storage?.estimate) {
    els.storageText.textContent = "存储容量不可检测";
    return;
  }
  const estimate = await navigator.storage.estimate();
  const used = formatBytes(estimate.usage);
  const quota = formatBytes(estimate.quota);
  let persisted = false;
  if (navigator.storage.persisted) {
    persisted = await navigator.storage.persisted();
  }
  els.storageText.textContent = `已用 ${used} / 配额 ${quota}${persisted ? " · 已持久化" : ""}`;
}

async function probeLocalSpeech(SpeechRecognition) {
  if (!SpeechRecognition?.available) return;
  try {
    const result = await SpeechRecognition.available({
      langs: [els.sourceLang.value],
      processLocally: true,
      quality: "dictation",
    });
    if (result === "available") {
      setBadge(els.asrBadge, "本地 ASR 可用", "good");
    } else if (result === "downloadable" || result === "downloading") {
      setBadge(els.asrBadge, "语音包可下载", "warn");
    }
  } catch (error) {
    console.info("Local speech probe failed", error);
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  const granted = await navigator.storage.persist();
  await renderStorageEstimate();
  els.storageText.textContent += granted ? " · 授权成功" : " · 浏览器未授权";
}

async function startCapture() {
  els.startButton.disabled = true;
  els.stopButton.disabled = false;
  state.finalTranscript = "";
  state.interimTranscript = "";
  renderText();
  setBadge(els.asrBadge, "监听中", "good");

  await startMicrophoneMeter();
  startBrowserSpeechIfAvailable();
}

async function startMicrophoneMeter() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setBadge(els.asrBadge, "无麦克风", "bad");
    return;
  }
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextCtor({ latencyHint: "interactive" });
    const source = state.audioContext.createMediaStreamSource(state.mediaStream);

    if (state.audioContext.audioWorklet && window.AudioWorkletNode) {
      try {
        await state.audioContext.audioWorklet.addModule("./audio-worklet.js");
        state.audioWorkletNode = new AudioWorkletNode(state.audioContext, "pcm-meter-processor");
        state.silenceGain = state.audioContext.createGain();
        state.silenceGain.gain.value = 0;
        state.audioWorkletNode.port.onmessage = (event) => {
          const { rms, sampleRate, samples } = event.data ?? {};
          if (Number.isFinite(rms)) {
            const level = Math.min(100, Math.round(rms * 260));
            els.meterFill.style.width = `${level}%`;
          }
          if (samples) {
            state.pcmChunks += 1;
            handlePcmChunk(samples);
            if (state.pcmChunks === 1 && sampleRate === 16000) {
              setBadge(els.asrBadge, "16k PCM", "good");
            }
          }
        };
        source.connect(state.audioWorkletNode);
        state.audioWorkletNode.connect(state.silenceGain).connect(state.audioContext.destination);
        return;
      } catch (error) {
        console.info("AudioWorklet unavailable, falling back to analyser", error);
      }
    }

    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 1024;
    source.connect(state.analyser);
    tickMeter();
  } catch (error) {
    console.warn("Microphone failed", error);
    setBadge(els.asrBadge, "麦克风被拒绝", "bad");
    els.startButton.disabled = false;
    els.stopButton.disabled = true;
  }
}

function handlePcmChunk(samples) {
  if (!state.asrPipeline) return;
  state.audioChunks.push(samples);
  state.audioSampleCount += samples.length;
  const maxSamples = 16000 * 6;
  while (state.audioSampleCount > maxSamples && state.audioChunks.length > 1) {
    const removed = state.audioChunks.shift();
    state.audioSampleCount -= removed.length;
  }

  const now = Date.now();
  if (state.audioSampleCount >= 16000 * 2 && now - state.lastAsrAt > 1800 && !state.asrBusy) {
    state.lastAsrAt = now;
    runAsrOnRecentAudio();
  }
}

function concatRecentAudio() {
  const audio = new Float32Array(state.audioSampleCount);
  let offset = 0;
  for (const chunk of state.audioChunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  return audio;
}

async function runAsrOnRecentAudio() {
  if (!state.asrPipeline || state.asrBusy) return;
  state.asrBusy = true;
  try {
    setBadge(els.asrBadge, "识别中", "good");
    const audio = concatRecentAudio();
    const language = els.sourceLang.value === "zh-CN" ? "chinese" : "english";
    const result = await state.asrPipeline(audio, {
      language,
      task: "transcribe",
      chunk_length_s: 4,
      stride_length_s: 1,
    });
    const text = (typeof result === "string" ? result : result?.text ?? "").trim();
    if (text) {
      state.finalTranscript = text;
      state.interimTranscript = "";
      renderText();
      await runTranslation(text);
    }
    setBadge(els.asrBadge, "ASR 模型", "good");
  } catch (error) {
    console.warn("ASR failed", error);
    setBadge(els.asrBadge, "ASR 失败", "bad");
  } finally {
    state.asrBusy = false;
  }
}

function tickMeter() {
  if (!state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / data.length);
  const level = Math.min(100, Math.round(rms * 260));
  els.meterFill.style.width = `${level}%`;
  state.meterFrame = requestAnimationFrame(tickMeter);
}

function startBrowserSpeechIfAvailable() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mode = els.speechMode.value;
  if (!SpeechRecognition || mode === "manual") {
    if (!SpeechRecognition && mode !== "manual") {
      setBadge(els.asrBadge, "仅文本输入", "warn");
    }
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = els.sourceLang.value;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  if ("processLocally" in recognition) {
    recognition.processLocally = true;
  }

  recognition.onresult = (event) => {
    let interim = "";
    let finalText = state.finalTranscript;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0]?.transcript ?? "";
      if (event.results[i].isFinal) {
        finalText = `${finalText} ${chunk}`.trim();
      } else {
        interim = `${interim} ${chunk}`.trim();
      }
    }
    state.finalTranscript = finalText;
    state.interimTranscript = interim;
    renderText();
    runTranslation(state.finalTranscript || state.interimTranscript);
  };

  recognition.onerror = (event) => {
    const detail = event.error === "language-not-supported" ? "语言包不可用" : "ASR 错误";
    setBadge(els.asrBadge, detail, "bad");
  };

  recognition.onend = () => {
    if (!els.stopButton.disabled && els.speechMode.value !== "manual") {
      try {
        recognition.start();
      } catch {
        setBadge(els.asrBadge, "ASR 已暂停", "warn");
      }
    }
  };

  try {
    recognition.start();
    state.recognition = recognition;
    setBadge(els.asrBadge, "浏览器 ASR", "good");
  } catch (error) {
    console.warn("Speech recognition start failed", error);
    setBadge(els.asrBadge, "ASR 不可启动", "bad");
  }
}

function stopCapture() {
  els.startButton.disabled = false;
  els.stopButton.disabled = true;
  setBadge(els.asrBadge, "待机", "neutral");
  els.meterFill.style.width = "0%";

  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.stop();
    state.recognition = null;
  }
  if (state.meterFrame) {
    cancelAnimationFrame(state.meterFrame);
    state.meterFrame = 0;
  }
  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) track.stop();
    state.mediaStream = null;
  }
  if (state.audioWorkletNode) {
    state.audioWorkletNode.disconnect();
    state.audioWorkletNode = null;
  }
  if (state.silenceGain) {
    state.silenceGain.disconnect();
    state.silenceGain = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  state.analyser = null;
  state.audioChunks = [];
  state.audioSampleCount = 0;
}

function syncSettings() {
  els.sourceLang.value = state.settings.sourceLang;
  els.targetLang.value = state.settings.targetLang;
  els.speechMode.value = state.settings.speechMode;
}

function persistSettings() {
  state.settings = {
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    speechMode: els.speechMode.value,
  };
  saveJson("settings", state.settings);
}

function openModelDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODEL_STORE)) {
        db.createObjectStore(MODEL_STORE, { keyPath: "slot" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveModelFiles(slot, fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const db = await openModelDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MODEL_STORE, "readwrite");
    tx.objectStore(MODEL_STORE).put({
      slot,
      files: files.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        blob: file,
      })),
      savedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await renderModelState();
}

async function renderModelState() {
  if (!window.indexedDB) {
    els.modelState.innerHTML = '<div class="model-item">IndexedDB 不可用</div>';
    return;
  }
  const db = await openModelDb();
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(MODEL_STORE, "readonly");
    const request = tx.objectStore(MODEL_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();

  els.modelState.innerHTML = "";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "model-item";
    empty.textContent = "尚未导入模型文件";
    els.modelState.append(empty);
    return;
  }
  for (const record of records) {
    const item = document.createElement("div");
    item.className = "model-item";
    const size = record.files.reduce((total, file) => total + file.size, 0);
    item.textContent = `${record.slot}: ${record.files.length} 个文件 · ${formatBytes(size)}`;
    els.modelState.append(item);
  }
}

function bindEvents() {
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);

  els.refreshCapabilities.addEventListener("click", detectCapabilities);
  els.persistStorage.addEventListener("click", requestPersistentStorage);
  els.startButton.addEventListener("click", startCapture);
  els.stopButton.addEventListener("click", stopCapture);
  els.translateButton.addEventListener("click", () => runTranslation());
  els.loadTranslatorModels.addEventListener("click", loadTranslatorModels);
  els.loadAsrModel.addEventListener("click", loadAsrModel);

  els.manualInput.addEventListener("input", () => {
    if (els.speechMode.value === "manual") runTranslation(els.manualInput.value);
  });

  for (const el of [els.sourceLang, els.targetLang, els.speechMode]) {
    el.addEventListener("change", () => {
      persistSettings();
      detectCapabilities();
      if (getActiveInput()) runTranslation();
    });
  }

  els.swapLangs.addEventListener("click", () => {
    const source = els.sourceLang.value;
    els.sourceLang.value = els.targetLang.value;
    els.targetLang.value = source;
    persistSettings();
    if (getActiveInput()) runTranslation();
  });

  els.asrModelInput.addEventListener("change", (event) => {
    saveModelFiles("ASR", event.target.files);
  });
  els.translatorModelInput.addEventListener("change", (event) => {
    saveModelFiles("Translator", event.target.files);
  });
}

async function boot() {
  syncSettings();
  bindEvents();
  setupInstallPrompt();
  updateOnlineStatus();
  renderModelPlan();
  renderHistory();
  await registerServiceWorker();
  await detectCapabilities();
  await renderModelState();
  setBadge(els.translatorBadge, "待下载", "warn");
}

boot();
