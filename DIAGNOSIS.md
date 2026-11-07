# Diagnosis: thin Web-Books and "cannot use the Gemini API even after the quota reset"

Scope: base `251f44f` (the zip), plus the two AI Studio commits `152ce0d` and `c981c12`. Everything below marked **measured** was reproduced
against the real code with a mock Gemini endpoint; the sandbox could not reach Google, so nothing was verified against live Google responses.

## 1. The most important point: what Google actually said is still unknown

No reading of the code can tell *why your key fails* because the app threw that information away. Run `npm run diagnose` on the machine that
fails (or open `/api/gemini/health`). It prints Google's real answer per model.

Facts that matter (Google docs):
- Limits are applied **per project, not per key**; a new key in the same project shares them.
- Daily quotas reset at **midnight Pacific Time** (3 pm Malaysia time while the US is on daylight time, 4 pm once US standard time starts on 1 Nov 2026), not 24 h after the quota ran out.
- A 429 with `limit: 0` means the model has **no quota at all** on that project's tier. No amount of waiting fixes it.
- `gemini-2.5-flash` is limited to projects that used it before, so for newer projects it fails with 404. (Removed from the model list in 152ce0d.)
- Google Search grounding has its own daily allowance, shared across Flash and Flash-Lite.
- Reported by users: Search grounding + JSON output can return JSON with its **beginning cut off** (gemini-3.6-flash failed 4 of 5 runs; reported fixed on 3.7).

## 2. Why it looked like "constantly fails to connect" (measured)

| What Google returns | App said before | App says now |
|---|---|---|
| 400 INVALID_ARGUMENT | "Gemini could not be reached. Please verify your connection" | "Google rejected the request as invalid (HTTP 400)…" |
| 403 PERMISSION_DENIED (revoked/leaked key, blocked project) | "could not be reached…" | "Google refused this request (HTTP 403)…" |
| 500 | "could not be reached…" | retried, then "temporarily unavailable" |
| 429 `limit: 0` | "busy, wait a minute" | "no quota for this model… waiting will not help" |
| 429 per day | "busy, wait a minute" | "daily quota used up… resets midnight Pacific" |
| 401 missing key | "key was rejected by Google" | "API key is missing" |

Also: the Gemini client was built once at start-up (a key edited later was never picked up); there was no server-side retry; and in the default
mode these failures were hidden because the app silently switched to scraping Google/DuckDuckGo snippets.

## 3. Why the books were thin (measured)

1. **Burst + all-or-nothing assembly.** 10 chapter requests were fired at once with `Promise.all`. With a 5 requests/minute mock: 20 requests, 5 good chapters
   discarded, result = 6 chapters x ~64 words (offline snippets). Now: 4 real chapters x 380 words kept and the missing ones named.
   Leftover chapter retries also kept running after the book had already given up.
2. **`evolve()` destroyed the evidence.** From 5-10 sources only **1 original** survived 3 generations (the rest were "offspring" built from the first 500
   characters of each parent), and the redundancy penalty was never applied (an empty set was always passed). Assembly then wrote 10 chapters from ~3 KB.
3. **Chapters were written without any evidence**, 350-400 words each (about 120 words per reader page); sources were attached afterwards round-robin.
4. **Over-broad filters.** The "assembly code" regex matched the English words call/add/pop/sub/int/push... : **8.8%** of ordinary 2-sentence technical
   descriptions were rejected (measured on 1,929 samples from 400 real README files; biased toward programming prose). Words such as *cybersecurity*,
   *confidentiality*, *intellectual property*, *disclaimer* and a bare *copyright* deleted every definition in books on those subjects.
5. **Silent filler.** A chapter that failed was replaced by "Comprehensive exploration of X reveals interconnected principles...".

## 4. Review of the two AI Studio commits

Kept: updated model list; bounded chapter concurrency; retry for 503/500; Chinese query variants; PDF header spacing and HTML-attribute cleanup (not touched).

