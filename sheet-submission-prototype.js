/*
 * PHS Assessment & Evidence - Google Sheets submission prototype v1
 *
 * Purpose:
 *   - Keeps the existing PDF/Drive submission path untouched.
 *   - When submission.mode === "sheet", normal written/reflection assessments
 *     send answer data directly to a separate Google Apps Script sheet gateway.
 *   - Photo Evidence continues to use the existing Drive/file gateway.
 *
 * Load this AFTER flexible-groups.js and photo-evidence.js.
 */
(() => {
  "use strict";

  const PLUGIN_VERSION = "1.1.0";

  // Keep the final versions currently installed by the other QuizMaster plugins.
  const originalClearPreparedPdf = clearPreparedPdf;
  const originalUpdatePdfActionState = updatePdfActionState;
  const originalPreparePdfForExport = preparePdfForExport;
  const originalSubmitWork = window.submitWork || submitWork;
  const originalSubmitToTeacher = window.submitToTeacher || submitToTeacher;

  let sheetPackage = null;

  function isSheetMode() {
    return String(SUBMISSION_SETTINGS?.submission?.mode || "files").trim().toLowerCase() === "sheet";
  }

  function getSheetEndpoint() {
    const url = String(SUBMISSION_SETTINGS?.gateway?.sheetUrl || "").trim();
    if (!url) return "";
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#].*)?$/.test(url)) return "";
    return url;
  }

  function getSheetRootName() {
    return String(
      SUBMISSION_SETTINGS?.storage?.sheetRootName ||
      SUBMISSION_SETTINGS?.storage?.rootName ||
      ""
    )
      .trim()
      .replace(/\s+-\s+\d{4}\s*$/, "")
      .replace(/\s+/g, " ");
  }

  async function checkSheetGateway() {
    const endpoint = getSheetEndpoint();
    if (!endpoint) {
      throw new Error("gateway.sheetUrl is missing or invalid in submission-settings.json.");
    }

    const health = await jsonpRequest(endpoint, { action: "health" }, 7000);
    if (!health || health.state !== "ready" || health.mode !== "sheet") {
      throw new Error(health?.message || "The Google Sheets gateway did not return the expected ready response.");
    }
    return health;
  }

  function currentAssessment() {
    const idx = document.getElementById("assessmentSelector")?.value;
    return idx === "" || idx == null ? null : ASSESSMENTS?.[idx] || null;
  }

  function collectSheetAnswers() {
    const assessment = currentAssessment();
    if (!assessment) return [];

    // gradeIt() also persists the latest on-screen values through saveAnswer().
    const graded = gradeIt();
    const byId = new Map(
      (graded.results || []).map((result) => [String(result.id || "").toUpperCase(), result])
    );

    return (assessment.questions || []).map((question) => {
      const id = String(question.id || "").trim();
      const result = byId.get(id.toUpperCase()) || {};
      const answer = typeof getAnswer === "function"
        ? String(getAnswer(id) || "")
        : String(document.getElementById(`q${id}`)?.value || "");

      return {
        questionId: id,
        question: String(question.text || ""),
        type: String(question.type || "long"),
        group: String(question.group || ""),
        part: String(result.part || question.part || ""),
        answer,
        earned: Number(result.earned || 0),
        maxPoints: Number(result.max ?? question.maxPoints ?? 0),
      };
    });
  }

  function buildSheetPackage() {
    const assessment = currentAssessment();
    if (!assessment || !finalData) return null;

    const answers = collectSheetAnswers();
    return {
      preparedAt: new Date().toISOString(),
      assessmentId: String(assessment.id || finalData.assessmentId || ""),
      answers,
      answerCount: answers.length,
    };
  }

  function setResultOptionVisibility(sheetMode) {
    const moreOptions = document.getElementById("moreOptionsBtn");
    const downloadBtn = document.getElementById("downloadBtn");
    const downloadPukBtn = document.getElementById("downloadPukBtn");
    const shareBtn = document.getElementById("shareBtn");

    if (sheetMode) {
      // Save/load progress remains available from the separate Save & Load panel.
      // These completed-assessment options depend on a rendered PDF/package.
      if (moreOptions) moreOptions.hidden = true;
      [downloadBtn, downloadPukBtn, shareBtn].forEach((button) => {
        if (button) button.hidden = true;
      });
    } else {
      if (moreOptions) moreOptions.hidden = false;
      [downloadBtn, downloadPukBtn, shareBtn].forEach((button) => {
        if (button) button.hidden = false;
      });
    }
  }

  clearPreparedPdf = function sheetAwareClearPreparedPdf() {
    sheetPackage = null;
    return originalClearPreparedPdf();
  };

  updatePdfActionState = function sheetAwareUpdateActionState() {
    if (!isSheetMode()) {
      setResultOptionVisibility(false);
      return originalUpdatePdfActionState();
    }

    setResultOptionVisibility(true);

    const canSubmit = canExportCurrentResult();
    const packageReady = !!sheetPackage;
    const endpointReady = !!getSheetEndpoint();
    const rootNameReady = !!getSheetRootName();
    const busy = !!(pdfPreparationInProgress || submissionInProgress);

    const submitTeacherBtn = document.getElementById("submitTeacherBtn");
    if (submitTeacherBtn) {
      submitTeacherBtn.disabled = !canSubmit || !packageReady || !endpointReady || !rootNameReady || busy || !!lastConfirmedSubmission;
      submitTeacherBtn.setAttribute("aria-busy", String(submissionInProgress));
      submitTeacherBtn.textContent = lastConfirmedSubmission
        ? "Submitted ✓"
        : submissionInProgress
        ? "Submitting…"
        : "Submit to Teacher";
    }

    const status = document.getElementById("pdfStatus");
    if (status) {
      if (!canSubmit) status.textContent = "";
      else if (pdfPreparationInProgress) status.textContent = "Preparing answers for submission…";
      else if (packageReady) status.textContent = "Answers are ready to submit. No PDF will be created.";
      else status.textContent = "Preparing answers…";
    }

    const submissionStatus = document.getElementById("submissionStatus");
    if (submissionStatus && !lastConfirmedSubmission && !submissionInProgress) {
      if (!canSubmit) {
        submissionStatus.textContent = "Reach the required result before teacher submission is available.";
        submissionStatus.className = "submission-card__status warning";
      } else if (!endpointReady) {
        submissionStatus.textContent = "Google Sheets submission is not configured yet. Add gateway.sheetUrl to submission-settings.json.";
        submissionStatus.className = "submission-card__status warning";
      } else if (!rootNameReady) {
        submissionStatus.textContent = "Sheet storage is not configured. Add storage.sheetRootName to submission-settings.json.";
        submissionStatus.className = "submission-card__status warning";
      } else if (!packageReady) {
        submissionStatus.textContent = "Preparing answers for Google Sheets…";
        submissionStatus.className = "submission-card__status";
      } else {
        submissionStatus.textContent = `Ready to submit answers to ${getSheetRootName()}.`;
        submissionStatus.className = "submission-card__status ready";
      }
    }
  };

  preparePdfForExport = async function sheetAwarePrepareForExport() {
    if (!isSheetMode()) return originalPreparePdfForExport();
    if (!canExportCurrentResult()) return;

    pdfPreparationInProgress = true;
    updatePdfActionState();
    try {
      saveStudentInfo();
      sheetPackage = buildSheetPackage();
      if (!sheetPackage) throw new Error("The assessment answers could not be prepared.");
      if (!currentSubmissionId) currentSubmissionId = makeSubmissionId();
      showToast("Answers ready to submit.");
    } catch (error) {
      sheetPackage = null;
      currentSubmissionId = null;
      console.error("Google Sheets submission preparation failed:", error);
      showToast(error.message || "Answers could not be prepared for submission.", false);
    } finally {
      pdfPreparationInProgress = false;
      updatePdfActionState();
    }
  };

  function renderSheetReceipt(status) {
    const receipt = document.getElementById("submissionReceipt");
    const statusEl = document.getElementById("submissionStatus");
    if (!receipt || !finalData) return;

    receipt.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = status?.state === "duplicate" ? "✓ Already received" : "✓ Submission confirmed";

    const details = document.createElement("span");
    details.textContent = `${finalData.studentName} · ${finalData.unitStandard} · ${finalData.teacherName}`;

    const destination = document.createElement("span");
    destination.textContent = status?.tabName
      ? `Answers saved to Google Sheets: ${status.tabName}.`
      : "Answers saved to the teacher Google Sheet.";

    const reference = document.createElement("small");
    reference.textContent = `Reference: ${currentSubmissionId}`;

    receipt.append(heading, details, destination, reference);
    receipt.classList.remove("hidden");

    if (statusEl) {
      statusEl.textContent = status?.state === "duplicate"
        ? "This exact submission was already received, so no duplicate submission was created."
        : "Your answers have been recorded in the teacher Google Sheet.";
      statusEl.className = "submission-card__status success";
    }
  }

  async function waitForSheetStatus(endpoint, submissionId, rootName) {
    const delays = [120, 220, 350, 500, 750, 1100, 1600, 2300];
    let last = null;

    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const status = await jsonpRequest(
          endpoint,
          { action: "status", submissionId, fast: "1", rootName },
          4500
        );
        last = status;
        if (status?.state === "confirmed" || status?.state === "duplicate") return status;
        if (status?.state === "error") throw new Error(status.message || "Teacher submission failed.");
      } catch (_) {}
    }

    const recovered = await jsonpRequest(
      endpoint,
      { action: "status", submissionId, fast: "0", rootName },
      6500
    );
    if (recovered?.state === "confirmed" || recovered?.state === "duplicate") return recovered;
    if (recovered?.state === "error") throw new Error(recovered.message || "Teacher submission failed.");
    return recovered || last;
  }


  async function submitSheetToTeacher() {
    if (submissionInProgress || lastConfirmedSubmission) return;
    if (!canExportCurrentResult()) return showToast("This result is not ready for teacher submission.", false);
    if (!sheetPackage) {
      await preparePdfForExport();
      if (!sheetPackage) return;
    }

    const endpoint = getSheetEndpoint();
    if (!endpoint) return showToast("Google Sheets submission has not been configured yet.", false);
    const storageRootName = getSheetRootName();
    if (!storageRootName) return showToast("Sheet storage has not been configured yet.", false);
    if (!navigator.onLine) return showToast("No internet connection. Reconnect and try again.", false);

    if (!currentSubmissionId) currentSubmissionId = makeSubmissionId();
    const submissionId = currentSubmissionId;
    const assessment = currentAssessment();

    submissionInProgress = true;
    updatePdfActionState();
    const statusEl = document.getElementById("submissionStatus");
    if (statusEl) {
      statusEl.textContent = "Sending answers to Google Sheets…";
      statusEl.className = "submission-card__status";
    }

    try {
      const health = await checkSheetGateway();
      if (!health?.ok) throw new Error(health?.message || "Google Sheets gateway is not ready.");

      const payload = {
        submissionMode: "sheet",
        submissionId,
        appId: APP_ID,
        appVersion: APP_VERSION,
        questionSetId: CURRENT_QUESTION_SET?.id || "",
        storageRootName,
        studentName: finalData.studentName,
        studentId: finalData.studentId,
        teacherId: finalData.teacherId,
        teacherName: finalData.teacherName,
        teacherEmail: finalData.teacherEmail,
        unitStandard: finalData.unitStandard,
        standardVersion: finalData.standardVersion,
        assessmentId: finalData.assessmentId,
        assessmentTitle: finalData.assessmentTitle,
        assessmentSubtitle: finalData.assessmentSubtitle || "",
        score: finalData.points,
        totalMarks: finalData.totalPoints,
        percentage: finalData.pct,
        submittedAt: new Date().toISOString(),
        answers: sheetPackage.answers,
      };

      await fetch(endpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      if (statusEl) statusEl.textContent = "Answers received. Confirming the Google Sheet…";
      const status = await waitForSheetStatus(endpoint, submissionId, storageRootName);
      if (!status || (status.state !== "confirmed" && status.state !== "duplicate")) {
        throw new Error("The answers were sent, but confirmation was not received. Tap Submit to Teacher again to safely retry.");
      }

      lastConfirmedSubmission = status;

      const helper = window.QuizMasterFlexible;
      helper?.recordSubmission?.({
        submissionId,
        kind: "assessment",
        questionSetId: CURRENT_QUESTION_SET?.id || "",
        assessmentId: finalData.assessmentId,
        assessmentTitle: finalData.assessmentTitle,
        descriptor: status?.tabName ? `Google Sheet: ${status.tabName}` : "Google Sheet submission",
        method: "sheet",
        state: status.state,
        rootName: storageRootName,
        repeatable: false,
        startedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
        answerSignature: helper?.assessmentAnswerSignature?.(finalData.assessmentId) || "",
        lastError: "",
      });

      renderSheetReceipt(status);
      showToast(status.state === "duplicate" ? "Already received — no duplicate created." : "Submission confirmed in Google Sheets.");
    } catch (error) {
      console.error("Google Sheets teacher submission failed:", error);
      if (statusEl) {
        statusEl.textContent = error.message || "Submission failed. Your answers are still safe on this device.";
        statusEl.className = "submission-card__status error";
      }
      showToast("Submission was not confirmed. Your answers are still safe here.", false);
    } finally {
      submissionInProgress = false;
      updatePdfActionState();
    }
  }

  submitWork = function sheetAwareSubmitWork(...args) {
    const result = originalSubmitWork.apply(this, args);
    if (isSheetMode() && finalData && canExportCurrentResult()) {
      showToast("Great job! Preparing your answers for submission…", true);
    }
    return result;
  };

  submitToTeacher = function sheetAwareSubmitToTeacher(...args) {
    if (!isSheetMode()) return originalSubmitToTeacher.apply(this, args);
    return submitSheetToTeacher();
  };

  // Inline onclick handlers use the window properties.
  window.submitWork = submitWork;
  window.submitToTeacher = submitToTeacher;

  window.PHS_SheetSubmissionPrototype = Object.freeze({
    version: PLUGIN_VERSION,
    isSheetMode,
    collectSheetAnswers,
    getSheetEndpoint,
    getSheetRootName,
    checkGateway: checkSheetGateway,
  });

  document.addEventListener("DOMContentLoaded", () => {
    window.setTimeout(() => updatePdfActionState(), 0);

    if (isSheetMode()) {
      window.setTimeout(async () => {
        try {
          const health = await checkSheetGateway();
          console.info("Google Sheets submission gateway ready:", health);
        } catch (error) {
          console.warn("Google Sheets submission gateway check failed:", error);
        }
      }, 500);
    }
  });
})();
