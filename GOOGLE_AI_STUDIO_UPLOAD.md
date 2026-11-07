# Google AI Studio Upload Package

This repository includes a reproducible source-package archive for Google AI Studio style hosting and external deployment workflows.

## Archive

Run:

```bash
npm run package:aistudio
```

That command creates:

```text
artifacts/evolutionary-web-book-engine-google-ai-studio-upload.zip
```

The archive is intentionally lean:

- includes the app source, Vite config, server middleware, metadata, and lockfile
- excludes local-only folders such as `.git/`, `node_modules/`, `dist/`, `test-results/`, and `tests/`
- keeps `package.json` and `npm start` at the zip root so the project extracts cleanly as a runnable Node/Vite app

## Important limitation

Google's current AI Studio Build documentation says local apps cannot yet be imported back into AI Studio as editable projects. In practice, this zip is best treated as:

- a clean source export
- an upload artifact for external deployment workflows
- a handoff package that mirrors the structure AI Studio-exported apps expect

## Runtime note

Keep the literal `process.env.GEMINI_API_KEY` placeholder path available for AI Studio style Gemini proxy behavior. This repo already preserves that placeholder in the client bundle flow while also supporting local `.env` values for normal development.
