<div align="center">

# subvid.app

**Generate, edit, translate, and export subtitles for any video or audio — entirely in your browser.**

No uploads. No backend. No API keys.

<a href="https://subvid.app">🌐 Live site</a> ·
<a href="https://github.com/midudev/subvid.app">📦 Repository</a> ·
<a href="#getting-started">🚀 Getting started</a>

<br />

<img width="900" alt="subvid.app — subtitle editor with timeline and live preview" src="https://github.com/user-attachments/assets/6a4463ce-9cf7-4053-a193-97104080b6a7" />

<br />
<br />

[![Astro](https://img.shields.io/badge/Astro-6-FF5D01?logo=astro&logoColor=white)](https://astro.build)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Whisper](https://img.shields.io/badge/AI-Whisper-412991?logo=openai&logoColor=white)](https://huggingface.co/Xenova/whisper-base)
[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

</div>

## What it does

1. **Upload a video or audio** — drag & drop or browse. Supports MP4, MOV, WebM, MKV, MP3, WAV, and OGG.
2. **Configure languages** — pick the audio language (or auto-detect) and the subtitle language.
3. **Generate subtitles** — Whisper transcribes the audio; NLLB translates when needed.
4. **Edit in the timeline** — fix text, timing, and styling with undo/redo.
5. **Export** — download an `.srt` file or a new video with burned-in captions (video files only).

Everything runs client-side. Your files never leave your device.

## Features

- **AI transcription** — [Whisper](https://huggingface.co/Xenova/whisper-base) via [transformers.js](https://huggingface.co/docs/transformers.js), with optional WebGPU acceleration.
- **AI translation** — [NLLB-200](https://huggingface.co/Xenova/nllb-200-distilled-600M) for multilingual subtitle tracks.
- **Subtitle editor** — segment list, timeline scrubbing, multi-language tracks, caption presets (font, color, background, outline, position).
- **Export options**
  - `.srt` subtitle file
  - MP4 with hard-coded subtitles (WebCodecs + [mediabunny](https://github.com/Vanilagy/mediabunny) when available; canvas + MediaRecorder as fallback)
- **Internationalization** — English (default) and Spanish, with static pages per locale.
- **Offline-friendly models** — AI weights are downloaded once and cached in the browser (IndexedDB).
- **Audio-only mode** — upload MP3, WAV, or OGG files to generate subtitle files without needing video.

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | [Astro 6](https://astro.build) (static site) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| Speech recognition | [@xenova/transformers](https://www.npmjs.com/package/@xenova/transformers) (Whisper) |
| Translation | transformers.js (NLLB-200) |
| Audio extraction | [@ffmpeg/ffmpeg](https://ffmpegwasm.netlify.app) (WASM) |
| Video export | [mediabunny](https://www.npmjs.com/package/mediabunny) + WebCodecs |
| Deployment | [Cloudflare Workers](https://workers.cloudflare.com) (static assets) |

## Requirements

- **Node.js** ≥ 22.12.0
- **pnpm** (recommended package manager for this repo)

For end users, a modern Chromium-based browser (Chrome, Edge, Brave) or Firefox is recommended. Safari works but WebCodecs export may fall back to the slower MediaRecorder path.

## Getting started

```sh
# Clone the repository
git clone https://github.com/midudev/subvid.app.git
cd subvid.app

# Install dependencies
pnpm install

# Start the dev server (http://localhost:4321)
pnpm dev
```

No environment variables or external services are required for local development.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Astro dev server at `localhost:4321` |
| `pnpm build` | Build the production site to `./dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm preview:cf` | Build and preview with Wrangler (Cloudflare Workers runtime) |
| `pnpm deploy` | Build and deploy to Cloudflare Workers |

## Project structure

```text
src/
├── components/       # Astro UI (upload, config, editor, export modal, …)
├── i18n/ui.ts        # Translations (en, es) — server + client strings
├── layouts/          # HTML shell, hreflang, meta tags
├── pages/            # Routes: / (en), /es/ (es)
├── scripts/
│   ├── app.ts        # Main client logic (state, transcription, export)
│   ├── transcriber.worker.ts  # Web Worker for AI models
│   └── dom.ts        # DOM helpers
└── styles/           # Global and app-specific CSS
```

The app is a multi-stage SPA embedded in static Astro pages. Server-rendered copy lives in `src/i18n/ui.ts`; runtime strings for the active locale are injected into `window.__I18N__` so only one language ships per page.

## Architecture notes

- **Main thread** — UI, video playback, timeline, FFmpeg orchestration, export rendering.
- **Transcriber worker** — loads Whisper/NLLB and runs inference off the main thread so the UI stays responsive.
- **FFmpeg worker** — extracts audio from the uploaded video before transcription.
- **Model downloads** — fetched from Hugging Face on first use (~150 MB for Whisper base + translation model). Progress is shown in the status dock; models can be cleared from the downloads panel.

### Browser capabilities

| Capability | Used for |
| --- | --- |
| WebGPU | Faster Whisper inference (when supported) |
| WebCodecs | Fast MP4 export with burned-in subtitles |
| SharedArrayBuffer / cross-origin isolation | Required by FFmpeg WASM in some environments |

## Deployment

The site is deployed as static assets on Cloudflare Workers. Configuration lives in `wrangler.jsonc`:

```sh
pnpm deploy
```

You need a [Cloudflare account](https://dash.cloudflare.com) and Wrangler authenticated (`wrangler login`).

## Adding a language

1. Add the locale code to `i18n.locales` in `astro.config.mjs`.
2. Create `src/pages/<code>/index.astro` (copy `src/pages/es/index.astro`).
3. Add a translation block in `src/i18n/ui.ts` mirroring the English keys.
4. Register the display name in `languages` inside `src/i18n/ui.ts`.

## Privacy

subvid.app is designed around local-first processing:

- Videos are read from disk via the File API — never uploaded.
- AI models run in Web Workers with WASM/WebGPU.
- No analytics backend or user accounts in this codebase.

## License

See the repository for license details.

## Author

Built by [midudev](https://midu.dev).
