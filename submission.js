/*
 * PHS Assessment & Evidence - Assessment Records submission module v2
 *
 * Sheet mode now submits a COMPLETE UNIT SNAPSHOT:
 *   - every defined question in every assessment section
 *   - blank answers as blank cells
 *   - current saved answers from any section
 *   - assessment progress/result metadata
 *   - photo-evidence definitions and submitted evidence links
 *
 * Photo evidence is uploaded as a stamped JPG through the same gateway and the
 * direct Drive file link is written into the same student unit record.
 *
 * Load AFTER flexible-groups.js and BEFORE photo-evidence.js.
 */
(() => {
  "use strict";

  const PLUGIN_VERSION = "2.0.0";

  const originalClearPreparedPdf = clearPreparedPdf;
  const originalUpdatePdfActionState = updatePdfActionState;
  const originalPreparePdfForExport = preparePdfForExport;
  const originalSubmitWork = window.submitWork || submitWork;
  const originalSubmitToTeacher = window.submitToTeacher || submitToTeacher;

  let sheetPackage = null;

  function isSheetMode() {
    return (["sheet", "unit-sheet"].includes(String(SUBMISSION_SETTINGS?.submission?.mode || "files").trim().toLowerCase()));
  }

  function getSheetEndpoint() {
    const url = String(SUBMISSION_SETTINGS?.gateway?.url || "").trim();
    if (!url) return "";
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#].*)?$/.test(url)) return "";
    return url;
  }

  function getSheetRootName() {
    return String(
      SUBMISSION_SETTINGS?.storage?.rootName ||
      ""
    )
      .trim()
      .replace(/\s+-\s+\d{4}\s*$/, "")
      .replace(/\s+/g, " ");
  }

  async function checkSheetGateway() {
    const endpoint = getSheetEndpoint();
    if (!endpoint) throw new Error("gateway.url is missing or invalid in submission-settings.json.");
    const health = await jsonpRequest(endpoint, { action: "health" }, 7000);
    if (!health || health.state !== "ready" || health.mode !== "assessment-records") {
      throw new Error(health?.message || "The assessment-records gateway did not return the expected ready response.");
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

  function storeEvidenceDetails(record) {
    if (!record?.submissionId) return null;
    const detail = {
      assessmentId: String(record.assessmentId || ""),
      optionId: String(record.optionId || ""),
      optionLabel: String(record.optionLabel || ""),
      descriptor: String(record.descriptor || ""),
      fieldValues: { ...(record.fieldValues || {}) },
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
    // A first complete-unit save can need longer than a small per-assessment save
    // because the gateway may be creating 50+ sheet columns on first use.
    // Keep cheap cache checks running long enough for that first save to finish.
    const delays = [200, 400, 700, 1000, 1500, 2200, 3000, 4000, 5000, 6000];
    let last = null;

    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const status = await jsonpRequest(
          endpoint,
          { action: "status", submissionId, fast: "1", rootName },
          5500
        );
        last = status || last;

        if (status?.state === "confirmed" || status?.state === "duplicate") return status;

        // Do not hide a real server-side validation/write error behind a generic
        // "not confirmed" message. Surface it immediately.
        if (status?.state === "error") {
          throw new Error(status.message || "teacher submission failed.");
        }
      } catch (error) {
        // Network/JSONP failures are transient and can be retried. A real gateway
        // error is intentionally re-thrown above and should be shown to the user.
        if (error?.message && !/timed out|reach|load|network|connection/i.test(error.message)) {
          throw error;
        }
      }
    }

    // If the cache confirmation was missed, search the durable _Submission Log.
    // Repeat this a few times because Google Sheets writes can finish just after
    // the fast-poll window on the first submission for a new standard.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2500));

      const recovered = await jsonpRequest(
        endpoint,
        { action: "status", submissionId, fast: "0", rootName },
        9000
      );

      last = recovered || last;
      if (recovered?.state === "confirmed" || recovered?.state === "duplicate") return recovered;
      if (recovered?.state === "error") {
        throw new Error(recovered.message || "teacher submission failed.");
      }
    }

    return last;
  }

  async function postUnitSnapshot({ submissionId, trigger, triggerAssessment, override, unitSnapshot = null }) {
    const endpoint = getSheetEndpoint();
    const storageRootName = getSheetRootName();
    if (!endpoint || !storageRootName || !navigator.onLine) throw new Error("teacher submission is not available.");

    const identity = identitySnapshot();
    if (!identity.studentName) throw new Error("Student name is required.");
    if (!/^\d{3,6}$/.test(identity.studentId)) throw new Error("A valid Student ID is required.");
    if (!identity.teacherId) throw new Error("Teacher is required.");

    unitSnapshot = unitSnapshot || buildUnitSnapshot(override);
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
      throw new Error("The unit record was sent but is still waiting for confirmation. Wait a few seconds, then press Submit to Teacher again. The same submission reference will be reused safely.");
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
        submissionStatus.textContent = "Teacher submission is not configured yet. Add gateway.url to submission-settings.json.";
        submissionStatus.className = "submission-card__status warning";
      } else if (!rootNameReady) {
        submissionStatus.textContent = "Assessment storage is not configured. Add storage.rootName to submission-settings.json.";
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
      console.error("Assessment-record preparation failed:", error);
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
    if (!endpoint) return showToast("Teacher submission has not been configured yet.", false);
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
      console.error("Assessment-record submission failed:", error);
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



  function blobToBase64(blob) {
    return blob.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer)));
  }

  async function submitPhotoEvidence({ assessment, option, method, fieldValues, descriptor, blob, capturedAt }) {
    if (!isSheetMode()) throw new Error("Photo evidence requires sheet submission mode.");
    const endpoint = getSheetEndpoint();
    const storageRootName = getSheetRootName();
    if (!endpoint || !storageRootName) throw new Error("Teacher submission is not configured.");
    if (!navigator.onLine) throw new Error("No internet connection. Reconnect and try again.");

    const identity = identitySnapshot();
    if (!identity.studentName) throw new Error("Enter your name first.");
    if (!/^\d{3,6}$/.test(identity.studentId)) throw new Error("Enter a valid Student ID first.");
    if (!identity.teacherId) throw new Error("Select your teacher first.");

    const submissionId = makeSheetSubmissionId("photo");
    const assessmentId = String(assessment?.id || "photo-evidence");
    const assessmentTitle = String(assessment?.title || "Photo Evidence");
    const optionId = String(option?.id || "evidence");
    const optionLabel = String(option?.label || "Evidence");
    const submittedAt = String(capturedAt || new Date().toISOString());
    const cleanFields = { ...(fieldValues || {}) };

    const evidenceRecord = {
      assessmentId,
      optionId,
      optionLabel,
      descriptor: String(descriptor || optionLabel),
      method: String(method || "photo"),
      submissionId,
      submittedAt,
      state: "pending",
      photoUrl: "",
      pdfUrl: "",
      repeatable: option?.repeatable !== false,
      fieldValues: cleanFields,
    };

    const unitSnapshot = buildUnitSnapshot({
      assessmentId,
      assessmentTitle,
      score: 0,
      totalMarks: 0,
      percentage: 0,
      submittedAt,
      status: "Evidence submitted",
    });
    unitSnapshot.evidence = (unitSnapshot.evidence || []).filter((item) => item.submissionId !== submissionId);
    unitSnapshot.evidence.push(evidenceRecord);
    unitSnapshot.totals = unitSnapshot.totals || {};
    unitSnapshot.totals.evidenceCount = unitSnapshot.evidence.length;

    const assessmentSummary = (unitSnapshot.assessments || []).find((item) => item.assessmentId === assessmentId);
    if (assessmentSummary) {
      assessmentSummary.status = "Evidence submitted";
      assessmentSummary.evidenceCount = Number(assessmentSummary.evidenceCount || 0) + 1;
      assessmentSummary.lastSubmitted = submittedAt;
    }

    let imageBase64 = "";
    let imageMimeType = "";
    if (method !== "written") {
      if (!blob) throw new Error("Take or choose a photo first.");
      imageBase64 = await blobToBase64(blob);
      imageMimeType = String(blob.type || "image/jpeg");
    }

    await checkSheetGateway();
    const payload = {
      submissionMode: "photo-evidence",
      submissionId,
      trigger: "photoEvidence",
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
      assessmentId,
      assessmentTitle,
      submittedAt,
      evidence: {
        assessmentId,
        assessmentTitle,
        optionId,
        optionLabel,
        descriptor: evidenceRecord.descriptor,
        method: evidenceRecord.method,
        repeatable: evidenceRecord.repeatable,
        fieldValues: cleanFields,
        capturedAt: submittedAt,
        imageMimeType,
        imageBase64,
      },
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
      throw new Error("The evidence was sent but confirmation is still pending. Wait a few seconds and try again.");
    }

    const finalRecord = {
      ...evidenceRecord,
      state: status.state,
      submittedAt: new Date().toISOString(),
      photoUrl: String(status.photoUrl || ""),
    };
    storeEvidenceDetails(finalRecord);

    try {
      window.QuizMasterFlexible?.recordSubmission?.({
        submissionId,
        kind: "photoEvidence",
        questionSetId: CURRENT_QUESTION_SET?.id || "",
        assessmentId,
        assessmentTitle,
        optionId,
        optionLabel,
        descriptor: finalRecord.descriptor,
        method: finalRecord.method,
        state: status.state,
        rootName: storageRootName,
        repeatable: finalRecord.repeatable,
        startedAt: submittedAt,
        confirmedAt: new Date().toISOString(),
        photoUrl: finalRecord.photoUrl,
        lastError: "",
      });
      window.QuizMasterFlexible?.recordEvidence?.(finalRecord);
    } catch (trackingError) {
      console.warn("Evidence tracking could not be updated:", trackingError);
    }

    sheetPackage = { preparedAt: new Date().toISOString(), snapshot: buildUnitSnapshot() };
    return status;
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

  window.PHSSubmission = Object.freeze({
    version: PLUGIN_VERSION,
    mode: "assessment-records",
    isSheetMode,
    getSheetEndpoint,
    getSheetRootName,
    checkGateway: checkSheetGateway,
    buildUnitSnapshot,
    questionsForAssessment,
    evidenceRecords,
    submitPhotoEvidence,
    syncUnitSnapshot: async () => postUnitSnapshot({
      submissionId: makeSheetSubmissionId("manual_sync"),
      trigger: "manual",
      triggerAssessment: currentAssessment(),
      override: null,
    }),
  });

  document.addEventListener("DOMContentLoaded", () => {
    window.setTimeout(() => updatePdfActionState(), 0);
    if (isSheetMode()) {
      window.setTimeout(async () => {
        try {
          const health = await checkSheetGateway();
          console.info(`Assessment-records gateway ready (browser plugin ${PLUGIN_VERSION}):`, health);
        } catch (error) {
          console.warn("assessment-records gateway check failed:", error);
        }
      }, 500);
    }
  });
})();
