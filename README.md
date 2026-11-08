# gemini-gemma-evolutionary-webbook-engine

AI-powered search & evolutionary computing engine compiling structured, topic-specific Web-books from internet data. Features Google Gemini with automatic failover to offline Google Gemma (Ollama/local), multi-tier search fallback, and high-res vector PDF/DOCX/HTML/JPG export.

---

## Purpose

Searching a topic returns many pages that repeat each other, and asking an LLM for a "complete guide" in one shot produces thin, unverifiable text. This project exists to turn a single query into one deduplicated, source-linked, multi-chapter reference: candidate evidence is gathered (Gemini with Google Search grounding, or Google / DuckDuckGo as fallbacks), an evolutionary algorithm keeps the most informative, authoritative and non-redundant material, and Gemini writes the book from that evidence. When evidence or a chapter cannot be produced, the engine says so rather than padding the book with filler. It is also a reference implementation of a server-side Gemini app in the Google AI Studio style (see `GOOGLE_AI_STUDIO_UPLOAD.md`).

---

## Key Features

- **Two-Stage Evolutionary Content Synthesis**:
  - **Stage 1 (Architectural Roadmap)**: Synthesizes a structured 10-chapter outline flowing logically from historical foundations to core architecture, deep technical mechanics, and future horizons.
  - **Stage 2 (Parallel Chapter Expansion)**: Writes each chapter (700-900 words, 5-7 paragraphs) from the evolved evidence, with up to 3 chapters in flight at once, plus technical definitions, sub-topic deep dives, and visual seeds. A chapter Gemini cannot write is omitted and named in the notice; it is never replaced by filler text.
- **Configurable AI Models**:
  - Dynamic model selection from the list in `GEMINI_MODELS` (`src/types.ts`): `gemini-3.6-flash` (default), `gemini-3.5-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-flash-lite`.
  - Runtime model discovery (`GET /api/gemini/models` lists the models your key can really use). The selected model is tried first; if it cannot serve a request for a model-specific reason (quota, overload, timeout, no longer offered) up to two sibling Flash models are tried, fastest first (3.6, 3.5, 3.5-flash-lite, 3.1-flash-lite, then 3.7 and 3.8), and the book's notice names every model that actually answered. Errors that fail identically on every model (bad key, HTTP 403, HTTP 400) are never retried on siblings.
- **Multi-Tier Search Fallback Resilience**:
  - Graceful degradation when Gemini API quotas or rate limits are reached.
  - Configurable fallback routing: `Google + DuckDuckGo`, `Google only`, `DuckDuckGo only`, or `Off (Gemini only)`.
  - Offline evolutionary synthesis fallback ensuring books are generated even during upstream API outages. Without a Gemini key the search server also reads the result pages themselves (public pages only, `server/searchStrategies/pageExcerpt.ts`: body paragraphs, no menus/cookie/share/catalogue chrome, one page per host, hard time budget) so chapters are written from page text rather than 1–3-sentence snippets; set `WEBBOOK_READ_PAGES=off` to use snippets only. Offline chapters hold at least four real sentences and 80 words, so thin evidence yields fewer, fuller chapters instead of one-line ones. Offline chapter titles come from the sources (the page that supplies most of a chapter, minus the site name; never repeated, never just the topic), not from a fixed outline.
- **Content Sanitization & Anti-Poisoning Heuristics**:
  - Heuristic screening for machine-code artifacts, hex bytes, and digit noise.
  - Automatic filtering of copyright disclaimers, scraper warnings, and promotional boilerplate.
- **Intelligent Title Summarization & Word-Boundary Clipping**:
  - Deterministically shortens overly lengthy user query titles on cover pages (on-screen viewer, Print Friendly PDF, and Print Friendly JPGs) to a 90-unit display budget (double-weighted for CJK characters).
  - Cuts cleanly at natural clause or word boundaries, strips trailing dangling connectors (e.g., `and`, `or`, `of`), and appends a single ellipsis (`…`), preventing mid-word truncations.
  - Heading labels use word-boundary clipping (`clipLabelAtWordBoundary`) to ensure content headers never leave partial words behind.
