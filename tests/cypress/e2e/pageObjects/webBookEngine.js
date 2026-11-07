export const WebBookEngine_Page = {
    // Selectors mapped to DOM elements on the WebBook Engine Page
    
    // Header & Global controls
    engine_title: "//h1[contains(normalize-space(.), 'Evolutionary Web-Book Engine')]",
    history_button: "button[title='View and manage previously generated Web-books']",
    new_search_header_button: "button[title='Clear current book and start a new evolutionary search']",

    // Control Sidebar Forms
    targeted_ingestion_section: "//h2[contains(normalize-space(.), 'Targeted Ingestion')]",
    search_input: "textarea[placeholder='Search for topic...']",
    search_button: "button[title='Execute evolutionary synthesis pipeline']",
    new_search_button: "//button[contains(normalize-space(.), 'New Search')]",
    query_preview: "//div[contains(normalize-space(.), 'Full Search Query Preview')]",

    // Fallback Mode Selector
    fallback_mode_select: "select#fallback-mode",
    gemini_model_select: "select#gemini-model",

    // Metrics Panel
    evolutionary_metrics_section: "//h2[contains(normalize-space(.), 'Evolutionary Metrics')]",
    status_label: "//span[normalize-space(.)='Status']/following-sibling::span",
    generation_number: "//span[normalize-space(.)='Generation' or normalize-space(.)='Generation']/following-sibling::span",
    pop_size_number: "//span[contains(normalize-space(.), 'Pop. Size')]/following-sibling::span",
    show_artifacts_button: "//button[contains(normalize-space(.), 'Show Artifacts')]",
    hide_artifacts_button: "//button[contains(normalize-space(.), 'Hide Artifacts')]",
    artifacts_panel: "//h3[contains(normalize-space(.), 'System Artifacts')]",
    search_coverage_summary: "//h4[contains(normalize-space(.), 'Search Coverage Summary')]/following-sibling::div",
    raw_search_grounding: "//h4[contains(normalize-space(.), 'Raw Search Grounding')]",
    evolved_population: "//h4[contains(normalize-space(.), 'Evolved Population')]",
    assembly_pipeline: "//h4[contains(normalize-space(.), 'Assembly Pipeline')]",
    notice_message: ".bg-amber-50.border-amber-200",

    // Error message (rendered by ControlSidebar when an error occurs; status resets to idle)
    error_message: ".bg-red-50.border-red-200",
    export_error_message: ".bg-red-100.border-red-400",

    // Export Menu Button and All Export Options
    export_menu_button: "button[title='Download or print this Web-book in various formats']",
    export_high_res_pdf_button: "button[title='Generate a high-quality PDF with images and styling']",
    print_pdf_button: "button[title='Open system print dialog (recommended for large books)']",
    print_friendly_pdf_button: "button[title='Export A4 size print-friendly full-text report as PDF']",
    print_friendly_image_button: "button[title='Export A4 size print-friendly full-text report as JPG image']",
    docx_export_button: "button[title='Export as Microsoft Word document for editing']",
    html_export_button: "button[title='Download as a standalone HTML file']",
    txt_export_button: "button[title='Export as a simple text file without formatting']",

    // History Drawer
    history_drawer_title: "//h2[contains(normalize-space(.), 'Archive & History')]",
    close_history_button: "button[title='Close history']",
    history_empty_state: "//p[contains(normalize-space(.), 'No archived Web-books found')]",
    clear_all_history_button: "button[title='Permanently delete all archived Web-books']",
    confirm_clear_all_history_button: "//button[contains(normalize-space(.), 'Confirm Delete All')]",
    
    // Viewer
    webbook_viewer_placeholder: "//p[contains(normalize-space(.), 'Enter a topic to generate a structured Web-book')]",
    generated_book_title: ".web-book-container h2",
    table_of_contents: "//h3[contains(normalize-space(.), 'Table of Contents')]",
    source_verification: "//div[contains(normalize-space(.), 'Source Verification')]",
    generated_book_content: ".web-book-container"
};