Corrected in this branch:
- `message.includes('retry in ')` as "daily quota exhausted" is unsound. Google's 429 messages are generally worded "...Please retry in 34s" (derived from `RetryInfo`), so the phrase
  does not separate daily from per-minute limits; the rule would make recoverable per-minute limits fatal, and the other string it checks (`per day limit exceeded`) is unlikely to
  appear in Google's wording at all. I could not confirm Google's exact message text from the sandbox. Replaced by reading the structured details (`QuotaFailure.quotaId` containing PerDay,
  `limit: 0`, `RetryInfo.retryDelay`), which do not depend on message wording.
- Chapter fallback to canned text and `Key concept in <title>.` definitions hid failures and *created* thin content. Now a failed chapter is omitted and named.
- Knowledge synthesis asked for "real, authoritative or canonical Wikipedia URL" and substituted a Wikipedia link: unverified citations in the book, labelled `gemini`.
  Now: no URLs, source mode `model_knowledge`, an explicit "NOT verified against live web sources" notice, and it is skipped for causes where it cannot help (bad key, 403, 400).
- Sibling-model failover kept (quotas are per model) but bounded to 2 siblings, skipped for errors identical on every model, and disclosed in the notice.
- Default model back to `gemini-3.8-flash` (what the UI already used, and what Google's docs recommend for new projects).
- Their root-cause statement (503 spikes, grounding sub-quota) is plausible but was not evidenced; items 2-5 above, which they did not touch, are why books were thin.

## 5. Not verified
- Live Google behaviour (sandbox blocked). `npm run diagnose` closes this gap.
- Whether `gemini-3.8-flash` grounded JSON truncates for you; the two-step recovery handles it if so.
- Output length actually produced by the live model for the new 700-900 word prompt.

## 6. Live results from the deployed project (1 Nov 2026, `npm run diagnose`)
- Key valid; plain text generation OK on 3.5-flash-lite, 3.5, 3.6, 3.7 and 3.8 flash.
- **Google Search grounding: HTTP 429 on every model**, a bare `RESOURCE_EXHAUSTED` with only a help link (no `QuotaFailure`, no `RetryInfo`). That names no window and no
  delay, so it is now classified `quota_unspecified` (not retried on the same model; failover to a sibling is tried once; the message explains it). It is a grounding-specific limit,
  separate from the text quota, so the midnight-Pacific reset may not clear it.
- **Latency is the second problem.** One-word request: 1.6 s on 3.6, 30 s on 3.8, 65 s on 3.7 (104-180 s on 3.8/3.7 in another run). Chapter-sized request (~1,200 output
  tokens): 16.6 s on 3.6, 36.1 s on 3.8 (72.9 s with thinking disabled). Hosts that cut requests near 60 s will fail a share of chapter and outline calls on 3.8.
  A failed Stage-1 outline drops the whole book to the offline template, which matches the thin PDFs seen. (Timeout not yet confirmed.)
- Correction to section 4: restoring `gemini-3.8-flash` as default was based on Google's docs; the measurements above favour `gemini-3.6-flash` here. Pick it in the model dropdown.

## 7. Slow-model protection (1 Nov 2026)

- Health check on the deployed app: `gemini-3.6-flash` 2.3 s, `gemini-3.8-flash` 191.5 s for the same one-word request.
- Default model is now `gemini-3.6-flash` everywhere (server, UI, client fallback).
- The server gives up on a single Google request after `GEMINI_REQUEST_TIMEOUT_MS` (default 50 s, 0 = off), aborts it and reports reason `timeout` (HTTP 504). A timeout is never retried on the same model; the client fails over to a sibling model instead and says so in the book's notice.
- Failover order is now fastest first: 3.6, 3.5, 3.5-flash-lite, 3.1-flash-lite, then 3.7 and 3.8.
- Still open: Google Search grounding returns a bare 429 on every model (needs billing or another project), and whether a full book now completes on 3.6.