- **Comprehensive Multi-Format Export**:
  - **Localised Fixed Labels**: Fixed document furniture (chapter headers, Table of Contents, visual concept badges, key domain concepts, deeper exploration angles, verified sources, and running footers) automatically adapts to the language of the generated book (covering Simplified & Traditional Chinese, Japanese, Korean, Malay, Spanish, French, German, and falling back cleanly to English). Model-generated content (such as visual-concept prompts), the initial generation notice, and export filenames remain as generated.
  - **PDF Document (High Res)**: Vector-grade document featuring a museum-grade cover, an interactive Table of Contents with clickable hyperlinks that jump directly to each chapter, and an editorial chapter layout (lead paragraph accent bars, key concept callout cards, deeper angle cards, and verified clickable source citations).
  - **Print / Save as PDF**: Responsive print-to-PDF formatting utilizing clean `@media print` rules, dedicated page breaks, and iframe + window print resilience.
  - **CJK books in the High-Res PDF**: CJK Web-books keep the full High-Res layout using the embedded font `src/assets/fonts/NotoSansSC-Subset.ttf` (tracked in git and bundled by Vite; do not move it into the git-ignored `public/`). If the font cannot be loaded the export reports an error instead of switching to the reader layout. Rebuild the font with `scripts/make-cjk-font-subset.sh`.
  - **Print Friendly PDF**: Reader-mode layout in the spirit of Edge Immersive Reader / LinkedIn reader view: one centred column, 12pt left-aligned sans-serif text with generous line spacing, clear headings, plain-list concepts/dimensions and clickable sources. The report opens in the browser print dialog (choose **Save as PDF**), so the PDF contains real vector text that is sharp at any zoom or printer resolution, selectable, searchable and screen-reader friendly. If printing is blocked, a 3x-resolution raster PDF is downloaded instead.
  - **Print Friendly Image (JPG)**: The same reader-mode layout rendered as one A4 JPG per page at 3x (about 288 dpi), packed from measured block heights so headings are never stranded at the bottom of a page. Multi-page reports download as `..._page_01_of_06.jpg` style files.
  - **Word (.docx)**: Fully editable OpenXML document with preserved tables, glossaries, and embedded images.
  - **HTML Webpage**: Standalone responsive document with self-contained styling and navigational anchors.
  - **Plain Text (.txt)**: Clean, unformatted hierarchical text.
- **Dual-Layer Persistence & History**:
  - Cloud persistence via Firebase Firestore with anonymous authentication (configured through the `VITE_FIREBASE_*` variables, see Environment Setup).
  - Local browser storage caching for offline review and instant retrieval.

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend Framework** | React 19, TypeScript, Vite 6 |
| **Styling & UI** | Tailwind CSS v4, Motion (`motion/react`), Lucide React |
| **AI Integration** | Google Gemini API via `@google/genai` (online); a local model with no Google key: Gemma through the built-in llama.cpp runtime (`node-llama-cpp`, set up by `npm install`) or through Ollama / LM Studio |
| **Document Export** | `jspdf` (installed through `html2pdf.js`), `html2pdf.js`, `html2canvas`, `fflate` (DOCX OpenXML packaging; also used by the packaging script) |
| **Persistence** | Firebase Firestore, Firebase Auth, Web LocalStorage |
| **Server & Middleware** | Node.js, Express, `tsx`, Vite plugin middleware, `ws` (Gemini Live WebSocket relay), `dotenv` |
| **Testing** | Cypress 16 with `@badeball/cypress-cucumber-preprocessor` (BDD Gherkin, esbuild bundling) and reporters (mochawesome, JUnit, multiple-cucumber-html-reporter); `tsx` + `node:assert` server-side unit tests |
| **Package management** | npm (`.npmrc` sets `legacy-peer-deps=true`) |

---

## System Architecture & API

The same route handlers run in two hosts: Vite plugins during `npm run dev` / `npm run test`, and the Express server in `server/server.ts` for `npm start`.

