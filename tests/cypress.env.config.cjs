/**
 * Cypress Environment Configuration for Web-Book Engine
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

const GLOBAL_ENV_VAR_KEYS = [
  'GEMINI_API_KEY'
];

function loadGlobalEnvironmentVariables() {
  const envVars = {};
  GLOBAL_ENV_VAR_KEYS.forEach(key => {
    if (process.env[key]) {
      envVars[key] = process.env[key];
    }
  });
  return envVars;
}

function resolveBaseUrl(environment) {
  return (
    process.env.CYPRESS_BASE_URL ||
    process.env[`${environment}_BASE_URL`] ||
    process.env.BASE_URL ||
    DEFAULT_BASE_URL
  );
}

function getCypressEnvironmentConfig(environment) {
  const normalizedEnvironment = (environment || 'DEV').toUpperCase();
  const globalVars = loadGlobalEnvironmentVariables();

  return {
    baseUrl: resolveBaseUrl(normalizedEnvironment),
    ...globalVars,
    ENVIRONMENT: normalizedEnvironment
  };
}

module.exports = {
  getCypressEnvironmentConfig,
  GLOBAL_ENV_VAR_KEYS,
  DEFAULT_BASE_URL
};
