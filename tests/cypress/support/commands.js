import { objects } from '../e2e/pageObjects';

const SEARCH_FALLBACK_ROUTE = '**/api/search-fallback*';
const PDF_EXPORT_ROUTE = '**/__pdf';
const PICSUM_ROUTE = '**picsum.photos/**';
const FONTS_GOOGLE_ROUTE = '**fonts.googleapis.com/**';
const FONTS_GSTATIC_ROUTE = '**fonts.gstatic.com/**';

function normalizeComparableText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isXPath(locatorStr) {
  return locatorStr.startsWith('//') || locatorStr.startsWith('(') || locatorStr.startsWith('./');
}

function getLocator(pageName, locatorName) {
  const page = pageName.replace(/\s+/g, '');
  const locatorKey = locatorName.replaceAll(' ', '_');

  if (!objects[page] || !objects[page][locatorKey]) {
    throw new Error(`Locator not found: objects['${page}']['${locatorKey}']`);
  }

  return objects[page][locatorKey];
}

function getElement(pageName, locatorName, options = { timeout: 60000 }) {
  const locatorStr = getLocator(pageName, locatorName);
  return isXPath(locatorStr)
    ? cy.xpath(locatorStr, options)
    : cy.get(locatorStr, options);
}

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

function resolveTargetUrl(urlOrEnvironment) {
  return (
    getExposedOrEnv(urlOrEnvironment) ||
    getExposedOrEnv('baseUrl') ||
    Cypress.config('baseUrl') ||
    urlOrEnvironment
  );
}

function buildPrintWindowStub() {
  const stubDoc = {
    title: '',
    head: { querySelector: () => null },
    open: () => {},
    write: () => {},
    close: () => {},
    createElement: () => ({ style: {}, setAttribute: () => {}, click: () => {} }),
  };
  const stub = {
    document: stubDoc,
    history: { replaceState: () => {} },
    focus: () => {},
    print: () => {},
    close: () => {},
    onload: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    clearTimeout: () => {},
    setTimeout: (_fn, _ms) => 0,
  };

  return new Proxy(stub, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop === 'onload' && typeof value === 'function') {
        try {
          value();
        } catch {
          // The print stub should never fail the test while simulating onload.
        }
      }
      return true;
    },
  });
}

function getHistoryCard(title) {
  return cy.get('.fixed.right-0', { timeout: 60000 })
    .contains('h3', title)
    .parents('.bg-white.border')
    .first();
}

Cypress.Commands.add('clearCookiesAndStorage', () => {
  cy.clearAllCookies();
  cy.clearAllSessionStorage();
  cy.clearAllLocalStorage();
});

Cypress.Commands.add('stubGeminiApiToFail', () => {
  cy.intercept('POST', '**/generativelanguage.googleapis.com/**', {
    statusCode: 401,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        code: 401,
        message: 'API_KEY_INVALID - stubbed by Cypress test harness',
        status: 'UNAUTHENTICATED',
      },
    },
  }).as('geminiApiStub');
});

Cypress.Commands.add('mockFallbackSearchResults', (fixtureName = 'search-fallback-quantum-physics.json') => {
  cy.stubGeminiApiToFail();

  cy.fixture(fixtureName).then((payload) => {
    cy.intercept('GET', SEARCH_FALLBACK_ROUTE, (req) => {
      const requestUrl = new URL(req.url);
      const mode = requestUrl.searchParams.get('mode') || payload.mode || 'google_duckduckgo';
      const isDuckDuckGoOnly = mode === 'duckduckgo';

      req.reply({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          ...payload,
          mode,
          provider: isDuckDuckGoOnly ? 'duckduckgo' : (payload.provider || 'google'),
          source: isDuckDuckGoOnly ? 'alternate-search-snippets' : payload.source,
        },
      });
    }).as('searchFallback');
  });
});

Cypress.Commands.add('mockFallbackSearchFailure', (statusCode = 503) => {
  cy.stubGeminiApiToFail();
  cy.intercept('GET', SEARCH_FALLBACK_ROUTE, {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: {
      error: 'Live fallback search is unavailable in this Cypress scenario.',
    },
  }).as('searchFallback');
});