| Route | Method | Host | Purpose |
| :--- | :--- | :--- | :--- |
| `/api/gemini/generate` | POST | `server/geminiService.ts` | Proxies `generateContent` with error classification, retries, a concurrency gate and a per-request timeout; answers with a local model when `LLM_PROVIDER` / the key state calls for it (see 6b) |
| `/api/gemini/stream` | POST | `server/geminiService.ts` | Streaming variant of the above |
| `/api/gemini/health` | GET | `server/geminiService.ts` | Per-model connectivity check (never returns the key) |
| `/api/gemini/models` | GET | `server/geminiService.ts` | Models the key can use (live list cached for 10 minutes, built-in list as fallback) |
| `/api/local-llm/health` | GET | `server/geminiService.ts` | Whether a local model server is running, which models it has, and whether the configured one will answer (never calls Google) |
| `/api/gemini/live` | WebSocket | `server/server.ts` only | Gemini Live relay |
| `/api/search-fallback` | GET | `server/googleSearchFallback.ts` | Google / DuckDuckGo evidence collection used when Gemini search is unavailable |
| `/api/search`, `/api/evolve` | GET, POST | `server/googleSearchFallback.ts` | Legacy-compatible search and population-evolution endpoints |
| `/__pdf` | POST | `server/server.ts` only | Server PDF hook. `server/pdfBridge.ts` is a stub that always fails, so the client falls back to the vector jsPDF export (Cypress stubs this route) |

**Gemini request pipeline** (`server/geminiService.ts`, `server/geminiErrors.ts`): the client is created lazily and re-created when `GEMINI_API_KEY` changes; every Google error is classified into a reason (`invalid_api_key`, `permission_denied`, `model_not_found`, `bad_request`, `quota_daily`, `no_free_tier`, `quota_unspecified`, `rate_limited`, `overloaded`, `internal`, `timeout`, `network`) from Google's structured details rather than message wording; only transient reasons are retried, honouring Google's retry delay; a timeout is never retried on the same model.

**Client engine** (`src/hooks/useWebBookEngine.ts` -> `src/services/evolutionService.ts`): search and extraction, evolution, assembly and history are orchestrated in the hook; model failover and the notice shown with each book live in the service.

---

## Repository Structure

