# Mate30 Pro 离线翻译 PWA MVP

这是一个面向 HUAWEI Mate30 Pro 的纯 PWA MVP。它不依赖构建工具，核心文件都是静态资源，可以直接部署到 HTTPS 静态站点。

## 当前能力

- 离线优先 PWA shell：Service Worker 缓存 UI 文件。
- 设备能力检测：安全上下文、麦克风、AudioWorklet、MediaRecorder、WASM、WebGPU、浏览器 ASR。
- 麦克风采集：优先使用 `AudioWorklet` 输出 PCM 分段和实时音量，不支持时降级到 `AnalyserNode`。
- 浏览器 ASR：如果当前浏览器支持 `SpeechRecognition`，会自动接入；如果支持 `processLocally`，优先请求端侧识别。
- 离线翻译适配层：点击“下载翻译模型”后，会下载 `Xenova/opus-mt-zh-en` 和 `Xenova/opus-mt-en-zh` 并在浏览器里用 Transformers.js/ONNX Runtime Web 推理。
- ASR 模型：点击“下载 ASR 模型”后，会下载 `Xenova/whisper-tiny`，点击开始后尝试用最近几秒音频生成字幕。
- 高级模型包导入：文件选择框目前只把模型文件保存到 IndexedDB，供后续自定义推理适配器读取。
- “未手动导入文件”不代表按钮下载的模型不可用。按钮下载的模型由 Transformers.js 和浏览器缓存管理，高级导入区只是预留入口。

## 本地运行

在这个目录启动静态服务器：

```powershell
python -m http.server 4173
```

然后访问：

```text
http://localhost:4173/pwa-translator-mvp/
```

## Mate30 Pro 真机测试

Huawei Browser 真机测试建议部署到 HTTPS 静态站点，例如 Cloudflare Pages、GitHub Pages、Netlify 或你自己的 HTTPS 站点。

普通 `http://电脑IP:端口` 在手机上通常不是安全上下文，麦克风、PWA 安装和持久缓存可能被浏览器限制。`localhost` 只对当前设备生效，所以电脑上的 `localhost` 也不能直接代表手机本地。

真机第一次打开时，先看页面里的“设备检测”：

- WebGPU：可用就后续尝试 GPU 加速；不可用就保持 WASM。
- 浏览器 ASR：可用可作为快速字幕通道；不可用就走自带 ASR 模型。
- 端侧 ASR：如果 Huawei Browser 暴露本地语音包能力，可作为额外优化。
- 存储配额：若低于 500 MB，需要缩小模型包或分语言包下载。

## Mate30 Pro 侧重点

目标设备已定为 HUAWEI Mate30 Pro，HarmonyOS 4.2.0.136，Huawei Browser。Mate30 Pro 的 Kirin 990 / Mali-G76 MP16 / 8GB RAM 可以尝试轻量端侧模型，但 Huawei Browser 上不能默认假设 WebGPU 一定可用。因此 MVP 默认按 WASM/SIMD 路线设计，WebGPU 只作为检测到时的加速路径。

## 推荐模型预算

性能优先，推荐总模型包控制在 300-350 MB：

- ASR：`Xenova/whisper-tiny`。
- 翻译：`Xenova/opus-mt-zh-en` 和 `Xenova/opus-mt-en-zh`。
- 音频输入：AudioWorklet 重采样到 16 kHz mono PCM，每 0.5 秒输出一段。
- 实时字幕策略：前端聚合 2-4 秒滑窗，0.5 秒步进刷新字幕。

不建议第一版使用 1B+ 通用大语言模型做翻译。它会明显增加首包、内存、发热和延迟，不适合 Mate30 Pro 上的实时字幕 MVP。

## 需要确认

- 真机 Huawei Browser 是否暴露 WebGPU。
- 真机 Huawei Browser 是否支持 `SpeechRecognition` 或端侧语音包。
- 最终 ASR/翻译模型文件格式：ONNX Runtime Web、Transformers.js，或自定义 WASM。