Cypress.Commands.add('stubWebBookExportHandlers', () => {
  cy.intercept('POST', PDF_EXPORT_ROUTE, {
    statusCode: 200,
    headers: { 'content-type': 'application/pdf' },
    body: 'MOCK_PDF',
  }).as('pdfExport');

  cy.fixture('1x1.png', 'binary').then((pngBinary) => {
    cy.intercept('GET', PICSUM_ROUTE, {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: pngBinary,
    }).as('picsumImage');
  });

  cy.intercept('GET', FONTS_GOOGLE_ROUTE, {
    statusCode: 200,
    headers: { 'content-type': 'text/css' },
    body: '',
  }).as('googleFontsCSS');
  cy.intercept('GET', FONTS_GSTATIC_ROUTE, { statusCode: 204, body: '' }).as('googleFontsFiles');

  cy.window().then((win) => {
    const realCreateElement = win.document.createElement.bind(win.document);
    cy.stub(win.document, 'createElement')
      .callsFake((tagName, ...args) => {
        const element = realCreateElement(tagName, ...args);

        if (String(tagName).toLowerCase() === 'iframe') {
          Object.defineProperty(element, 'contentWindow', {
            configurable: true,
            value: buildPrintWindowStub(),
          });
        }

        return element;
      })
      .as('documentCreateElement');

    cy.stub(win.URL, 'createObjectURL').returns('blob:mock-export').as('createObjectURL');
    cy.stub(win.URL, 'revokeObjectURL').as('revokeObjectURL');
    cy.stub(win.HTMLAnchorElement.prototype, 'click').as('downloadClick');
  });
});

Cypress.Commands.add('acceptBrowserConfirmationDialogs', () => {
  cy.window().then((win) => {
    cy.stub(win, 'confirm').returns(true).as('windowConfirm');
  });
});

Cypress.Commands.add('navigateToUrlAndCloseCookiesPopUp', (url) => {
  cy.viewport(2560, 1440);
  cy.visit(resolveTargetUrl(url));
  cy.document().its('readyState').should('eq', 'complete');
});

Cypress.Commands.add('clickOnTheElement', (locatorName, pageName) => {
  getElement(pageName, locatorName).first().click({ force: true });
});

Cypress.Commands.add('clickOnElementContainsText', (locatorName, value, pageName) => {
  getElement(pageName, locatorName).contains(value, { timeout: 60000 }).click({ force: true });
});

Cypress.Commands.add('enterTheValue', (locatorName, pageName, value) => {
  const selectedValue = getExposedOrEnv(value) || value;
  getElement(pageName, locatorName).clear({ force: true }).type(selectedValue, { force: true });
});