```text
├── .cypress-cucumber-preprocessorrc.json # Cucumber preprocessor config (repo-root copy)
├── .env.example                         # Environment variable template
├── .gitignore / .npmrc                  # Git ignores; npm config (legacy-peer-deps=true)
├── DIAGNOSIS.md                         # Findings on thin books and Gemini connectivity/latency failures
├── GOOGLE_AI_STUDIO_UPLOAD.md           # Notes on the Google AI Studio upload archive
├── LICENSE.txt                          # MIT License
├── README.md                            # This document
├── index.html                           # Application entry HTML
├── metadata.json                        # AI Studio applet capabilities and metadata
├── package.json                         # Project dependencies and npm scripts
├── tsconfig.json                        # TypeScript configuration
├── vite.config.ts                       # Vite configuration with Tailwind, Gemini and search middleware plugins
│
├── exports/                             # Sample generated Web-book export artifacts (PDF, DOCX, HTML, TXT, Print-Friendly)
│
├── scripts/
│   ├── diagnose-gemini.ts               # `npm run diagnose`: asks Google directly, per model (plain + Search grounding)
│   ├── make-cjk-font-subset.sh          # Rebuilds the embedded Noto Sans SC subset font
│   ├── make-tiny-gguf.py                # Rebuilds tests/fixtures/tiny-random.gguf (160 KB random-weight model for the real-runtime tests; needs `pip install gguf numpy`)
│   ├── package-google-ai-studio.mjs     # `npm run package:aistudio`: builds the lean source ZIP
│   ├── setup-local-llm.mjs              # `npm install` (postinstall) / `npm run setup:local-llm` / `npm run local-llm:check`: checks the built-in runtime, downloads the model once, proves it works
│   ├── start-preview.mjs                # Builds, then runs `vite preview` (not wired to an npm script)
│   └── update_options.cjs               # Legacy one-off codemod that threaded `geminiModel` through services (not used by any script)
│
├── server/
│   ├── geminiErrors.ts                  # Classifies Google/Gemini errors into reasons, retry hints and user messages
│   ├── geminiService.ts                 # /api/gemini/* routes, retry, concurrency gate, timeout, Live WebSocket relay
│   ├── googleSearchFallback.ts          # Search fallback routes and query handling (Express & Vite middleware)
│   ├── embeddedLlm.ts                   # Built-in local model engine: llama.cpp in this process via node-llama-cpp (model lookup, JSON-schema grammar, limits, abort)
│   ├── localModelDefaults.mjs           # Default model URI / size / context shared by the server and the setup script
│   ├── localLlm.ts                      # Local model provider: Gemini request/response translation, provider routing, readiness probe (Ollama, LM Studio, llama-server)
│   ├── pdfBridge.ts                     # Server PDF stub (Puppeteer disabled; client vector export is used)
│   ├── server.ts                        # Standalone full-stack server entry (`npm start`)
│   └── searchStrategies/
│       ├── duckDuckGoStrategy.ts        # DuckDuckGo fallback scraper strategy
│       ├── pageExcerpt.ts               # Reads result pages for body text (offline book depth)
│       ├── googleStrategy.ts            # Google Search fallback strategy
│       ├── shared.ts                    # Search deduplication & ranking utilities
│       └── types.ts                     # Strategy typing definitions
│
├── src/
│   ├── App.tsx                          # Root application component
│   ├── WebBookViewer.tsx                # Interactive multi-page WebBook reader
│   ├── WebBookErrorBoundary.tsx         # Component-level error boundary
│   ├── index.css                        # Global Tailwind styles and print media rules
│   ├── main.tsx                         # Client application bootstrap
│   ├── types.ts                         # Core domain types, `GEMINI_MODELS`, fallback mode/reason guards
│   ├── vite-env.d.ts                    # Vite client typings
│   │
│   ├── assets/fonts/
│   │   └── NotoSansSC-Subset.ttf        # Embedded CJK font for High-Res PDF export
│   │
│   ├── components/
│   │   ├── AppHeader.tsx                # Header with navigation, model status, and export dropdown
│   │   ├── ControlSidebar.tsx           # Ingestion controls, model selector, and metrics panel
│   │   └── HistoryDrawer.tsx            # Slide-out archived Web-book drawer
│   │
│   ├── hooks/
│   │   └── useWebBookEngine.ts          # Core engine hook orchestrating search, evolution, and history
│   │
│   ├── services/
│   │   ├── documentTitle.ts             # Dynamic document title formatter
│   │   ├── docxExport.ts                # Word OpenXML (.docx) document builder
│   │   ├── evolutionService.ts          # Genetic algorithm, fitness evaluation, model failover and Gemini assembly
│   │   ├── exportDocument.ts            # Document prep, inlining, and HTML print shells
│   │   ├── exportLabels.ts              # Locale-aware fixed labels & script/stop-word language detection
│   │   ├── exportService.ts             # Multi-format export coordinator (PDF, Print, Word, HTML, TXT)
│   │   ├── fallbackPayloadHeuristics.ts # Heuristic quality scorers for search results
│   │   ├── geminiUserFacingErrors.ts    # Friendly error translation for API responses
│   │   ├── googleSearchFallbackClient.ts# Client interface to fallback search middleware
│   │   ├── historyService.ts            # Firestore and LocalStorage persistence layer
│   │   ├── pdfCjkFont.ts                # Loads and registers the embedded CJK font for jsPDF
│   │   ├── printFriendlyReportExport.ts # Reader-mode print-friendly report generator (vector PDF via print, per-page JPG)
│   │   ├── safeResponse.ts              # Defensive JSON parsing; detects HTML or proxy pages returned instead of JSON
│   │   ├── searchFallbackShared.ts      # Shared scoring and URL builders
│   │   └── searchIntakeParser.ts        # Robust JSON and text stream parser
│   │
│   └── utils/
│       └── webBookRender.ts             # Pagination planner and source link sanitizers
│
└── tests/
    ├── .cypress-cucumber-preprocessorrc.json # Cucumber BDD preprocessor configuration (report paths, step definitions)
    ├── cypress.config.cjs               # Cypress test configuration
    ├── cypress.env.config.cjs           # Environment/base-URL resolution for Cypress
    ├── cypress/
    │   ├── fixtures/                    # Deterministic search fallback mock data and a 1x1 image
    │   ├── support/                     # Cypress commands (network and export stubs) and e2e setup
    │   └── e2e/
    │       ├── features/
    │       │   └── webbook-generation.feature # BDD feature specifications (26 scenarios)
    │       ├── common/                  # Cucumber step definitions (given, when, then)
    │       └── pageObjects/             # Page object locators
    ├── scripts/
    │   ├── generate-cucumber-report.cjs # Compiles the HTML report from Cucumber JSON
    │   ├── run-cypress-with-reports.cjs # Runs Cypress, then the report generator
    │   ├── run-local-cypress.cjs        # Starts the dev server if needed, runs Cypress, stops the server
    │   └── smoke/                       # Manual scripts (import, PDF bridge, Google fetch); not run by npm scripts
    └── server/                          # 25 `tsx` unit/regression tests, run by `npm run test:server`
```

