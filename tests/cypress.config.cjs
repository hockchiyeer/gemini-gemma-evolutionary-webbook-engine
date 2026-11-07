require('dotenv').config();

const { defineConfig } = require('cypress');
const createBundler = require("@bahmutov/cypress-esbuild-preprocessor");
const addCucumberPreprocessorPlugin = require('@badeball/cypress-cucumber-preprocessor').addCucumberPreprocessorPlugin;
const createEsbuildPlugin = require('@badeball/cypress-cucumber-preprocessor/esbuild').createEsbuildPlugin;
const { getCypressEnvironmentConfig } = require('./cypress.env.config.cjs');
const cucumberConfig = require('./.cypress-cucumber-preprocessorrc.json');

const env = process.env.ENVIRONMENT || 'DEV';
const environmentConfig = getCypressEnvironmentConfig(env);

module.exports = defineConfig({
  screenshotsFolder: 'test-results/chromeReport/screenshots',
  video: false,
  reporter: 'cypress-multi-reporters',
  reporterOptions: {
    'reporterEnabled': 'mochawesome, mocha-junit-reporter',
    'mochawesomeReporterOptions': {
      'reportDir': 'test-results/chromeReport/mochawesome-json',
      'quiet': false,
      'overwrite': false,
      'html': true,
      'json': true
    },
    mochaJunitReporterReporterOptions: {
      'mochaFile': 'test-results/chromeReport/test-[hash].xml'
    },
  },
  e2e: {
    baseUrl: environmentConfig.baseUrl,
    fixturesFolder: 'tests/cypress/fixtures',
    async setupNodeEvents(on, config) {
      await addCucumberPreprocessorPlugin(on, config);
      on('file:preprocessor', createBundler({
        plugins: [
          createEsbuildPlugin(config)
        ]
      }));
      return config;
    },
    specPattern: "tests/cypress/e2e/features/**/*.feature",
    supportFile: "tests/cypress/support/e2e.js",
    expose: {
      ...environmentConfig,
      stepDefinitions: cucumberConfig.stepDefinitions,
      htmlEnabled: cucumberConfig.html?.enabled,
      htmlOutput: cucumberConfig.html?.output,
      jsonEnabled: cucumberConfig.json?.enabled,
      jsonOutput: cucumberConfig.json?.output,
      messagesEnabled: cucumberConfig.messages?.enabled,
      messagesOutput: cucumberConfig.messages?.output
    },
    env: {
      ...environmentConfig,
      stepDefinitions: cucumberConfig.stepDefinitions,
      htmlEnabled: cucumberConfig.html?.enabled,
      htmlOutput: cucumberConfig.html?.output,
      jsonEnabled: cucumberConfig.json?.enabled,
      jsonOutput: cucumberConfig.json?.output,
      messagesEnabled: cucumberConfig.messages?.enabled,
      messagesOutput: cucumberConfig.messages?.output
    }
  },
});