Cypress.Commands.add('enterLongQuery', (locatorName, pageName) => {
  const longQuery = [
    'Quantum physics foundations',
    'measurement uncertainty and wave functions',
    'entanglement in quantum communication',
    'quantum computing applications and constraints',
    'precision sensing and materials research',
  ].join('\n');

  getElement(pageName, locatorName).then(($textarea) => {
    const textarea = $textarea[0];
    const elementWindow = textarea.ownerDocument.defaultView;
    const valueSetter = Object.getOwnPropertyDescriptor(
      elementWindow.HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    valueSetter?.call(textarea, longQuery);
    textarea.dispatchEvent(new elementWindow.Event('input', { bubbles: true }));
  });

  getElement(pageName, locatorName)
    .focus()
    .trigger('mouseenter', { force: true });
});

Cypress.Commands.add('pressEnterInElement', (locatorName, pageName) => {
  getElement(pageName, locatorName).type('{enter}', { force: true });
});

Cypress.Commands.add('selectByValue', (value, locatorName, pageName) => {
  getElement(pageName, locatorName).select(value, { force: true });
});

Cypress.Commands.add('verifyElementIsVisible', (locatorName, pageName) => {
  getElement(pageName, locatorName).should('be.visible');
});

Cypress.Commands.add('verifyElementDoesNotExist', (locatorName, pageName) => {
  getElement(pageName, locatorName, { timeout: 10000 }).should('not.exist');
});

Cypress.Commands.add('verifyTextIsDisplayed', (locatorName, pageName, value) => {
  const expectedValue = normalizeComparableText(value);
  getElement(pageName, locatorName).should(($el) => {
    const candidates = [
      normalizeComparableText($el.text()),
      normalizeComparableText($el.val()),
      normalizeComparableText($el.html()),
    ];
    expect(
      candidates.some((candidate) => candidate.includes(expectedValue)),
      `Expected ${locatorName} on ${pageName} to contain "${value}"`
    ).to.be.true;
  });
});

Cypress.Commands.add('verifyTextIsNotDisplayed', (locatorName, pageName, value) => {
  const expectedValue = normalizeComparableText(value);
  getElement(pageName, locatorName).should(($el) => {
    const candidates = [
      normalizeComparableText($el.text()),
      normalizeComparableText($el.val()),
      normalizeComparableText($el.html()),
    ];
    expect(
      candidates.some((candidate) => candidate.includes(expectedValue)),
      `Expected ${locatorName} on ${pageName} not to contain "${value}"`
    ).to.be.false;
  });
});

Cypress.Commands.add('verifyElementIsEnabled', (locatorName, pageName) => {
  getElement(pageName, locatorName).should('not.be.disabled');
});

Cypress.Commands.add('verifyElementIsDisabled', (locatorName, pageName) => {
  getElement(pageName, locatorName).should('be.disabled');
});

Cypress.Commands.add('verifyElementValue', (locatorName, pageName, value) => {
  const expectedValue = getExposedOrEnv(value) || value;
  getElement(pageName, locatorName).should('have.value', expectedValue);
});

Cypress.Commands.add('verifyElementValueIsEmpty', (locatorName, pageName) => {
  getElement(pageName, locatorName).should('have.value', '');
});

Cypress.Commands.add('verifyTitle', (title) => {
  const expectedTitle = normalizeComparableText(title);
  cy.title().should((actualTitle) => {
    expect(normalizeComparableText(actualTitle)).to.include(expectedTitle);
  });
});

Cypress.Commands.add('pageContainsText', (text) => {
  cy.contains(':not(option):not(script):not(style)', text.trim(), { timeout: 60000 }).should('be.visible');
});

Cypress.Commands.add('pageNotContainsText', (text) => {
  cy.contains(':not(option):not(script):not(style)', text.trim(), { timeout: 10000 }).should('not.exist');
});

Cypress.Commands.add('selectFallbackMode', (modeValue) => {
  cy.get('select#fallback-mode', { timeout: 10000 }).select(modeValue, { force: true });
});

Cypress.Commands.add('verifyFallbackModeSelected', (modeValue) => {
  cy.get('select#fallback-mode', { timeout: 10000 }).should('have.value', modeValue);
});

Cypress.Commands.add('selectGeminiModel', (modelValue) => {
  cy.get('select#gemini-model', { timeout: 10000 }).select(modelValue, { force: true });
});

Cypress.Commands.add('verifyGeminiModelSelected', (modelValue) => {
  cy.get('select#gemini-model', { timeout: 10000 }).should('have.value', modelValue);
});

Cypress.Commands.add('verifyFallbackRequestMode', (modeValue) => {
  cy.wait('@searchFallback', { timeout: 60000 }).then(({ request }) => {
    const requestUrl = new URL(request.url);
    expect(requestUrl.searchParams.get('mode')).to.eq(modeValue);
  });
});

Cypress.Commands.add('verifyExportWasStubbed', (exportType) => {
  if (exportType === 'pdf') {
    cy.wait('@pdfExport', { timeout: 60000 });
    cy.get('@downloadClick').should('have.been.called');
    return;
  }

  // The print-friendly PDF is printed by the browser (vector text), so it opens the print dialog like "print".
  if (exportType === 'print' || exportType === 'print_friendly_pdf') {
    cy.get('@documentCreateElement').should('have.been.calledWith', 'iframe');
    return;
  }

  cy.get('@createObjectURL').should('have.been.called');
  cy.get('@downloadClick').should('have.been.called');
});

Cypress.Commands.add('verifyWebBookPageCountAtLeast', (minimumPageCount) => {
  cy.get('.web-book-page', { timeout: 60000 }).should(($pages) => {
    expect($pages.length, 'rendered Web-book pages').to.be.at.least(minimumPageCount);
  });
});

Cypress.Commands.add('clickHistoryBook', (title) => {
  getHistoryCard(title).within(() => {
    cy.contains('button', 'View Book').click({ force: true });
  });
});

Cypress.Commands.add('deleteHistoryBook', (title) => {
  getHistoryCard(title).within(() => {
    cy.get("button[title='Delete this book from history']").click({ force: true });
    cy.contains('button', 'Confirm').click({ force: true });
  });
});
