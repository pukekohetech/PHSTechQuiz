// PHSTechQuiz assessment-aware branding v2
// Keeps the site generic until a standard/assessment is selected, then uses
// the JSON metadata to drive the page header, browser tab, result heading,
// and the existing PDF header variables.
(() => {
  "use strict";

  const DEFAULT_TITLE = "PHS Assessment & Evidence";
  const DEFAULT_SUBTITLE = "Technology";

  function text(value) {
    return String(value ?? "").trim();
  }

  function stripAssessmentNumber(value) {
    return text(value).replace(/^\s*\d+\s*[.)\-:]\s*/, "").trim();
  }

  function getBaseBranding() {
    const config = (typeof APP_CONFIG !== "undefined" && APP_CONFIG) ? APP_CONFIG : {};
    return {
      title: text(config.appTitle) || DEFAULT_TITLE,
      subtitle: text(config.appSubtitle) || DEFAULT_SUBTITLE,
    };
  }

  function getCurrentAssessment() {
    const selector = document.getElementById("assessmentSelector");
    if (!selector || selector.value === "") return null;
    if (typeof ASSESSMENTS === "undefined" || !Array.isArray(ASSESSMENTS)) return null;

    const index = Number(selector.value);
    if (!Number.isInteger(index) || index < 0 || index >= ASSESSMENTS.length) return null;
    return ASSESSMENTS[index] || null;
  }

  function getSelectedBranding() {
    const base = getBaseBranding();
    const set = (typeof CURRENT_QUESTION_SET !== "undefined") ? CURRENT_QUESTION_SET : null;

    if (!set) {
      return {
        ...base,
        selectedStandard: false,
        selectedAssessment: false,
        resultTitle: "Assessment Complete!",
      };
    }

    const setDisplay = set.display && typeof set.display === "object" ? set.display : {};
    const standardTitle = text(setDisplay.title) || text(set.label) || base.title;
    const standardSubtitle = text(setDisplay.subtitle) || text(set.title) || base.subtitle;
    const assessment = getCurrentAssessment();

    if (!assessment) {
      return {
        title: standardTitle,
        subtitle: standardSubtitle,
        selectedStandard: true,
        selectedAssessment: false,
        resultTitle: "Assessment Complete!",
      };
    }

    const assessmentDisplay = assessment.display && typeof assessment.display === "object"
      ? assessment.display
      : {};

    const assessmentTitle =
      text(assessmentDisplay.title) ||
      stripAssessmentNumber(assessment.title) ||
      standardTitle;

    // The main heading is the actual assessment section. Keep the standard as
    // the smaller context line so students can always see what they are doing.
    const assessmentSubtitle =
      text(assessmentDisplay.subtitle) ||
      standardTitle ||
      standardSubtitle;

    return {
      title: assessmentTitle,
      subtitle: assessmentSubtitle,
      selectedStandard: true,
      selectedAssessment: true,
      resultTitle: `${assessmentTitle} Complete`,
      standardTitle,
    };
  }

  function applyBranding() {
    const branding = getSelectedBranding();

    const titleEl = document.getElementById("app-title");
    const subtitleEl = document.getElementById("app-subtitle");
    if (titleEl) titleEl.textContent = branding.title;
    if (subtitleEl) subtitleEl.textContent = branding.subtitle;

    if (branding.selectedAssessment) {
      document.title = `${branding.title} | ${branding.standardTitle || "Pukekohe High School"}`;
    } else if (branding.selectedStandard) {
      document.title = `${branding.title} | Pukekohe High School`;
    } else {
      document.title = branding.title;
    }

    // The existing PDF generator reads APP_TITLE / APP_SUBTITLE when it builds
    // the PDF, so synchronising these variables gives the PDF the same branding.
    try {
      if (typeof APP_TITLE !== "undefined") APP_TITLE = branding.title;
      if (typeof APP_SUBTITLE !== "undefined") APP_SUBTITLE = branding.subtitle;
    } catch (error) {
      console.warn("Assessment branding could not update PDF labels:", error);
    }

    // Keep the completion card assessment-specific as well. This replaces the
    // generic 'Assessment Complete!' heading with e.g. 'Written Evidence Complete'.
    const resultHeading = document.querySelector("#result .result-header h2");
    if (resultHeading) resultHeading.textContent = branding.resultTitle;
  }

  function scheduleBrandingRefresh() {
    // The question-set JSON is loaded asynchronously. A short set of refreshes
    // covers both a direct selection and a restored .puk assessment selection.
    [0, 75, 200, 500, 1000].forEach((delay) => window.setTimeout(applyBranding, delay));
  }

  function initAssessmentBranding() {
    document.getElementById("questionSetSelector")
      ?.addEventListener("change", scheduleBrandingRefresh);

    document.getElementById("assessmentSelector")
      ?.addEventListener("change", scheduleBrandingRefresh);

    const meta = document.getElementById("questionSetMeta");
    if (meta && typeof MutationObserver !== "undefined") {
      new MutationObserver(scheduleBrandingRefresh).observe(meta, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    // Result visibility/text changes after Submit & Grade. Observe the result
    // panel so the assessment-specific completion heading cannot be overwritten
    // by the original static HTML while the assessment remains selected.
    const result = document.getElementById("result");
    if (result && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => window.setTimeout(applyBranding, 0)).observe(result, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: false,
      });
    }

    scheduleBrandingRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAssessmentBranding, { once: true });
  } else {
    initAssessmentBranding();
  }
})();
