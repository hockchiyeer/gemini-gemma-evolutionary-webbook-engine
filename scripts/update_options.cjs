const fs = require('fs');
['src/services/evolutionService.ts'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/SearchFallbackOptions/g, 'EngineOptions');
  content = content.replace(/async function searchAndExtractWithGemini\(query: string\)/g, 'async function searchAndExtractWithGemini(query: string, geminiModel?: string)');
  content = content.replace(/await searchAndExtractWithGemini\(query\);/g, 'await searchAndExtractWithGemini(query, options.geminiModel);');
  content = content.replace(/model: GEMINI_SEARCH_MODEL,/g, 'model: geminiModel || GEMINI_SEARCH_MODEL,');
  content = content.replace(/async function assembleWebBookWithGemini\(optimalPopulation: WebPageGenotype\[\], topic: string\)/g, 'async function assembleWebBookWithGemini(optimalPopulation: WebPageGenotype[], topic: string, geminiModel?: string)');
  content = content.replace(/await assembleWebBookWithGemini\(optimalPopulation, topic\);/g, 'await assembleWebBookWithGemini(optimalPopulation, topic, options.geminiModel);');
  content = content.replace(/model: GEMINI_MODEL,/g, 'model: geminiModel || GEMINI_MODEL,');
  fs.writeFileSync(file, content);
});

['src/services/googleSearchFallbackClient.ts'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/SearchFallbackOptions/g, 'EngineOptions');
  fs.writeFileSync(file, content);
});

['src/hooks/useWebBookEngine.ts'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/SearchFallbackOptions/g, 'EngineOptions');
  content = content.replace(/const \[fallbackMode, setFallbackMode\] = useState<SearchFallbackMode>\('google_duckduckgo'\);/, 'const [fallbackMode, setFallbackMode] = useState<SearchFallbackMode>(\'google_duckduckgo\');\n  const [geminiModel, setGeminiModel] = useState<EngineOptions[\'geminiModel\']>();');
  content = content.replace(/const searchResult = await searchAndExtract\(trimmedQuery, \{ mode: fallbackMode \}\);/, 'const searchResult = await searchAndExtract(trimmedQuery, { mode: fallbackMode, geminiModel });');
  fs.writeFileSync(file, content);
});