---

## Setup & Running

### 1. Prerequisites

- **Node.js**: v20 or higher
- **npm**: v10 or higher

### 2. Installation

```bash
npm install
```

`.npmrc` already sets `legacy-peer-deps=true`, so peer-dependency conflicts need no extra flag.

**What `npm install` also does for local models** (so books can be written with no Gemini key and no Ollama):

1. installs `node-llama-cpp`, the llama.cpp runtime for Node (an *optional* dependency with prebuilt binaries for Windows, macOS incl. Apple Silicon, and Linux; the GPU variants make this a few hundred MB on disk);
2. runs `scripts/setup-local-llm.mjs`, which checks that the runtime loads, **downloads the Gemma model once (about 2.8 GB; resumable)** into `./models/`, and proves it works by loading it and writing a few tokens;
3. reports honestly what it verified. It never edits `.env`, never starts a compiler or a background process, and never fails the install: if something is missing it prints the one command that fixes it.

It is skipped automatically in CI, production (`NODE_ENV=production`) and global installs. To control it, set these in your shell (`SKIP_LOCAL_LLM_SETUP=1 npm install`): `SKIP_LOCAL_LLM_SETUP=1` skips everything, `LOCAL_LLM_DOWNLOAD=off` checks the runtime but downloads nothing, `LOCAL_LLM_VERIFY=off` skips the load test, and `LOCAL_LLM_ENGINE=http` (you use Ollama / LM Studio) skips it too. Run it later with `npm run setup:local-llm`, and re-check any time with `npm run local-llm:check`. For a hosted deployment or a build server, install with `SKIP_LOCAL_LLM_SETUP=1`.

To inspect and resolve package security vulnerabilities:
```bash
# Check vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix --force
```

### 3. Environment Setup

Copy `.env.example` to `.env` in the project root and set at least:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

