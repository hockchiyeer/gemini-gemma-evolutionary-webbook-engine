import { Given } from "@badeball/cypress-cucumber-preprocessor";

Given('I navigate to {string} URL and close cookies pop up window', (env) => {
  cy.navigateToUrlAndCloseCookiesPopUp(env);
});

Given('I clear Web browser cookies', () => {
  cy.clearCookiesAndStorage();
});

Given('I stub fallback search results using fixture {string}', (fixtureName) => {
  cy.mockFallbackSearchResults(fixtureName);
});

Given('I stub Gemini API calls to return 401', () => {
  cy.stubGeminiApiToFail();
});

Given('I stub fallback search to fail with status {int}', (statusCode) => {
  cy.mockFallbackSearchFailure(statusCode);
});

Given('I stub Web-book export handlers', () => {
  cy.stubWebBookExportHandlers();
});

Given('I accept browser confirmation dialogs', () => {
  cy.acceptBrowserConfirmationDialogs();
});
