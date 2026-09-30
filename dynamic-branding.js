// PHSTechQuiz dynamic assessment branding
// Loads after script.js. Uses the selected questionSet JSON to drive the
// page heading, browser-tab title and the existing PDF header variables.
(() => {
  "use strict";

  function getBaseBranding() {
    const config = (typeof APP_CONFIG !== "undefined" && APP_CONFIG) ? APP_CONFIG : {};
    return {
      title: String(config.appTitle || "PHS Assessment & Evidence").trim(),
      subtitle: String(config.appSubtitle || "Technology").trim(),
    };
  }

  function getSelectedBranding() {
    const base = getBaseBranding();
    const set = (typeof CURRENT_QUESTION_SET !== "undefined") ? CURRENT_QUESTION_SET : null;
    if (!set) return { ...base, selected: false };

    const display = set.display && typeof set.display === "object" ? set.display : {};
    return {
      title: String(display.title || set.label || base.title).trim(),
      subtitle: String(display.subtitle || set.title || base.subtitle).trim(),
      selected: true,
    };
  }

  function applyBranding() {
    const branding = getSelectedBranding();

    const titleEl = document.getElementById("app-title");
    const subtitleEl = document.getElementById("app-subtitle");
    if (titleEl) titleEl.textContent = branding.title;
    if (subtitleEl) subtitleEl.textContent = branding.subtitle;

    document.title = branding.selected
      ? `${branding.title} | Pukekohe High School`
      : branding.title;

    // Keep the existing PDF generator in sync. script.js already uses these
    // globals when it creates the PDF header.
    try {
      if (typeof APP_TITLE !== "undefined") APP_TITLE = branding.title;
      if (typeof APP_SUBTITLE !== "undefined") APP_SUBTITLE = branding.subtitle;
    } catch (error) {
      console.warn("Assessment branding could not update PDF labels:", error);
    }
  }

  function scheduleBrandingRefresh() {
    [0, 100, 300, 800].forEach((delay) => window.setTimeout(applyBranding, delay));
  }

  function initDynamicBranding() {
    const selector = document.getElementById("questionSetSelector");
    if (selector) selector.addEventListener("change", scheduleBrandingRefresh);

    const meta = document.getElementById("questionSetMeta");
    if (meta && typeof MutationObserver !== "undefined") {
      new MutationObserver(applyBranding).observe(meta, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    scheduleBrandingRefresh();
    window.setTimeout(applyBranding, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDynamicBranding, { once: true });
  } else {
    initDynamicBranding();
  }
})();
