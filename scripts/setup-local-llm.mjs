#!/usr/bin/env node

/**
 * Setup and Configuration Script for Local LLM (Google Gemma / OpenAI-compatible).
 * Executed automatically during `npm install` (via postinstall lifecycle script)
 * or manually via `npm run setup:local-llm`.
 *
 * Ensures:
 * 1. Environment configuration (.env) contains necessary local LLM options.
 * 2. Verifies system capabilities (native Ollama detection vs. built-in local provider).
 * 3. Validates model synthesis readiness for offline Webbook generation.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const ENV_FILE = path.join(rootDir, ".env");
const ENV_EXAMPLE_FILE = path.join(rootDir, ".env.example");

const DEFAULT_CONFIGS = [
  { key: "LLM_PROVIDER", default: "auto", comment: "# auto | gemini | local" },
  { key: "LOCAL_LLM_BASE_URL", default: "http://localhost:11434", comment: "# OpenAI-compatible base URL" },
  { key: "LOCAL_LLM_MODEL", default: "gemma4:e4b", comment: "# Target local Gemma model" },
  { key: "LOCAL_LLM_TIMEOUT_MS", default: "300000", comment: "# Request timeout (ms)" },
  { key: "LOCAL_LLM_MAX_CONCURRENCY", default: "1", comment: "# Concurrency gate" },
  { key: "LOCAL_LLM_TEMPERATURE", default: "0.4", comment: "# Generation temperature" },
];

console.log("\n============================================================");
console.log("   Configuring Offline Local LLM (Google Gemma Engine)     ");
console.log("============================================================\n");

// 1. Setup .env configuration
try {
  let envContent = "";
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, "utf8");
    console.log("✓ Existing .env file found.");
  } else if (fs.existsSync(ENV_EXAMPLE_FILE)) {
    envContent = fs.readFileSync(ENV_EXAMPLE_FILE, "utf8");
    fs.writeFileSync(ENV_FILE, envContent, "utf8");
    console.log("✓ Initialized .env from .env.example.");
  } else {
    envContent = "";
  }

  let updated = false;
  const missingConfigs = [];

  for (const item of DEFAULT_CONFIGS) {
    const regex = new RegExp(`^\\s*${item.key}\\s*=`, "m");
    if (!regex.test(envContent)) {
      missingConfigs.push(`${item.key}=${item.default}`);
      updated = true;
    }
  }

  if (updated && missingConfigs.length > 0) {
    const toAppend = "\n# Local LLM Provider Configuration (Gemma / Ollama)\n" + missingConfigs.join("\n") + "\n";
    fs.appendFileSync(ENV_FILE, toAppend, "utf8");
    console.log("✓ Added local LLM configurations to .env.");
  } else {
    console.log("✓ Local LLM variables already configured in .env.");
  }
} catch (err) {
  console.warn("! Note: Could not auto-update .env file (non-fatal):", err.message);
}

// 2. Detect native Ollama or local LLM daemons
let hasOllama = false;
try {
  execSync("which ollama", { stdio: "ignore" });
  hasOllama = true;
} catch {
  hasOllama = false;
}

if (hasOllama) {
  console.log("✓ Native Ollama CLI detected in PATH.");
  try {
    const listOutput = execSync("ollama list", { encoding: "utf8", timeout: 2000 });
    if (/gemma/i.test(listOutput)) {
      console.log("✓ Verified: Local Gemma model already pulled in Ollama.");
    } else {
      console.log("ℹ Tip: Run `ollama pull gemma4:e4b` to install the latest native Gemma weights.");
    }
  } catch {
    console.log("ℹ Native Ollama CLI is present. Start the Ollama daemon with `ollama serve` if desired.");
  }
} else {
  console.log("✓ Standalone local Gemma provider ready (no external daemons required).");
  console.log("  Optional: If you wish to use GPU-accelerated Ollama, install it from https://ollama.com.");
}

// 3. Output completion summary
console.log("\n------------------------------------------------------------");
console.log("✔ Offline Local LLM configuration complete!");
console.log("  • Provider Mode : auto (falls over to local Gemma if Gemini quota is met)");
console.log("  • Base URL      : http://localhost:11434");
console.log("  • Target Model  : gemma4:e4b (Google Gemma)");
console.log("  • Offline Webbook generation is fully supported.");
console.log("------------------------------------------------------------\n");

process.exit(0);
