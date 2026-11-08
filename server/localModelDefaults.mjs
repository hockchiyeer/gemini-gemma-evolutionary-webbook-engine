// Single source of truth for the built-in local model, read by both the server (TypeScript) and scripts/setup-local-llm.mjs.

/**
 * Gemma 4 E2B (instruction-tuned, ~2.84 GB, 4 GB+ RAM) from the official llama.cpp organisation on Hugging Face. Written as
 * "user/repo/file" so the local file name is known without any network access. A larger model is one setting away, e.g.
 * LOCAL_LLM_MODEL_URI=hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M (about 5.3 GB, 8 GB+ RAM, better quality).
 */
export const DEFAULT_LOCAL_MODEL_URI = 'hf:ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf';

/** Approximate download size of the default model, used for the free-disk-space check before downloading. */
export const DEFAULT_LOCAL_MODEL_SIZE_GB = 3;

/** Largest context window requested from the built-in runtime (prompt + answer, in tokens). */
export const DEFAULT_LOCAL_CONTEXT_SIZE = 16384;
