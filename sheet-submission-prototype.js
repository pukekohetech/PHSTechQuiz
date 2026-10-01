/*
 * PHS Assessment & Evidence - Google Sheets unit snapshot submission prototype v1.3
 *
 * Sheet mode now submits a COMPLETE UNIT SNAPSHOT:
 *   - every defined question in every assessment section
 *   - blank answers as blank cells
 *   - current saved answers from any section
 *   - assessment progress/result metadata
 *   - photo-evidence definitions and submitted evidence links
 *
 * Photo evidence still uses the existing Drive/file gateway. The sheet stores
 * the confirmed evidence URL already returned by that gateway (currently the
 * evidence PDF containing the submitted photo and its details).
 *
 * Load AFTER flexible-groups.js and photo-evidence.js.
 */
(() => {
  "use strict";

  const PLUGIN_VERSION = "1.3.0";

  const originalClearPreparedPdf = clearPreparedPdf;
  const originalUpdatePdfActionState = updatePdfActionState;
  const originalPreparePdfForExport = preparePdfForExport;
  const originalSubmitWork = window.submitWork || submitWork;
  const originalSubmitToTeacher = window.submitToTeacher || submitToTeacher;

  let sheetPackage = null;
  let photoSyncTimer = 0;

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
    if (!endpoint) throw new Error("gateway.sheetUrl is missing or invalid in submission-settings.json.");
    const health = await jsonpRequest(endpoint, { action: "health" }, 7000);
    if (!health || health.state !== "ready" || health.mode !== "unit-sheet") {
      throw new Error(health?.message || "The Google Sheets unit gateway did not return the expected ready response.");
    }
    return health;
  }

  function currentAssessment() {
    const idx = document.getElementById("assessmentSelector")?.value;
    return idx === "" || idx == null ? null : ASSESSMENTS?.[idx] || null;
  }

  function safeId(value, fallback = "item") {
    return String(value || fallback)
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  }

  function fillTemplate(value, vars) {
    return String(value ?? "").replace(/\{(n|count|min|max)\}/g, (_, key) => {
      const val = vars[key];
      return val == null || val === Infinity ? "" : String(val);
    });
  }

  function repeatLimits(block) {
    const startWith = Math.max(1, Number(block?.startWith ?? block?.minimum ?? 1) || 1);
    const minimum = Math.max(0, Number(block?.minimum ?? startWith) || 0);
    const rawMax = block?.maximum;
    const maximum = rawMax == null || rawMax === "" ? Infinity : Math.max(minimum, Number(rawMax) || minimum);
    return { startWith: Math.min(Math.max(startWith, minimum), maximum), minimum, maximum };
  }

  function repeatCount(assessment, block) {
    try {
      const value = window.QuizMasterFlexible?.getRepeatCount?.(assessment, block);
      if (Number.isFinite(Number(value))) return Number(value);
    } catch (_) {}

    const { startWith, minimum, maximum } = repeatLimits(block);
    const saved = Number(data?.repeatCounts?.[assessment.id]?.[block.id]);
    const value = Number.isInteger(saved) ? saved : startWith;
    return Math.min(Math.max(value, minimum), maximum);
  }

  function storedAnswer(assessmentId, questionId) {
    try {
      if (String(currentAssessmentId || "") === String(assessmentId || "")) {
        const field = document.getElementById("q" + questionId);
        if (field) return String(field.value ?? "");
      }

      const encoded = data?.answers?.[assessmentId]?.[questionId];
      if (!encoded) return "";
      return String(xorDecode(encoded) ?? "");
    } catch (_) {
      return "";
    }
  }

  function scoreQuestion(question, answer) {
    const maxPoints = Math.max(0, Number(question?.maxPoints ?? 1) || 0);
    const value = String(answer || "").trim();
    if (!value || !maxPoints) return 0;

    let earned = 0;
    (question?.rubric || []).forEach((rule) => {
      try {
        let check = rule?.check;
        if (!(check instanceof RegExp)) check = new RegExp(String(check || ""), String(rule?.flags || "i"));
        check.lastIndex = 0;
        if (!check.test(value)) return;
        const points = Number(rule?.points || 0);
        if (maxPoints === 1) earned = Math.max(earned, Math.min(points, maxPoints));
        else earned += points;
      } catch (_) {}
    });

    return Math.min(maxPoints, earned);
  }

  function pushQuestion(target, seen, assessment, question, overrides = {}) {
    if (!question) return;
    const id = String(overrides.id || question.id || "").trim();
    if (!id) return;
    const key = `${assessment.id}\u001f${id}`;
    if (seen.has(key)) return;
    seen.add(key);

    const text = String(overrides.text ?? question.text ?? "");
    const answer = storedAnswer(assessment.id, id);
    const maxPoints = Math.max(0, Number(question.maxPoints ?? 1) || 0);

    target.push({
      assessmentId: String(assessment.id || ""),
      assessmentTitle: String(assessment.title || assessment.id || "Assessment"),
      questionId: id,
      question: text,
      type: String(question.type || "long"),
      group: String(overrides.group ?? question.group ?? ""),
      part: String(overrides.part ?? question.part ?? ""),
      answer,
      earned: scoreQuestion(question, answer),
      maxPoints,
    });
  }

  function questionsForAssessment(assessment) {
    const questions = [];
    const seen = new Set();

    if (!Array.isArray(assessment?.blocks)) {
      (assessment?.questions || []).forEach((q) => pushQuestion(questions, seen, assessment, q));
      return questions;
    }

    assessment.blocks.forEach((block, blockIndex) => {
      const type = String(block?.type || "group").trim();
      const blockId = safeId(block?.id || `block-${blockIndex + 1}`, `block-${blockIndex + 1}`);

      if (type === "group") {
        const vars = { n: 1, count: 1, min: 1, max: 1 };
        (block.questions || []).forEach((q, qIndex) => {
          const id = safeId(q?.id || `q${qIndex + 1}`, `q${qIndex + 1}`);
          pushQuestion(questions, seen, assessment, q, {
            id,
            group: blockId,
            text: fillTemplate(q?.text || "", vars),
          });
        });
        return;
      }

      if (type === "questions") {
        (block.questions || []).forEach((q, qIndex) => {
          const id = safeId(q?.id || `${blockId}-q${qIndex + 1}`, `${blockId}-q${qIndex + 1}`);
          pushQuestion(questions, seen, assessment, q, { id, group: "" });
        });
        return;
      }

      if (type === "conditional") {
        const vars = { n: 1, count: 1, min: 1, max: 1 };
        const controller = block.question || {};
        const controllerId = safeId(controller.id || `${blockId}-choice`, `${blockId}-choice`);
        pushQuestion(questions, seen, assessment, controller, {
          id: controllerId,
          group: blockId,
          text: fillTemplate(controller.text || "", vars),
        });

        // Include ALL defined follow-up questions, even when the branch is not visible.
        // This is intentional: the teacher sheet represents the entire unit structure.
        (block.questions || []).forEach((q, qIndex) => {
          const id = safeId(q?.id || `${blockId}-q${qIndex + 1}`, `${blockId}-q${qIndex + 1}`);
          pushQuestion(questions, seen, assessment, q, {
            id,
            group: blockId,
            text: fillTemplate(q?.text || "", vars),
          });
        });
        return;
      }

      if (type !== "repeatGroup") return;

      const count = repeatCount(assessment, block);
      const { minimum, maximum } = repeatLimits(block);
      for (let n = 1; n <= count; n += 1) {
        const vars = { n, count, min: minimum, max: maximum };
        const groupId = `${blockId}-${n}`;
        (block.questions || []).forEach((q, qIndex) => {
          const localId = safeId(q?.id || `q${qIndex + 1}`, `q${qIndex + 1}`);
          const id = `${blockId}_${n}_${localId}`;
          pushQuestion(questions, seen, assessment, q, {
            id,
            group: groupId,
            part: String(n),
            text: fillTemplate(q?.text || "", vars),
          });
        });
      }
    });

    return questions;
  }

  function confirmedState(value) {
    return value === "confirmed" || value === "duplicate";
  }

  function evidenceDefinitions() {
    const defs = [];
    (ASSESSMENTS || []).forEach((assessment) => {
      const options = assessment?.photoEvidence?.options;
      if (!Array.isArray(options)) return;
      options.forEach((option) => {
        defs.push({
          assessmentId: String(assessment.id || ""),
          assessmentTitle: String(assessment.title || "Photo Evidence"),
          optionId: String(option.id || ""),
          optionLabel: String(option.label || option.id || "Evidence"),
          repeatable: option.repeatable !== false,
          fields: (option.fields || []).map((field) => ({
            id: String(field.id || ""),
            label: String(field.label || field.id || "Evidence detail"),
          })),
        });
      });
    });
    return defs;
  }

  function evidenceDetailStore() {
    if (!data.unitSheetEvidenceDetails || typeof data.unitSheetEvidenceDetails !== "object") {
      data.unitSheetEvidenceDetails = {};
    }
    return data.unitSheetEvidenceDetails;
  }

  function capturePhotoEvidenceDetails(record) {
    const assessment = (ASSESSMENTS || []).find((item) => String(item?.id || "") === String(record?.assessmentId || ""));
    const option = (assessment?.photoEvidence?.options || []).find((item) => String(item?.id || "") === String(record?.optionId || ""));
    if (!record?.submissionId || !option) return null;

    const fieldValues = {};
    (option.fields || []).forEach((field) => {
      const id = String(field?.id || "");
      if (!id) return;
      const control = document.getElementById(`photoField_${id}`);
      fieldValues[id] = String(control?.value || "").trim();
    });

    const detail = {
      assessmentId: String(record.assessmentId || ""),
      optionId: String(record.optionId || ""),
      optionLabel: String(record.optionLabel || option.label || ""),
      descriptor: String(record.descriptor || ""),
      fieldValues,
      savedAt: new Date().toISOString(),
    };
    evidenceDetailStore()[String(record.submissionId)] = detail;
    if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
    return detail;
  }

  function evidenceRecords() {
    const records = new Map();
    const details = evidenceDetailStore();

    (Array.isArray(data?.evidenceRecords) ? data.evidenceRecords : []).forEach((record) => {
      if (!record?.submissionId || !confirmedState(record?.state || "confirmed")) return;
      records.set(String(record.submissionId), {
        assessmentId: String(record.assessmentId || ""),
        optionId: String(record.optionId || ""),
        optionLabel: String(record.optionLabel || ""),
        descriptor: String(record.descriptor || ""),
        method: String(record.method || "photo"),
        submissionId: String(record.submissionId || ""),
        submittedAt: String(record.submittedAt || ""),
        state: String(record.state || "confirmed"),
        photoUrl: String(record.photoUrl || ""),
        pdfUrl: String(record.pdfUrl || ""),
        repeatable: record.repeatable !== false,
        fieldValues: { ...(details[String(record.submissionId)]?.fieldValues || {}) },
      });
    });

    // Older backups may have a confirmed photo submission record but no separate
    // evidenceRecords entry. Include it so the teacher sheet does not lose the link.
    (Array.isArray(data?.submissionRecords) ? data.submissionRecords : []).forEach((record) => {
      if (record?.kind !== "photoEvidence" || !record?.submissionId || !confirmedState(record?.state)) return;
      const id = String(record.submissionId);
      if (records.has(id)) return;
      records.set(id, {
        assessmentId: String(record.assessmentId || ""),
        optionId: String(record.optionId || ""),
        optionLabel: String(record.optionLabel || ""),
        descriptor: String(record.descriptor || ""),
        method: String(record.method || "photo"),
        submissionId: id,
        submittedAt: String(record.confirmedAt || record.startedAt || ""),
        state: String(record.state || "confirmed"),
        photoUrl: String(record.photoUrl || ""),
        pdfUrl: String(record.pdfUrl || ""),
        repeatable: record.repeatable !== false,
        fieldValues: { ...(details[id]?.fieldValues || {}) },
      });
    });

    return Array.from(records.values()).sort((a, b) => Date.parse(a.submittedAt || 0) - Date.parse(b.submittedAt || 0));
  }

  function confirmedAssessmentRecord(assessmentId) {
    return (Array.isArray(data?.submissionRecords) ? data.submissionRecords : [])
      .filter((record) => record?.kind === "assessment" && String(record?.assessmentId || "") === String(assessmentId || "") && confirmedState(record?.state))
      .sort((a, b) => Date.parse(b?.confirmedAt || b?.startedAt || 0) - Date.parse(a?.confirmedAt || a?.startedAt || 0))[0] || null;
  }

  function assessmentSummaries(allQuestions, allEvidence, override = null) {
    return (ASSESSMENTS || []).map((assessment) => {
      const questions = allQuestions.filter((q) => q.assessmentId === String(assessment.id || ""));
      const evidence = allEvidence.filter((record) => record.assessmentId === String(assessment.id || ""));
      const answered = questions.filter((q) => String(q.answer || "").trim()).length;
      const totalQuestions = questions.length;
      const earned = questions.reduce((sum, q) => sum + Number(q.earned || 0), 0);
      const totalMarks = questions.reduce((sum, q) => sum + Number(q.maxPoints || 0), 0);
      const existing = confirmedAssessmentRecord(assessment.id);
      const isOverride = override && String(override.assessmentId || "") === String(assessment.id || "");

      let status = "Not started";
      if (existing || isOverride) status = "Submitted";
      else if (evidence.length) status = "Evidence submitted";
      else if (answered) status = "In progress";

      let result = "";
      if (isOverride && Number.isFinite(Number(override.percentage))) {
        result = `${Number(override.score || 0)}/${Number(override.totalMarks || 0)} (${Number(override.percentage || 0)}%)`;
      } else if (totalMarks > 0 && answered > 0) {
        const pct = Math.round((earned / totalMarks) * 100);
        result = `${earned}/${totalMarks} (${pct}%)`;
      }

      return {
        assessmentId: String(assessment.id || ""),
        assessmentTitle: String(assessment.title || assessment.id || "Assessment"),
        mode: String(assessment.mode || (assessment.photoEvidence ? "photo-evidence" : "questions")),
        status,
        result,
        answered,
        totalQuestions,
        evidenceCount: evidence.length,
        lastSubmitted: String(
          isOverride ? override.submittedAt || new Date().toISOString() :
          existing?.confirmedAt || existing?.startedAt ||
          evidence[evidence.length - 1]?.submittedAt || ""
        ),
      };
    });
  }

  function buildUnitSnapshot(override = null) {
    try { persistCurrentAssessmentAnswers(); } catch (_) {}
    try { saveStudentInfo(); } catch (_) {}

    const questions = [];
    (ASSESSMENTS || []).forEach((assessment) => questions.push(...questionsForAssessment(assessment)));
    const evidence = evidenceRecords();
    const defs = evidenceDefinitions();
    const assessments = assessmentSummaries(questions, evidence, override);
    const submittedSections = assessments.filter((item) => item.status === "Submitted" || item.status === "Evidence submitted").length;

    return {
      schemaVersion: 1,
      questionSetId: String(CURRENT_QUESTION_SET?.id || ""),
      unitStandard: String(CURRENT_QUESTION_SET?.label || ""),
      unitTitle: String(CURRENT_QUESTION_SET?.title || ""),
      capturedAt: new Date().toISOString(),
      assessments,
      questions,
      evidenceDefinitions: defs,
      evidence,
      totals: {
        assessmentCount: assessments.length,
        submittedSections,
        questionCount: questions.length,
        answeredQuestionCount: questions.filter((q) => String(q.answer || "").trim()).length,
        evidenceCount: evidence.length,
      },
    };
  }

  function identitySnapshot() {
    const teacherId = String(document.getElementById("teacher")?.value || data?.teacher || "").trim();
    const teacher = (TEACHERS || []).find((item) => String(item?.id || "") === teacherId) || {};
    const studentName = String(document.getElementById("name")?.value || data?.name || "").trim();
    const studentId = String(document.getElementById("id")?.value || data?.id || "").trim();
    const standardPrefix = CURRENT_QUESTION_SET?.standardPrefix || "US";
    const standardNumber = CURRENT_QUESTION_SET?.number || "";
    return {
      studentName,
      studentId,
      teacherId,
      teacherName: String(teacher.name || teacherId),
      teacherEmail: String(teacher.email || ""),
      unitStandard: `${standardPrefix} ${standardNumber}`.trim(),
      standardVersion: String(CURRENT_QUESTION_SET?.version || ""),
    };
  }

  function makeSheetSubmissionId(prefix = "unit_sheet") {
    const random = new Uint32Array(2);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(random);
    else {
      random[0] = Math.floor(Math.random() * 0xffffffff);
      random[1] = Math.floor(Math.random() * 0xffffffff);
    }
    return `${prefix}_${Date.now()}_${random[0].toString(36)}${random[1].toString(36)}`;
  }

  async function waitForSheetStatus(endpoint, submissionId, rootName) {
    const delays = [120, 220, 350, 500, 750, 1100, 1600, 2300];
    let last = null;
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const status = await jsonpRequest(endpoint, { action: "status", submissionId, fast: "1", rootName }, 4500);
        last = status;
        if (status?.state === "confirmed" || status?.state === "duplicate") return status;
        if (status?.state === "error") throw new Error(status.message || "Teacher submission failed.");
      } catch (_) {}
    }

    const recovered = await jsonpRequest(endpoint, { action: "status", submissionId, fast: "0", rootName }, 6500);
    if (recovered?.state === "confirmed" || recovered?.state === "duplicate") return recovered;
    if (recovered?.state === "error") throw new Error(recovered.message || "Teacher submission failed.");
    return recovered || last;
  }

  async function postUnitSnapshot({ submissionId, trigger, triggerAssessment, override, showStatus = false }) {
    const endpoint = getSheetEndpoint();
    const storageRootName = getSheetRootName();
    if (!endpoint || !storageRootName || !navigator.onLine) throw new Error("Google Sheets submission is not available.");

    const identity = identitySnapshot();
    if (!identity.studentName) throw new Error("Student name is required.");
    if (!/^\d{3,6}$/.test(identity.studentId)) throw new Error("A valid Student ID is required.");
    if (!identity.teacherId) throw new Error("Teacher is required.");

    const unitSnapshot = buildUnitSnapshot(override);
    const assessment = triggerAssessment || currentAssessment() || {};
    const payload = {
      submissionMode: "unit-sheet",
      submissionId,
      trigger: String(trigger || "assessment"),
      appId: APP_ID,
      appVersion: APP_VERSION,
      questionSetId: String(CURRENT_QUESTION_SET?.id || ""),
      storageRootName,
      studentName: identity.studentName,
      studentId: identity.studentId,
      teacherId: identity.teacherId,
      teacherName: identity.teacherName,
      teacherEmail: identity.teacherEmail,
      unitStandard: identity.unitStandard,
      standardVersion: identity.standardVersion,
      assessmentId: String(assessment.id || override?.assessmentId || "unit-snapshot"),
      assessmentTitle: String(assessment.title || override?.assessmentTitle || "Unit snapshot"),
      score: Number(override?.score || 0),
      totalMarks: Number(override?.totalMarks || 0),
      percentage: Number(override?.percentage || 0),
      submittedAt: String(override?.submittedAt || new Date().toISOString()),
      unitSnapshot,
    };

    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const status = await waitForSheetStatus(endpoint, submissionId, storageRootName);
    if (!status || (status.state !== "confirmed" && status.state !== "duplicate")) {
      throw new Error("The unit snapshot was sent, but confirmation was not received.");
    }
    return status;
  }

  function setResultOptionVisibility(sheetMode) {
    const moreOptions = document.getElementById("moreOptionsBtn");
    const downloadBtn = document.getElementById("downloadBtn");
    const downloadPukBtn = document.getElementById("downloadPukBtn");
    const shareBtn = document.getElementById("shareBtn");
    if (sheetMode) {
      if (moreOptions) moreOptions.hidden = true;
      [downloadBtn, downloadPukBtn, shareBtn].forEach((button) => { if (button) button.hidden = true; });
    } else {
      if (moreOptions) moreOptions.hidden = false;
      [downloadBtn, downloadPukBtn, shareBtn].forEach((button) => { if (button) button.hidden = false; });
    }
  }

  clearPreparedPdf = function unitSheetClearPreparedPdf() {
    sheetPackage = null;
    return originalClearPreparedPdf();
  };

  updatePdfActionState = function unitSheetUpdateActionState() {
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
      submitTeacherBtn.textContent = lastConfirmedSubmission ? "Submitted ✓" : submissionInProgress ? "Submitting…" : "Submit to Teacher";
    }

    const status = document.getElementById("pdfStatus");
    if (status) {
      if (!canSubmit) status.textContent = "";
      else if (pdfPreparationInProgress) status.textContent = "Preparing the complete unit snapshot…";
      else if (packageReady) status.textContent = "Complete unit record ready. No assessment PDF will be created.";
      else status.textContent = "Preparing the complete unit record…";
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
        submissionStatus.textContent = "Preparing every question and evidence link from this unit…";
        submissionStatus.className = "submission-card__status";
      } else {
        const totals = sheetPackage?.snapshot?.totals || {};
        submissionStatus.textContent = `Ready: ${totals.questionCount || 0} unit questions plus ${totals.evidenceCount || 0} evidence record${Number(totals.evidenceCount || 0) === 1 ? "" : "s"}.`;
        submissionStatus.className = "submission-card__status ready";
      }
    }
  };

  preparePdfForExport = async function unitSheetPrepareForExport() {
    if (!isSheetMode()) return originalPreparePdfForExport();
    if (!canExportCurrentResult()) return;

    pdfPreparationInProgress = true;
    updatePdfActionState();
    try {
      const snapshot = buildUnitSnapshot();
      sheetPackage = { preparedAt: new Date().toISOString(), snapshot };
      if (!currentSubmissionId) currentSubmissionId = makeSheetSubmissionId();
      showToast(`Unit record ready: ${snapshot.totals.questionCount} questions included.`);
    } catch (error) {
      sheetPackage = null;
      currentSubmissionId = null;
      console.error("Google Sheets unit snapshot preparation failed:", error);
      showToast(error.message || "The unit record could not be prepared.", false);
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
    heading.textContent = status?.state === "duplicate" ? "✓ Already received" : "✓ Unit record confirmed";
    const details = document.createElement("span");
    details.textContent = `${finalData.studentName} · ${finalData.unitStandard} · ${finalData.teacherName}`;
    const destination = document.createElement("span");
    destination.textContent = status?.tabName
      ? `All unit questions and evidence links are in ${status.tabName}.`
      : "The complete unit record is in the teacher Google Sheet.";
    const reference = document.createElement("small");
    reference.textContent = `Reference: ${currentSubmissionId}`;
    receipt.append(heading, details, destination, reference);
    receipt.classList.remove("hidden");

    if (statusEl) {
      statusEl.textContent = "Your complete unit record has been updated in Google Sheets.";
      statusEl.className = "submission-card__status success";
    }
  }

  async function submitUnitSheetToTeacher() {
    if (submissionInProgress || lastConfirmedSubmission) return;
    if (!canExportCurrentResult()) return showToast("This result is not ready for teacher submission.", false);
    if (!sheetPackage) {
      await preparePdfForExport();
      if (!sheetPackage) return;
    }

    const endpoint = getSheetEndpoint();
    if (!endpoint) return showToast("Google Sheets submission has not been configured yet.", false);
    if (!getSheetRootName()) return showToast("Sheet storage has not been configured yet.", false);
    if (!navigator.onLine) return showToast("No internet connection. Reconnect and try again.", false);

    if (!currentSubmissionId) currentSubmissionId = makeSheetSubmissionId();
    const submissionId = currentSubmissionId;
    const assessment = currentAssessment();
    const submittedAt = new Date().toISOString();
    const override = {
      assessmentId: finalData.assessmentId,
      assessmentTitle: finalData.assessmentTitle,
      score: finalData.points,
      totalMarks: finalData.totalPoints,
      percentage: finalData.pct,
      submittedAt,
    };

    submissionInProgress = true;
    updatePdfActionState();
    const statusEl = document.getElementById("submissionStatus");
    if (statusEl) {
      statusEl.textContent = "Updating the complete unit record in Google Sheets…";
      statusEl.className = "submission-card__status";
    }

    try {
      await checkSheetGateway();
      const status = await postUnitSnapshot({
        submissionId,
        trigger: "assessment",
        triggerAssessment: assessment,
        override,
        showStatus: true,
      });

      lastConfirmedSubmission = status;
      const helper = window.QuizMasterFlexible;
      helper?.recordSubmission?.({
        submissionId,
        kind: "assessment",
        questionSetId: CURRENT_QUESTION_SET?.id || "",
        assessmentId: finalData.assessmentId,
        assessmentTitle: finalData.assessmentTitle,
        descriptor: status?.tabName ? `Google Sheet: ${status.tabName}` : "Google Sheet unit snapshot",
        method: "unit-sheet",
        state: status.state,
        rootName: getSheetRootName(),
        repeatable: false,
        startedAt: submittedAt,
        confirmedAt: new Date().toISOString(),
        answerSignature: helper?.assessmentAnswerSignature?.(finalData.assessmentId) || "",
        lastError: "",
      });

      // Refresh the prepared snapshot so status counts now include this confirmed section.
      sheetPackage = { preparedAt: new Date().toISOString(), snapshot: buildUnitSnapshot() };
      renderSheetReceipt(status);
      showToast(status.state === "duplicate" ? "Already received — unit record unchanged." : "Complete unit record updated in Google Sheets.");
    } catch (error) {
      console.error("Google Sheets unit submission failed:", error);
      if (statusEl) {
        statusEl.textContent = error.message || "Submission failed. Your work is still safe on this device.";
        statusEl.className = "submission-card__status error";
      }
      showToast("Submission was not confirmed. Your work is still safe here.", false);
    } finally {
      submissionInProgress = false;
      updatePdfActionState();
    }
  }

  async function syncAfterPhotoEvidence(record) {
    if (!isSheetMode() || !record?.submissionId || !confirmedState(record?.state || "confirmed")) return;
    if (!getSheetEndpoint() || !getSheetRootName() || !navigator.onLine) return;

    const assessment = (ASSESSMENTS || []).find((item) => String(item?.id || "") === String(record.assessmentId || "")) || null;
    const submissionId = `unit_${String(record.submissionId).slice(0, 145)}`;
    const override = {
      assessmentId: String(record.assessmentId || ""),
      assessmentTitle: String(assessment?.title || "Photo Evidence"),
      score: 0,
      totalMarks: 0,
      percentage: 0,
      submittedAt: String(record.submittedAt || new Date().toISOString()),
    };

    try {
      await postUnitSnapshot({
        submissionId,
        trigger: "photoEvidence",
        triggerAssessment: assessment,
        override,
      });
      console.info("Google Sheets unit record updated after photo evidence.");
    } catch (error) {
      console.warn("Google Sheets photo-evidence sync failed; the next assessment submission will retry the complete unit snapshot.", error);
    }
  }

  function wrapEvidenceRecorder() {
    const helper = window.QuizMasterFlexible;
    if (!helper || helper.__unitSheetV13Wrapped || typeof helper.recordEvidence !== "function") return;

    const wrapped = {
      ...helper,
      __unitSheetV13Wrapped: true,
      recordEvidence(record) {
        if (record?.submissionId) capturePhotoEvidenceDetails(record);
        const saved = helper.recordEvidence(record);
        if (saved && isSheetMode()) {
          window.clearTimeout(photoSyncTimer);
          photoSyncTimer = window.setTimeout(() => syncAfterPhotoEvidence(saved), 50);
        }
        return saved;
      },
    };
    window.QuizMasterFlexible = Object.freeze(wrapped);
  }

  submitWork = function unitSheetSubmitWork(...args) {
    const result = originalSubmitWork.apply(this, args);
    if (isSheetMode() && finalData && canExportCurrentResult()) {
      showToast("Great job! Preparing the complete unit record…", true);
    }
    return result;
  };

  submitToTeacher = function unitSheetSubmitToTeacher(...args) {
    if (!isSheetMode()) return originalSubmitToTeacher.apply(this, args);
    return submitUnitSheetToTeacher();
  };

  window.submitWork = submitWork;
  window.submitToTeacher = submitToTeacher;

  window.PHS_SheetSubmissionPrototype = Object.freeze({
    version: PLUGIN_VERSION,
    isSheetMode,
    getSheetEndpoint,
    getSheetRootName,
    checkGateway: checkSheetGateway,
    buildUnitSnapshot,
    questionsForAssessment,
    evidenceRecords,
    capturePhotoEvidenceDetails,
    syncUnitSnapshot: async () => postUnitSnapshot({
      submissionId: makeSheetSubmissionId("manual_sync"),
      trigger: "manual",
      triggerAssessment: currentAssessment(),
      override: null,
    }),
  });

  document.addEventListener("DOMContentLoaded", () => {
    wrapEvidenceRecorder();
    window.setTimeout(() => updatePdfActionState(), 0);
    if (isSheetMode()) {
      window.setTimeout(async () => {
        try {
          const health = await checkSheetGateway();
          console.info("Google Sheets unit gateway ready:", health);
        } catch (error) {
          console.warn("Google Sheets unit gateway check failed:", error);
        }
      }, 500);
    }
  });
})();
