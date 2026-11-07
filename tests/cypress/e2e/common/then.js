import { Then } from "@badeball/cypress-cucumber-preprocessor";

Then("I should see {string} is displayed on {string}", (locator_name, page_name) => {
  cy.verifyElementIsVisible(locator_name, page_name);
});

Then("I should not see {string} on {string}", (locator_name, page_name) => {
  cy.verifyElementDoesNotExist(locator_name, page_name);
});

Then("I should see {string} is disabled on {string}", (locator_name, page_name) => {
  cy.verifyElementIsDisabled(locator_name, page_name);
});

function getExposedOrEnv(key) {
  if (typeof Cypress.expose === 'function') {
    try {
      const val = Cypress.expose(key);
      if (val !== undefined) return val;
    } catch {}
  }
  if (typeof Cypress.env === 'function') {
    try {
      return Cypress.env(key);
    } catch {}
  }
  return undefined;
}

Then("I should see {string} is enabled on {string}", (locator_name, page_name) => {
  cy.verifyElementIsEnabled(locator_name, page_name);
});

Then("I should see {string} text displayed in {string} on {string}", (locator_name, value, page_name) => {
  let expectedValue = getExposedOrEnv(value) || value;
  cy.verifyTextIsDisplayed(locator_name, page_name, expectedValue);
});

Then("I should see {string} value is {string} on {string}", (locator_name, value, page_name) => {
  cy.verifyElementValue(locator_name, page_name, value);
});

Then("I should see {string} value is empty on {string}", (locator_name, page_name) => {
  cy.verifyElementValueIsEmpty(locator_name, page_name);
});

Then("I should not see {string} text displayed in {string} on {string}", (locator_name, value, page_name) => {
  let expectedValue = getExposedOrEnv(value) || value;
  cy.verifyTextIsNotDisplayed(locator_name, page_name, expectedValue);
});

Then("I verify title is {string}", (title) => {
  cy.verifyTitle(title);
});

Then("I verify the text {string} is displayed on the webpage", (text) => {
  let expectedText = getExposedOrEnv(text) || text;
  cy.pageContainsText(expectedText);
});

Then("I verify the text {string} is not displayed on the webpage", (text) => {
  let expectedText = getExposedOrEnv(text) || text;
  cy.pageNotContainsText(expectedText);
});

Then("I should see fallback mode is set to {string}", (modeValue) => {
  cy.verifyFallbackModeSelected(modeValue);
});

Then("I should see Gemini model is set to {string}", (modelValue) => {
  cy.verifyGeminiModelSelected(modelValue);
});

Then("the fallback search API should be requested with mode {string}", (modeValue) => {
  cy.verifyFallbackRequestMode(modeValue);
});

Then("the {string} export should be stubbed successfully", (exportType) => {
  cy.verifyExportWasStubbed(exportType);
});

Then("I should see at least {int} Web-book pages", (minimumPageCount) => {
  cy.verifyWebBookPageCountAtLeast(minimumPageCount);
});