| Variable | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Yes (not needed for `npm test`) | none | Server-side Gemini access (the key is never sent to the browser) |
| `VITE_FIREBASE_*` (`API_KEY`, `APP_ID`, `AUTH_DOMAIN`, `MEASUREMENT_ID`, `MESSAGING_SENDER_ID`, `PROJECT_ID`, `STORAGE_BUCKET`) | No | none | Firebase cloud history (see Dual-Layer Persistence) |
| `GEMINI_MAX_CONCURRENCY` | No | 3 | Simultaneous requests to Google from this server |
| `GEMINI_MAX_ATTEMPTS` | No | 4 | Tries per request for rate-limit, overload and transient errors |
| `GEMINI_MAX_RETRY_WAIT_MS` | No | 45000 | Longest single retry wait before giving up |
| `GEMINI_REQUEST_TIMEOUT_MS` | No | 50000 | Longest wait for one Google answer (0 = off); a timeout triggers failover to a sibling model |
| `LLM_PROVIDER` | No | `auto` | `auto`: Gemini when its key works, otherwise a ready local model; `gemini`: never use a local model; `local`: never call Google |
| `LOCAL_LLM_ENGINE` | No | `auto` | `auto`: an external server (Ollama, LM Studio, ...) when one is ready, otherwise the built-in runtime when its model is downloaded; `http`: external server only; `embedded`: built-in only |
| `LOCAL_LLM_BASE_URL` | No | `http://localhost:11434` | External server: any OpenAI-compatible one: Ollama, LM Studio, llama.cpp `llama-server`, vLLM (a trailing `/v1` is accepted) |
| `LOCAL_LLM_MODEL` | No | `gemma4:e4b` | Model the local server should use (a single-model server answers with whatever it has loaded) |
| `LOCAL_LLM_MODEL_URI` | No | `hf:ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf` | Built-in runtime: the model to download (about 2.8 GB). A bigger one: `hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M` (about 5.3 GB, 8 GB+ RAM, better quality) |
| `LOCAL_LLM_MODEL_PATH` | No | none | Built-in runtime: use this `.gguf` file you already have (wins over the URI; nothing is downloaded) |
| `LOCAL_LLM_MODELS_DIR` | No | `./models` | Built-in runtime: where the downloaded model is kept |
| `LOCAL_LLM_CONTEXT_SIZE` | No | 16384 | Built-in runtime: largest context window (prompt + answer, in tokens); more needs more memory. A prompt that does not fit is refused, never cut |
| `LOCAL_LLM_THREADS` | No | CPU cores | Built-in runtime: CPU threads. The default is the number of cores that exist (llama.cpp's own default can make a 1-2 core VM hundreds of times slower) |
| `LOCAL_LLM_TIMEOUT_MS` | No | 300000 | Longest wait for one local answer (0 = off) |
| `LOCAL_LLM_MAX_CONCURRENCY` | No | 1 | Simultaneous requests to the local server |
| `LOCAL_LLM_TEMPERATURE` | No | 0.4 | Sampling temperature when the engine does not set one |
| `SKIP_LOCAL_LLM_SETUP`, `LOCAL_LLM_DOWNLOAD`, `LOCAL_LLM_VERIFY` | No | unset | Read by `npm install` only (see Installation): `SKIP_LOCAL_LLM_SETUP=1` skips the local-model setup, `LOCAL_LLM_DOWNLOAD=off` skips the download, `LOCAL_LLM_VERIFY=off` skips the load test |
| `PORT` | No | 3000 | Port for `npm start` |

### 4. Development Server

Start the local development server:

```bash
npm run dev
```

The application will be accessible at `http://localhost:3000`. Vite serves the `/api/gemini/*` and search fallback routes through plugins; the Live WebSocket and `/__pdf` routes exist only in the standalone server below.

### 5. Production Build & Deployment

```bash
# Type check and build production assets
npm run build

# Start full-stack production server (serves frontend & API fallback routes)
npm start

# (Optional) Preview production client build locally (serves frontend, /api/gemini/*, and search fallback routes)
npm run preview
```

### 6. Automated Testing

The project includes an end-to-end Cypress BDD test suite with automated server lifecycle handling and visual HTML reporting.

#### Seamless Execution for Non-Technical Users (No Manual Server Setup)

You do **not** need to manually launch the local application server, configure ports, or provide a Gemini API key. Simply run:

```bash
npm test
# (or: npm run test)
```

**How the automated flow works:**
1. **Local Server Detection & Auto-Launch**: The runner checks whether `http://localhost:3000` is active. If not running, it automatically boots the Vite dev server (`npm run dev:test`) in the background and waits until it is ready.
2. **Deterministic & Safe Execution**: All 26 BDD test scenarios execute headlessly against mocked fixtures. **No Gemini API key or paid quota is required**, ensuring fast, reliable execution with zero risk to content integrity.
3. **Automated Server Teardown**: Automatically terminates the background server process once testing completes.
4. **HTML Report Generation**: Automatically compiles the visual, interactive HTML test report.

#### Viewing the Visual Test Report

After the test run completes, open the interactive HTML report in any web browser to view pass/fail metrics, step durations, and feature details:

- **Report Path**: `test-results/chromeReport/multiple-cucumber-html-report/index.html`

Convenient one-line commands to open the report directly:
- **macOS**: `open test-results/chromeReport/multiple-cucumber-html-report/index.html`
- **Windows**: `start test-results/chromeReport/multiple-cucumber-html-report/index.html`
- **Linux**: `xdg-open test-results/chromeReport/multiple-cucumber-html-report/index.html`

Cypress also writes mochawesome JSON/HTML, JUnit XML, Cucumber JSON/HTML/messages and screenshots under `test-results/chromeReport/`. The base URL can be overridden with `CYPRESS_BASE_URL`. `tests/scripts/smoke/` holds manual diagnostic scripts that are not part of any npm script.

#### Test CLI Commands & Server Launch Matrix

The table below clarifies whether each `npm` / `npm run` command manages the local App server automatically or expects a pre-running server:

| Command | Local Server Launch | Purpose / Description |
| :--- | :--- | :--- |
| `npm test`<br>*(or `npm run test`)* | **Automatic** *(Self-managed; no manual start required)* | **Recommended primary command**. Automatically boots local server if not active, runs all 26 BDD scenarios headlessly, stops server, and compiles HTML report. |
| `npm run test:e2e`<br>*(or `npm run cy:run:local`)* | **Requires Running Server**<br>*(Run `npm run dev` first)* | Runs the full BDD test suite headlessly and compiles the HTML report against an already running local server. |
| `npm run cy:run` | **Requires Running Server**<br>*(Run `npm run dev` first)* | Runs Cypress headlessly against an already running server without re-generating HTML report. |
| `npm run cy:open` | **Requires Running Server**<br>*(Run `npm run dev` first)* | Opens the interactive Cypress GUI for visual step-by-step browser testing. |
| `npm run test:server` | **Not Required** *(Standalone)* | Runs the 25 `tsx` unit/regression tests in `tests/server/`: Gemini error classification and retry, search fallback routing and client, fallback notices, evolution and chapter assembly, knowledge references, snippet-only pagination, offline book depth (page excerpts, chrome filtering), offline source reliability (reliability tiers, best-first fetching, same-site link following, evidence consolidation), offline text quality (snippet splices, Chinese spacing and glossary terms, headings, localized abstract), local model provider (request translation, provider routing, failover, end-to-end book through a fake local server), built-in model engine (real llama.cpp runtime on a tiny test model, routing, limits, health, end-to-end book), the install-time setup script (skips, failures, no `.env` writes), and `.env.example` / README consistency, content filters, document titles and boundary summarization, hyperlinked/CJK/print-friendly exports, CJK font, and export label localisation. |
| `npm run report:generate` | **Not Required** *(Standalone)* | Compiles the visual HTML report from existing Cucumber JSON test result artifacts. |

### 6a. Troubleshooting Gemini connectivity

The UI used to report almost every failure as "could not be reached" or "busy, wait a minute". It now reports what Google actually answered (key rejected, HTTP 403, HTTP 400, daily quota, model with no quota, per-minute limit, overload, slow-model timeout, real network failure). `DIAGNOSIS.md` records the measured causes of thin books and connectivity failures.

```bash
npm run diagnose                 # asks Google directly, per model: plain request + Google Search grounding
curl http://localhost:3000/api/gemini/health   # same check through the running app server (never returns the key)
```

- Quotas are per Google **project** and per **model**, not per key; a new key in the same project shares them. Daily quotas reset at **midnight Pacific Time**, not 24 hours after you hit them.
- A bare HTTP 429 on Google Search grounding (no quota detail) is a standing grounding limit that waiting may not clear. Slow models (for example `gemini-3.8-flash` in recent measurements) are cut off by `GEMINI_REQUEST_TIMEOUT_MS` and the request moves to a faster sibling. Tunables are listed under Environment Setup.
- A chapter that Gemini cannot write is left out and named in the notice; it is never replaced by filler text.
- If live search is unavailable the engine can write from the model's own knowledge. Such a book is labelled **Model knowledge (not verified against live sources)** and attaches related references (live subject searches or Wikipedia/Google Scholar links) to each chapter without claiming them as cited sources.

### 6b. Writing books with a local model (no Gemini key)

Without a Gemini key the engine already gathers real evidence from the web (6a) and assembles an extractive book. A model running on your own machine can instead **write** the outline and chapters from that evidence, with nothing sent to Google. There are two ways to have one, and the app uses whichever is ready:

| | Built-in (the default) | External server |
| :--- | :--- | :--- |
| What it is | llama.cpp running inside this app through `node-llama-cpp`, with a Gemma model file in `./models/` | Ollama, LM Studio, llama.cpp `llama-server`, vLLM |
| Set up by | `npm install` (see Installation), or later `npm run setup:local-llm` | you: e.g. install Ollama, then `ollama pull gemma4:e4b` |
| Extra programs to run | none | the server |
| Disk / memory | about 2.8 GB download, 4 GB+ RAM for the default Gemma 4 E2B | whatever model you choose |
| GPU | used automatically when the prebuilt binary fits (Apple Silicon Metal, NVIDIA CUDA, Vulkan); otherwise CPU | the server decides |

```bash
npm run local-llm:check                           # loads the model and writes a few tokens: proves it works on this machine
npm run dev                                       # with no GEMINI_API_KEY (or LLM_PROVIDER=local); generate a book
curl http://localhost:3000/api/local-llm/health   # which engine will answer, what is installed, and the next step if nothing is ready
```

| Situation (`LLM_PROVIDER=auto`, `LOCAL_LLM_ENGINE=auto`) | What answers |
| :--- | :--- |
| No Gemini key, an external server is running with the model | The external server (it is the one you chose to run) |
| No Gemini key, no external server, built-in model downloaded | The built-in model writes the outline and chapters |
| Gemini key rejected, out of quota or Google down, a local engine ready | Google is tried first; the local engine takes over for that request |
| Google Search grounding | Always Google (a local model cannot search). Without a key the engine uses its own web search, as in 6a |
| No key and nothing local ready (model not downloaded, no server) | The extractive offline book, written from all the gathered evidence |

- **Honest labelling.** The book's notice names what wrote it, for example "10 chapter requests were answered by gemma-4-E2B-it-Q4_0 (local) instead of the selected gemini-3.6-flash". Nothing is ever presented as Gemma that is not.
- **Switching.** `LOCAL_LLM_ENGINE=http` uses only an external server, `embedded` only the built-in one. `LLM_PROVIDER=gemini` never uses a local model; `local` never calls Google.
- **Bigger or your own model.** `LOCAL_LLM_MODEL_URI=hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M` (about 5.3 GB, 8 GB+ RAM) writes better; `LOCAL_LLM_MODEL_PATH` uses any `.gguf` you already have. Then `npm run setup:local-llm`.
- **Speed.** A local model answers one request at a time by default (`LOCAL_LLM_MAX_CONCURRENCY=1`); a 10-chapter book takes minutes on a laptop, longer on CPU only.
- **Quality.** The default is a small model. It can state things the evidence does not say, so treat a locally written book as a draft to check against its sources. Prompts carry up to about 12,000 characters of evidence; one that does not fit the context window is refused with a message naming `LOCAL_LLM_CONTEXT_SIZE`, never silently cut. For an external Ollama, raise the server's own context length instead (the `OLLAMA_CONTEXT_LENGTH` setting).
- **Failures are final and quiet.** If the model is missing, the runtime cannot run on your machine, or an answer takes longer than `LOCAL_LLM_TIMEOUT_MS`, the engine falls back to the extractive book instead of retrying for minutes. The message says exactly what to run.
- **No internet during install.** The runtime still installs; only the model file is missing. `npm run setup:local-llm` later (it resumes), or set `LOCAL_LLM_MODEL_PATH` to a `.gguf` you copied over.
- **Hosted deployments.** Install with `SKIP_LOCAL_LLM_SETUP=1`: a server does not need a 2.8 GB model and the setup skips itself in production anyway.

### 7. Code Verification

```bash
# Type check without emitting files
npm run lint
```

### 8. Google AI Studio Upload Packaging

```bash
# Package application source archive for Google AI Studio / external deployment
npm run package:aistudio
```

Generates a deployable source ZIP archive at `artifacts/evolutionary-web-book-engine-google-ai-studio-upload.zip` containing the app source, server, scripts, config and metadata, and excluding `tests/`, `node_modules/`, `dist/` and `test-results/`. See `GOOGLE_AI_STUDIO_UPLOAD.md` for limitations and the `process.env.GEMINI_API_KEY` runtime note.

---

## How It Works

1. **Targeted Ingestion**: Gathers initial candidate sources via Gemini with Google Search grounding, preserving verified search URLs and domain citations. If quotas or rate limits are reached, the query transparently routes through the selected fallback provider (`Google + DuckDuckGo`, `Google`, or `DuckDuckGo`), and the notice reports the selected Gemini model, why it was unavailable, and which fallback providers actually supplied evidence. If the fallback providers also return nothing, generation stops with a message (instead of building a book from placeholder content) and the query stays in the search box so you can retry it as-is or refine the wording.
2. **Evolutionary Optimization**:
   - **Fitness Function**: Evaluates candidate text based on Informative Value $I(w)$, Source Authority $A(w)$, and a Redundancy Penalty $R(w, S)$.
   - **Selection & Crossover**: Selects top-scoring genotypes across successive generations (3 by default) to eliminate redundant boilerplate while preserving novel technical facts. Offspring only recombine their parents' text, so assembly draws its evidence from the original sources (a pool of up to 8).
3. **Two-Stage Phenotype Assembly**:
   - Generates a holistic 10-chapter roadmap outline.
   - Expands chapters from an evidence digest with detailed narrative prose, domain definitions, deeper exploratory angles, and visual concept seeds.
4. **Interactive Presentation & Export**:
   - Delivers an interactive multi-page WebBook with jump navigation, concept glossary, and source citations.
   - Enables one-click exports across PDF (with interactive TOC hyperlinks), Word, HTML, and text.

---

## License

MIT (Please refer to [LICENSE.txt](LICENSE.txt))
