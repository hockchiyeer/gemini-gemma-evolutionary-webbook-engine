Feature: Web-Book Engine Evolution Pipeline
  As a principal system tester
  I want reliable BDD coverage across ingestion, fallback routing, artifacts, exports, and history
  So that the Evolutionary Web-Book Engine remains stable under deterministic Cypress runs

  Background:
    Given I clear Web browser cookies

  Scenario: Idle application state exposes the expected controls and empty history
    When I navigate to "DEV" URL and close cookies pop up window
    Then I verify title is "Evolutionary Web Book Engine"
    And I should see "engine_title" is displayed on "WebBookEngine_Page"
    And I should see "targeted_ingestion_section" is displayed on "WebBookEngine_Page"
    And I should see "search_input" is enabled on "WebBookEngine_Page"
    And I should see "search_button" is enabled on "WebBookEngine_Page"
    And I should see "fallback_mode_select" is displayed on "WebBookEngine_Page"
    And I should see "gemini_model_select" is displayed on "WebBookEngine_Page"
    And I should see fallback mode is set to "google_duckduckgo"
    And I should see Gemini model is set to "gemini-3.8-flash"
    And I should see "status_label" text displayed in "idle" on "WebBookEngine_Page"
    And I should see "generation_number" text displayed in "0" on "WebBookEngine_Page"
    And I should see "pop_size_number" text displayed in "0" on "WebBookEngine_Page"
    And I should see "evolutionary_metrics_section" is displayed on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"
    And I should not see "export_menu_button" on "WebBookEngine_Page"
    When I click "history_button" on "WebBookEngine_Page"
    Then I should see "history_drawer_title" is displayed on "WebBookEngine_Page"
    And I should see "history_empty_state" is displayed on "WebBookEngine_Page"
    When I click "close_history_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  Scenario Outline: Fallback selector supports every supported mode
    When I navigate to "DEV" URL and close cookies pop up window
    When I select fallback mode "<mode>"
    Then I should see fallback mode is set to "<mode>"
    And I verify the text "<helper_text>" is displayed on the webpage
    And I should see "search_input" is enabled on "WebBookEngine_Page"

    Examples:
      | mode              | helper_text                                                                                                           |
      | google_duckduckgo | Used only if Gemini needs recovery or supplemental search evidence.                                                   |
      | google            | Used only if Gemini needs recovery or supplemental search evidence.                                                   |
      | duckduckgo        | Used only if Gemini needs recovery or supplemental search evidence.                                                   |
      | off               | Gemini-only mode. No Google Search or DuckDuckGo recovery will run if Gemini search or extraction fails.              |

  Scenario: Gemini model selector can be changed independently of fallback mode
    When I navigate to "DEV" URL and close cookies pop up window
    When I select Gemini model "gemini-2.5-flash"
    Then I should see Gemini model is set to "gemini-2.5-flash"
    And I should see fallback mode is set to "google_duckduckgo"

  Scenario: Blank searches are ignored without mutating idle state
    When I navigate to "DEV" URL and close cookies pop up window
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "idle" on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"
    And I should not see "export_menu_button" on "WebBookEngine_Page"

  Scenario: Long multi-line query displays the full query preview
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter a long query in "search_input" on "WebBookEngine_Page"
    Then I should see "query_preview" is displayed on "WebBookEngine_Page"
    And I verify the text "Full Search Query Preview" is displayed on the webpage

  Scenario Outline: Generation completes through each live fallback mode
    Given I stub fallback search results using fixture "<fixture>"
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "<mode>"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "<mode>"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_title" text displayed in "Quantum Physics" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    And I should see "table_of_contents" is displayed on "WebBookEngine_Page"
    And I should see "source_verification" is displayed on "WebBookEngine_Page"
    And I should see at least 6 Web-book pages

    Examples:
      | mode              | fixture                                           |
      | google_duckduckgo | search-fallback-quantum-physics-live-shape.json  |
      | google            | search-fallback-quantum-physics.json             |
      | duckduckgo        | search-fallback-quantum-physics.json             |

  Scenario: Query submission works from the Enter key
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I press Enter in "search_input" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"

  Scenario: Artifacts panel exposes search coverage, population, and assembly trace
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    When I click "show_artifacts_button" on "WebBookEngine_Page"
    Then I should see "artifacts_panel" is displayed on "WebBookEngine_Page"
    And I should see "search_coverage_summary" text displayed in "Quantum physics explains" on "WebBookEngine_Page"
    And I should see "raw_search_grounding" is displayed on "WebBookEngine_Page"
    And I should see "evolved_population" is displayed on "WebBookEngine_Page"
    And I should see "assembly_pipeline" is displayed on "WebBookEngine_Page"
    And I verify the text "Quantum mechanics | Definition, Development, and Equations" is displayed on the webpage
    When I click "hide_artifacts_button" on "WebBookEngine_Page"
    Then I should see "show_artifacts_button" is displayed on "WebBookEngine_Page"

  Scenario Outline: Every export option delegates to the expected browser or server handler
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "<button>" is displayed on "WebBookEngine_Page"
    When I click "<button>" on "WebBookEngine_Page"
    Then the "<export_type>" export should be stubbed successfully

    Examples:
      | button                      | export_type   |
      | export_high_res_pdf_button  | pdf           |
      | print_pdf_button            | print         |
      | print_friendly_pdf_button   | print_friendly_pdf |
      | print_friendly_image_button | print_friendly_jpg |
      | docx_export_button          | docx          |
      | html_export_button          | html          |
      | txt_export_button           | txt           |

  Scenario: New Search clears the rendered book, query, and export controls
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    When I click "new_search_header_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "idle" on "WebBookEngine_Page"
    And I should see "search_input" value is empty on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"
    And I should not see "export_menu_button" on "WebBookEngine_Page"

  Scenario: History can load and delete a generated Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    When I click "history_button" on "WebBookEngine_Page"
    Then I should see "history_drawer_title" is displayed on "WebBookEngine_Page"
    And I verify the text "Quantum Physics" is displayed on the webpage
    When I open history book titled "Quantum Physics"
    Then I should see "generated_book_title" text displayed in "Quantum Physics" on "WebBookEngine_Page"
    When I click "history_button" on "WebBookEngine_Page"
    And I delete history book titled "Quantum Physics"
    Then I should see "history_empty_state" is displayed on "WebBookEngine_Page"

  Scenario: Clear All History asks for confirmation and empties the archive
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    When I click "history_button" on "WebBookEngine_Page"
    Then I should see "clear_all_history_button" is displayed on "WebBookEngine_Page"
    When I click "clear_all_history_button" on "WebBookEngine_Page"
    Then I should see "confirm_clear_all_history_button" is displayed on "WebBookEngine_Page"
    Given I accept browser confirmation dialogs
    When I click "confirm_clear_all_history_button" on "WebBookEngine_Page"
    Then I should see "history_empty_state" is displayed on "WebBookEngine_Page"

  Scenario: Gemini-only mode surfaces a user-facing error when Gemini rejects the key
    Given I stub Gemini API calls to return 401
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "off"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "error_message" is displayed on "WebBookEngine_Page"
    And I verify the text "Gemini" is displayed on the webpage

  Scenario: Fallback transport failure surfaces a clear error state
    Given I stub fallback search to fail with status 503
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "error_message" is displayed on "WebBookEngine_Page"
    And I verify the text "fallback" is displayed on the webpage

  Scenario: Empty fallback evidence stops generation instead of rendering placeholder content
    Given I stub fallback search results using fixture "search-fallback-empty.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Empty Evidence Topic" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then the fallback search API should be requested with mode "google_duckduckgo"
    And I should see "error_message" is displayed on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"
