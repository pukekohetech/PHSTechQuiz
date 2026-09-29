/*
 * QuizMaster Flexible Groups plugin v5
 * Generic schema-v3 repeatable groups, conditional questions, evidence tracking, and persistent submission-state tracking for any standard.
 *
 * Load after script.js and BEFORE photo-evidence.js:
 *   <script src="flexible-groups.js?v=5" defer></script>
 *
 * Existing schema-v2 standards continue to work unchanged.
 */
(() => {
  "use strict";

  const FLEX_SCHEMA_MIN = 3;
  const PLUGIN_VERSION = 5;
  const originalLoadAssessment = window.loadAssessment;
  const originalSubmitToTeacher = window.submitToTeacher;

  if (typeof originalLoadAssessment !== "function") {
    console.warn("Flexible Groups: QuizMaster loadAssessment() was not available.");
    return;
  }

  function injectStyles() {
    if (document.getElementById("flexibleGroupsStyles")) return;
    const style = document.createElement("style");
    style.id = "flexibleGroupsStyles";
    style.textContent = `
      .flex-repeat-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0 22px;padding:12px 14px;border:1px dashed #cbd5e1;border-radius:14px;background:#f8fafc}
      .flex-repeat-controls__count{margin-right:auto;color:#475569;font-weight:700}
      .flex-repeat-controls button{min-height:42px;padding:9px 14px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#111827;font:inherit;font-weight:750;cursor:pointer}
      .flex-repeat-controls button.flex-repeat-add{background:#7a1f2b;border-color:#7a1f2b;color:#fff}
      .flex-repeat-controls button:disabled{opacity:.45;cursor:not-allowed}
      .flex-conditional-status{margin:10px 0 2px;padding:10px 12px;border:1px solid #d8e5dc;border-radius:10px;background:#f3faf5;color:#315b3b;font-size:.94rem;line-height:1.4}
      .qm-evidence-tracker{margin:14px 0 18px;border:1px solid #d8dee8;border-radius:16px;background:#fff;box-shadow:0 5px 18px rgba(15,23,42,.05);overflow:hidden}
      .qm-evidence-tracker summary{display:flex;align-items:center;gap:12px;cursor:pointer;padding:14px 16px;list-style:none;background:#f8fafc}
      .qm-evidence-tracker summary::-webkit-details-marker{display:none}
      .qm-evidence-tracker__summary-text{min-width:0;flex:1}
      .qm-evidence-tracker__kicker{font-size:.78rem;letter-spacing:.05em;text-transform:uppercase;color:#64748b;font-weight:800}
      .qm-evidence-tracker__title{margin:2px 0 0;font-size:1.05rem;color:#111827}
      .qm-evidence-tracker__score{font-size:.9rem;font-weight:800;color:#475569;white-space:nowrap}
      .qm-evidence-tracker__body{padding:14px 16px 16px}
      .qm-evidence-tracker__intro{margin:0 0 12px;color:#475569;line-height:1.45}
      .qm-evidence-tracker__bar{height:8px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:0 0 14px}
      .qm-evidence-tracker__bar span{display:block;height:100%;background:#7a1f2b;width:0;transition:width .2s ease}
      .qm-evidence-tracker__list{display:grid;gap:8px}
      .qm-evidence-tracker__item{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 11px;border:1px solid #e2e8f0;border-radius:12px;background:#fff}
      .qm-evidence-tracker__item.is-ready{border-color:#b9cfe7;background:#f6faff}
      .qm-evidence-tracker__item.is-submitted{border-color:#bbd8c4;background:#f7fbf8}
      .qm-evidence-tracker__item.is-ongoing{border-color:#ead6a5;background:#fffaf0}
      .qm-evidence-tracker__item.is-pending{border-color:#d9c68f;background:#fffdf4}
      .qm-evidence-tracker__icon{display:grid;place-items:center;width:26px;height:26px;border-radius:999px;background:#eef2f7;color:#64748b;font-weight:900}
      .qm-evidence-tracker__item.is-ready .qm-evidence-tracker__icon{background:#e7f0fa;color:#285f91}
      .qm-evidence-tracker__item.is-submitted .qm-evidence-tracker__icon{background:#e5f3e9;color:#27633a}
      .qm-evidence-tracker__item.is-ongoing .qm-evidence-tracker__icon{background:#fff0c9;color:#855f00}
      .qm-evidence-tracker__item.is-pending .qm-evidence-tracker__icon{background:#fff4cc;color:#7a5b00}
      .qm-evidence-tracker__item strong{display:block;color:#111827}
      .qm-evidence-tracker__item small{display:block;margin-top:2px;color:#64748b;line-height:1.35}
      .qm-evidence-tracker__status{display:inline-block;margin-top:5px;padding:3px 7px;border-radius:999px;background:#eef2f7;color:#596273;font-size:.72rem;font-weight:850;letter-spacing:.02em}
      .qm-evidence-tracker__status.is-ready{background:#e7f0fa;color:#285f91}
      .qm-evidence-tracker__status.is-submitted{background:#e5f3e9;color:#27633a}
      .qm-evidence-tracker__status.is-ongoing{background:#fff0c9;color:#855f00}
      .qm-evidence-tracker__status.is-pending{background:#fff4cc;color:#7a5b00}
      .qm-evidence-tracker__legend{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 14px}
      .qm-evidence-tracker__legend span{padding:5px 8px;border-radius:999px;font-size:.75rem;font-weight:800}
      .qm-evidence-tracker__legend .is-ready{background:#e7f0fa;color:#285f91}
      .qm-evidence-tracker__legend .is-submitted{background:#e5f3e9;color:#27633a}
      .qm-evidence-tracker__legend .is-ongoing{background:#fff0c9;color:#855f00}
      .qm-evidence-tracker__legend .is-pending{background:#fff4cc;color:#7a5b00}
      .qm-evidence-tracker__legend .is-incomplete{background:#eef2f7;color:#596273}
      .qm-evidence-tracker__open{min-height:36px;padding:7px 11px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#111827;font:inherit;font-weight:750;cursor:pointer}
      .qm-evidence-tracker__foot{margin:12px 0 0;color:#64748b;font-size:.84rem;line-height:1.4}
      @media (max-width:640px){.flex-repeat-controls__count{width:100%;margin-right:0}.flex-repeat-controls button{flex:1 1 auto}.qm-evidence-tracker__item{grid-template-columns:28px minmax(0,1fr)}.qm-evidence-tracker__open{grid-column:2;justify-self:start}.qm-evidence-tracker__score{white-space:normal;text-align:right;max-width:44%}}
    `;
    document.head.appendChild(style);
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

  function cloneRubric(rubric) {
    return (rubric || []).map((rule) => {
      const cloned = { ...rule };
      if (rule?.check instanceof RegExp) {
        cloned.check = new RegExp(rule.check.source, rule.check.flags);
      } else if (typeof rule?.check === "string") {
        cloned.check = new RegExp(rule.check, rule.flags || "i");
      }
      return cloned;
    });
  }

  function cloneQuestion(question, overrides = {}) {
    return {
      ...question,
      ...overrides,
      rubric: cloneRubric(question?.rubric),
      options: Array.isArray(question?.options) ? [...question.options] : question?.options,
    };
  }

  function ensureRepeatState() {
    if (!data.repeatCounts || typeof data.repeatCounts !== "object") data.repeatCounts = {};
  }

  function repeatBucket(assessmentId) {
    ensureRepeatState();
    if (!data.repeatCounts[assessmentId] || typeof data.repeatCounts[assessmentId] !== "object") {
      data.repeatCounts[assessmentId] = {};
    }
    return data.repeatCounts[assessmentId];
  }

  function blockLimits(block) {
    const startWith = Math.max(1, Number(block?.startWith ?? block?.minimum ?? 1) || 1);
    const minimum = Math.max(0, Number(block?.minimum ?? startWith) || 0);
    const rawMax = block?.maximum;
    const maximum = rawMax == null || rawMax === "" ? Infinity : Math.max(minimum, Number(rawMax) || minimum);
    return { startWith: Math.min(Math.max(startWith, minimum), maximum), minimum, maximum };
  }

  function getRepeatCount(assessment, block) {
    const { startWith, minimum, maximum } = blockLimits(block);
    const bucket = repeatBucket(assessment.id);
    const saved = Number(bucket[block.id]);
    const value = Number.isInteger(saved) ? saved : startWith;
    return Math.min(Math.max(value, minimum), maximum);
  }

  function setRepeatCount(assessment, block, count) {
    const { minimum, maximum } = blockLimits(block);
    const next = Math.min(Math.max(Number(count) || minimum, minimum), maximum);
    repeatBucket(assessment.id)[block.id] = next;
    data.lastSaved = new Date().toISOString();
    if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
    return next;
  }

  function groupDefinition(block, vars, fallbackId) {
    const source = block.group || {};
    return {
      id: fallbackId,
      label: fillTemplate(source.label || block.label || "", vars),
      title: fillTemplate(source.title || block.title || "", vars),
      intro: fillTemplate(source.intro || block.intro || "", vars),
      reminder: fillTemplate(source.reminder || block.reminder || "", vars),
    };
  }

  function storedAnswer(assessmentId, questionId) {
    try {
      if (currentAssessmentId === assessmentId) {
        const liveField = document.getElementById("q" + questionId);
        if (liveField) return String(liveField.value || "").trim();
      }
      const encoded = data.answers?.[assessmentId]?.[questionId];
      return encoded ? String(xorDecode(encoded) || "").trim() : "";
    } catch (_) {
      return "";
    }
  }

  function conditionMatches(showWhen, value) {
    const answer = String(value ?? "").trim();
    const condition = showWhen && typeof showWhen === "object" ? showWhen : {};

    if (Object.prototype.hasOwnProperty.call(condition, "value")) {
      return answer.toLowerCase() === String(condition.value ?? "").trim().toLowerCase();
    }

    if (Array.isArray(condition.values)) {
      const lowered = answer.toLowerCase();
      return condition.values.some((item) => lowered === String(item ?? "").trim().toLowerCase());
    }

    if (Object.prototype.hasOwnProperty.call(condition, "notValue")) {
      return answer.toLowerCase() !== String(condition.notValue ?? "").trim().toLowerCase();
    }

    if (condition.pattern) {
      try {
        return new RegExp(String(condition.pattern), String(condition.flags || "i")).test(answer);
      } catch (error) {
        console.warn("Flexible Groups: invalid conditional pattern", condition.pattern, error);
        return false;
      }
    }

    return !!answer;
  }

  function materialiseFlexibleAssessment(assessment) {
    if (!Array.isArray(assessment?.blocks)) return false;

    const groups = [];
    const questions = [];
    const repeatMeta = [];
    const conditionalMeta = [];

    assessment.blocks.forEach((block, blockIndex) => {
      const type = String(block?.type || "group").trim();
      const blockId = safeId(block?.id || `block-${blockIndex + 1}`, `block-${blockIndex + 1}`);

      if (type === "group") {
        const groupId = blockId;
        const vars = { n: 1, count: 1, min: 1, max: 1 };
        groups.push(groupDefinition(block, vars, groupId));
        (block.questions || []).forEach((q, qIndex) => {
          const qid = safeId(q?.id || `q${qIndex + 1}`, `q${qIndex + 1}`);
          questions.push(cloneQuestion(q, {
            id: qid,
            group: groupId,
            text: fillTemplate(q?.text || "", vars),
            hint: fillTemplate(q?.hint || "", vars),
          }));
        });
        return;
      }

      if (type === "questions") {
        (block.questions || []).forEach((q, qIndex) => {
          const qid = safeId(q?.id || `${blockId}-q${qIndex + 1}`, `${blockId}-q${qIndex + 1}`);
          questions.push(cloneQuestion(q, { id: qid, group: "" }));
        });
        return;
      }

      if (type === "conditional") {
        const groupId = blockId;
        const vars = { n: 1, count: 1, min: 1, max: 1 };
        groups.push(groupDefinition(block, vars, groupId));

        const controllerSource = block.question || {};
        const controllerId = safeId(controllerSource.id || `${blockId}-choice`, `${blockId}-choice`);
        questions.push(cloneQuestion(controllerSource, {
          id: controllerId,
          group: groupId,
          text: fillTemplate(controllerSource.text || "", vars),
          hint: fillTemplate(controllerSource.hint || "", vars),
        }));

        const answer = storedAnswer(assessment.id, controllerId);
        const visible = conditionMatches(block.showWhen, answer);
        const followupIds = [];

        if (visible) {
          (block.questions || []).forEach((q, qIndex) => {
            const qid = safeId(q?.id || `${blockId}-q${qIndex + 1}`, `${blockId}-q${qIndex + 1}`);
            followupIds.push(qid);
            questions.push(cloneQuestion(q, {
              id: qid,
              group: groupId,
              text: fillTemplate(q?.text || "", vars),
              hint: fillTemplate(q?.hint || "", vars),
            }));
          });
        } else {
          (block.questions || []).forEach((q, qIndex) => {
            followupIds.push(safeId(q?.id || `${blockId}-q${qIndex + 1}`, `${blockId}-q${qIndex + 1}`));
          });
        }

        conditionalMeta.push({ block, blockId, groupId, controllerId, visible, followupIds });
        return;
      }

      if (type !== "repeatGroup") {
        console.warn(`Flexible Groups: unsupported block type "${type}" in ${assessment.id}.`);
        return;
      }

      const count = getRepeatCount(assessment, block);
      const { minimum, maximum } = blockLimits(block);
      const instanceGroupIds = [];

      for (let n = 1; n <= count; n += 1) {
        const groupId = `${blockId}-${n}`;
        const vars = { n, count, min: minimum, max: maximum };
        groups.push(groupDefinition(block, vars, groupId));
        instanceGroupIds.push(groupId);

        (block.questions || []).forEach((q, qIndex) => {
          const localId = safeId(q?.id || `q${qIndex + 1}`, `q${qIndex + 1}`);
          const questionId = `${blockId}_${n}_${localId}`;
          questions.push(cloneQuestion(q, {
            id: questionId,
            group: groupId,
            text: fillTemplate(q?.text || "", vars),
            hint: fillTemplate(q?.hint || "", vars),
          }));
        });
      }

      repeatMeta.push({ block, blockId, count, minimum, maximum, instanceGroupIds });
    });

    assessment.questionGroups = groups;
    assessment.questions = questions;
    assessment.__flexRepeatMeta = repeatMeta;
    assessment.__flexConditionalMeta = conditionalMeta;
    assessment.__flexMaterialised = true;
    return true;
  }

  function findGroupSection(groupId) {
    return Array.from(document.querySelectorAll("#questions .question-group"))
      .find((section) => section.dataset.groupId === groupId) || null;
  }

  function deleteInstanceAnswers(assessment, blockId, instanceNumber) {
    const bucket = data.answers?.[assessment.id];
    if (!bucket || typeof bucket !== "object") return;
    const prefix = `${blockId}_${instanceNumber}_`;
    Object.keys(bucket).forEach((qid) => {
      if (qid.startsWith(prefix)) delete bucket[qid];
    });
  }

  function deleteConditionalAnswers(assessment, followupIds) {
    const bucket = data.answers?.[assessment.id];
    if (!bucket || typeof bucket !== "object") return;
    (followupIds || []).forEach((qid) => delete bucket[qid]);
  }

  function applyQuestionUiPreferences(assessment) {
    (assessment?.questions || []).forEach((question) => {
      if (question?.type !== "mc" || question?.shuffleOptions !== false) return;
      const field = document.getElementById("q" + question.id);
      if (!(field instanceof HTMLSelectElement)) return;
      const current = field.value;
      field.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Select an answer";
      field.appendChild(blank);
      (question.options || []).forEach((option) => {
        const el = document.createElement("option");
        el.value = option;
        el.textContent = option;
        field.appendChild(el);
      });
      field.value = current;
    });
  }

  function renderRepeatControls(assessment) {
    if (!assessment?.__flexMaterialised) return;
    injectStyles();
    document.querySelectorAll(".flex-repeat-controls").forEach((el) => el.remove());

    (assessment.__flexRepeatMeta || []).forEach((meta) => {
      const { block, blockId, count, minimum, maximum, instanceGroupIds } = meta;
      const lastGroupId = instanceGroupIds[instanceGroupIds.length - 1];
      const lastSection = findGroupSection(lastGroupId);
      if (!lastSection) return;

      const controls = document.createElement("div");
      controls.className = "flex-repeat-controls";
      controls.dataset.repeatBlockId = blockId;

      const countText = document.createElement("span");
      countText.className = "flex-repeat-controls__count";
      const noun = String(block.itemLabel || "record").trim() || "record";
      countText.textContent = `${count} ${noun}${count === 1 ? "" : "s"} currently shown`;
      controls.appendChild(countText);

      const allowRemove = block.allowRemove !== false;
      if (allowRemove) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "flex-repeat-remove";
        removeBtn.textContent = block.removeLabel || `Remove last ${noun}`;
        removeBtn.disabled = count <= minimum;
        removeBtn.addEventListener("click", () => {
          if (count <= minimum) return;
          try { persistCurrentAssessmentAnswers(); } catch (_) {}
          deleteInstanceAnswers(assessment, blockId, count);
          setRepeatCount(assessment, block, count - 1);
          if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
          rerenderAssessment(assessment);
          showToast(`Removed the last ${noun}.`);
        });
        controls.appendChild(removeBtn);
      }

      if (block.allowAdd !== false) {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "flex-repeat-add";
        addBtn.textContent = block.addLabel || `+ Add another ${noun}`;
        addBtn.disabled = Number.isFinite(maximum) && count >= maximum;
        addBtn.addEventListener("click", () => {
          if (Number.isFinite(maximum) && count >= maximum) return;
          try { persistCurrentAssessmentAnswers(); } catch (_) {}
          setRepeatCount(assessment, block, count + 1);
          rerenderAssessment(assessment, { focusGroupId: `${blockId}-${count + 1}` });
          showToast(`Added another ${noun}.`);
        });
        controls.appendChild(addBtn);
      }

      lastSection.insertAdjacentElement("afterend", controls);
    });
  }

  function renderConditionalControls(assessment) {
    if (!assessment?.__flexMaterialised) return;
    injectStyles();
    document.querySelectorAll(".flex-conditional-status").forEach((el) => el.remove());

    (assessment.__flexConditionalMeta || []).forEach((meta) => {
      const { block, groupId, controllerId, visible, followupIds } = meta;
      const field = document.getElementById("q" + controllerId);
      const section = findGroupSection(groupId);
      if (!field || !section) return;

      const answer = String(field.value || "").trim();
      if (answer && !visible) {
        const note = document.createElement("div");
        note.className = "flex-conditional-status";
        note.textContent = String(block.closedMessage || "No additional questions are needed for this choice.");
        const body = section.querySelector(".question-group__body") || section;
        body.appendChild(note);
      }

      field.addEventListener("change", () => {
        try { saveAnswer(controllerId); } catch (_) {}
        try { persistCurrentAssessmentAnswers(); } catch (_) {}

        const nextVisible = conditionMatches(block.showWhen, field.value);
        if (nextVisible === visible) return;

        if (!nextVisible && block.clearWhenHidden === true) {
          deleteConditionalAnswers(assessment, followupIds);
          data.lastSaved = new Date().toISOString();
          if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
        }

        rerenderAssessment(assessment, { focusGroupId: groupId });
      });
    });
  }

  function renderFlexibleEnhancements(assessment) {
    applyQuestionUiPreferences(assessment);
    renderRepeatControls(assessment);
    renderConditionalControls(assessment);
  }

  function rerenderAssessment(assessment, options = {}) {
    try { persistCurrentAssessmentAnswers(); } catch (_) {}
    materialiseFlexibleAssessment(assessment);
    originalLoadAssessment();
    window.requestAnimationFrame(() => {
      renderFlexibleEnhancements(assessment);
      if (options.focusGroupId) {
        window.requestAnimationFrame(() => {
          findGroupSection(options.focusGroupId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    });
  }


  // ------------------------------------------------------------
  // Generic evidence tracker
  // ------------------------------------------------------------
  let evidenceTrackerTimer = 0;

  function ensureEvidenceRecords() {
    if (!Array.isArray(data.evidenceRecords)) data.evidenceRecords = [];
    return data.evidenceRecords;
  }

  function recordEvidence(record) {
    const records = ensureEvidenceRecords();
    const clean = {
      assessmentId: String(record?.assessmentId || "").trim(),
      optionId: String(record?.optionId || "").trim(),
      optionLabel: String(record?.optionLabel || "").trim(),
      descriptor: String(record?.descriptor || "").trim(),
      method: String(record?.method || "photo").trim(),
      submissionId: String(record?.submissionId || "").trim(),
      submittedAt: String(record?.submittedAt || new Date().toISOString()),
      state: String(record?.state || "confirmed").trim(),
      pdfUrl: String(record?.pdfUrl || "").trim(),
      repeatable: record?.repeatable !== false,
    };
    if (!clean.assessmentId || !clean.optionId) return null;

    const duplicateIndex = clean.submissionId
      ? records.findIndex((item) => item?.submissionId === clean.submissionId)
      : -1;
    if (duplicateIndex >= 0) records[duplicateIndex] = clean;
    else if (!clean.repeatable) {
      const existingIndex = records.findIndex((item) =>
        item?.assessmentId === clean.assessmentId && item?.optionId === clean.optionId
      );
      if (existingIndex >= 0) records[existingIndex] = clean;
      else records.push(clean);
    } else records.push(clean);

    data.lastSaved = new Date().toISOString();
    if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
    scheduleEvidenceTrackerRender();
    return clean;
  }

  function assessmentById(assessmentId) {
    return (ASSESSMENTS || []).find((assessment) => String(assessment?.id || "") === String(assessmentId || "")) || null;
  }

  function answerForTracker(assessmentId, questionId) {
    try {
      if (currentAssessmentId === assessmentId) {
        const field = document.getElementById("q" + questionId);
        if (field) return String(field.value || "").trim();
      }
      const encoded = data.answers?.[assessmentId]?.[questionId];
      return encoded ? String(xorDecode(encoded) || "").trim() : "";
    } catch (_) {
      return "";
    }
  }

  function ensureSubmissionRecords() {
    if (!Array.isArray(data.submissionRecords)) data.submissionRecords = [];
    return data.submissionRecords;
  }

  function submissionStateIsConfirmed(state) {
    return state === "confirmed" || state === "duplicate";
  }

  function simpleHash(value) {
    let hash = 2166136261;
    const input = String(value || "");
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function assessmentAnswerSignature(assessmentId) {
    const assessment = materialiseForTracker(assessmentById(assessmentId));
    if (!assessment) return "";
    const serialised = (assessment.questions || []).map((question) => {
      const id = String(question?.id || "");
      const answer = answerForTracker(assessment.id, id);
      return `${id}\u001f${answer}`;
    }).join("\u001e");
    return `v1:${simpleHash(serialised)}`;
  }

  function recordSubmission(record) {
    const records = ensureSubmissionRecords();
    const assessmentId = String(record?.assessmentId || "").trim();
    const submissionId = String(record?.submissionId || "").trim();
    if (!submissionId || !assessmentId) return null;

    const kind = String(record?.kind || "assessment").trim() || "assessment";
    const existingIndex = records.findIndex((item) => String(item?.submissionId || "") === submissionId);
    const previous = existingIndex >= 0 ? records[existingIndex] : {};
    const clean = {
      ...previous,
      submissionId,
      kind,
      questionSetId: String(record?.questionSetId ?? previous.questionSetId ?? CURRENT_QUESTION_SET?.id ?? "").trim(),
      assessmentId,
      assessmentTitle: String(record?.assessmentTitle ?? previous.assessmentTitle ?? "").trim(),
      optionId: String(record?.optionId ?? previous.optionId ?? "").trim(),
      optionLabel: String(record?.optionLabel ?? previous.optionLabel ?? "").trim(),
      descriptor: String(record?.descriptor ?? previous.descriptor ?? "").trim(),
      method: String(record?.method ?? previous.method ?? "").trim(),
      state: String(record?.state ?? previous.state ?? "pending").trim() || "pending",
      rootName: String(record?.rootName ?? previous.rootName ?? "").trim(),
      repeatable: record?.repeatable ?? previous.repeatable ?? true,
      startedAt: String(record?.startedAt ?? previous.startedAt ?? new Date().toISOString()),
      confirmedAt: String(record?.confirmedAt ?? previous.confirmedAt ?? ""),
      pdfUrl: String(record?.pdfUrl ?? previous.pdfUrl ?? "").trim(),
      answerSignature: String(
        record?.answerSignature ?? previous.answerSignature ?? (kind === "assessment" ? assessmentAnswerSignature(assessmentId) : "")
      ).trim(),
      lastError: String(record?.lastError ?? previous.lastError ?? "").trim(),
    };

    if (existingIndex >= 0) records[existingIndex] = clean;
    else records.push(clean);

    data.lastSaved = new Date().toISOString();
    if (STORAGE_KEY) storageSet(STORAGE_KEY, JSON.stringify(data));
    scheduleEvidenceTrackerRender();
    return clean;
  }

  function updateSubmissionState(submissionId, state, extra = {}) {
    const existing = ensureSubmissionRecords().find((item) => String(item?.submissionId || "") === String(submissionId || ""));
    if (!existing) return null;
    return recordSubmission({
      ...existing,
      ...extra,
      submissionId: existing.submissionId,
      assessmentId: existing.assessmentId,
      state: String(state || existing.state || "pending"),
    });
  }

  function latestAssessmentSubmission(assessmentId) {
    const signature = assessmentAnswerSignature(assessmentId);
    const matching = ensureSubmissionRecords()
      .filter((record) => record?.kind === "assessment" && String(record?.assessmentId || "") === String(assessmentId || ""))
      .sort((a, b) => Date.parse(b?.confirmedAt || b?.startedAt || 0) - Date.parse(a?.confirmedAt || a?.startedAt || 0));

    const exactConfirmed = matching.find((record) => submissionStateIsConfirmed(record?.state) && record?.answerSignature === signature);
    if (exactConfirmed) return { state: "submitted", record: exactConfirmed, changedSinceSubmission: false };

    const exactPending = matching.find((record) => record?.state === "pending" && record?.answerSignature === signature);
    if (exactPending) return { state: "pending", record: exactPending, changedSinceSubmission: false };

    const hasOlderConfirmed = matching.some((record) => submissionStateIsConfirmed(record?.state));
    return { state: "ready", record: null, changedSinceSubmission: hasOlderConfirmed };
  }

  let submissionReconcileBusy = false;
  const submissionReconcileLastAttempt = new Map();

  async function reconcilePendingSubmissions({ force = false } = {}) {
    if (submissionReconcileBusy || !navigator.onLine) return;
    let endpoint = "";
    try { endpoint = getSubmissionEndpoint(); } catch (_) {}
    if (!endpoint || typeof jsonpRequest !== "function") return;

    const pending = ensureSubmissionRecords().filter((record) => record?.state === "pending" && record?.submissionId);
    if (!pending.length) return;

    submissionReconcileBusy = true;
    try {
      for (const record of pending) {
        const now = Date.now();
        const lastAttempt = submissionReconcileLastAttempt.get(record.submissionId) || 0;
        if (!force && now - lastAttempt < 10000) continue;
        submissionReconcileLastAttempt.set(record.submissionId, now);

        let rootName = String(record.rootName || "").trim();
        if (!rootName) {
          try { rootName = getSubmissionRootName(); } catch (_) {}
        }
        if (!rootName) continue;

        try {
          const status = await jsonpRequest(
            endpoint,
            { action: "status", submissionId: record.submissionId, fast: "0", rootName },
            6500
          );
          if (!submissionStateIsConfirmed(status?.state)) continue;

          updateSubmissionState(record.submissionId, status.state, {
            confirmedAt: new Date().toISOString(),
            pdfUrl: status?.pdfUrl || record.pdfUrl || "",
            lastError: "",
          });

          if (record.kind === "photoEvidence" && record.optionId) {
            recordEvidence({
              assessmentId: record.assessmentId,
              optionId: record.optionId,
              optionLabel: record.optionLabel,
              descriptor: record.descriptor,
              method: record.method || "photo",
              submissionId: record.submissionId,
              submittedAt: record.startedAt || new Date().toISOString(),
              state: status.state,
              pdfUrl: status?.pdfUrl || record.pdfUrl || "",
              repeatable: record.repeatable !== false,
            });
          }
        } catch (error) {
          if (window.DEBUG) console.warn("Flexible Groups: submission reconciliation failed", record.submissionId, error);
        }
      }
    } finally {
      submissionReconcileBusy = false;
      scheduleEvidenceTrackerRender();
    }
  }

  function questionEarnedPoints(question, answer) {
    const value = String(answer || "").trim();
    if (!value) return 0;
    const max = Number(question?.maxPoints ?? 1) || 1;
    const rubric = Array.isArray(question?.rubric) ? question.rubric : [];
    if (!rubric.length) return max;

    let earned = 0;
    rubric.forEach((rule) => {
      let check = rule?.check;
      try {
        if (!(check instanceof RegExp)) check = new RegExp(String(check || ""), String(rule?.flags || "i"));
        check.lastIndex = 0;
        if (check.test(value)) {
          if (max === 1) earned = Math.max(earned, Math.min(Number(rule?.points || 0), max));
          else earned += Number(rule?.points || 0);
        }
      } catch (error) {
        console.warn("Flexible Groups: tracker could not evaluate rubric", question?.id, error);
      }
    });
    return Math.min(max, earned);
  }

  function questionIsComplete(question, assessmentId, requirement = "rubric") {
    const answer = answerForTracker(assessmentId, question?.id);
    if (!answer) return false;
    if (String(requirement || "rubric") === "answered") return true;
    const max = Number(question?.maxPoints ?? 1) || 1;
    return questionEarnedPoints(question, answer) >= max;
  }

  function materialiseForTracker(assessment) {
    if (assessment && Array.isArray(assessment.blocks)) materialiseFlexibleAssessment(assessment);
    return assessment;
  }

  function evidenceRecordsFor(item) {
    return ensureEvidenceRecords().filter((record) => {
      if (String(record?.assessmentId || "") !== String(item?.assessmentId || "")) return false;
      if (item?.optionId && String(record?.optionId || "") !== String(item.optionId)) return false;
      return record?.state === "confirmed" || record?.state === "duplicate" || !record?.state;
    });
  }

  function trackerResult(item) {
    const type = String(item?.type || "assessment");
    const assessment = materialiseForTracker(assessmentById(item?.assessmentId));
    const label = String(item?.label || assessment?.title || "Evidence");
    const required = item?.required !== false && item?.informational !== true;
    const requirement = String(item?.require || "rubric");

    if (!assessment && type !== "photoOption") {
      return { label, met: false, required, detail: "Assessment section not found.", note: item?.note || "", assessmentId: item?.assessmentId || "" };
    }

    if (type === "repeatGroup") {
      const meta = (assessment?.__flexRepeatMeta || []).find((entry) => entry.blockId === item.blockId);
      if (!meta) return { label, met: false, required, detail: "Repeatable section not found.", note: item?.note || "", assessmentId: item?.assessmentId || "" };
      let complete = 0;
      for (let n = 1; n <= meta.count; n += 1) {
        const prefix = `${meta.blockId}_${n}_`;
        const questions = (assessment.questions || []).filter((q) => String(q.id || "").startsWith(prefix));
        if (questions.length && questions.every((q) => questionIsComplete(q, assessment.id, requirement))) complete += 1;
      }
      const met = complete >= meta.count && meta.count >= Number(item?.minimum || meta.minimum || 1);
      const submission = met ? latestAssessmentSubmission(assessment.id) : { state: "incomplete", changedSinceSubmission: false };
      const noun = String(item?.unitLabel || meta.block?.itemLabel || "record");
      const suffix = submission.state === "submitted"
        ? " · confirmed in the teacher register"
        : submission.state === "pending"
        ? " · awaiting register confirmation"
        : submission.changedSinceSubmission
        ? " · changed since the last submission"
        : " · complete on this device";
      return {
        label,
        met,
        state: met ? submission.state : "incomplete",
        required,
        detail: `${complete}/${meta.count} ${noun}s complete${suffix}`,
        note: item?.note || "",
        assessmentId: assessment.id,
      };
    }

    if (type === "groups" || type === "questions" || type === "assessment") {
      let questions = Array.from(assessment?.questions || []);
      if (type === "groups" && Array.isArray(item?.blockIds)) {
        const wanted = new Set(item.blockIds.map((value) => String(value)));
        questions = questions.filter((q) => wanted.has(String(q.group || "")));
      }
      if (type === "questions" && Array.isArray(item?.questionIds)) {
        const wanted = new Set(item.questionIds.map((value) => String(value)));
        questions = questions.filter((q) => wanted.has(String(q.id || "")));
      }
      const complete = questions.filter((q) => questionIsComplete(q, assessment.id, requirement)).length;
      const total = questions.length;
      const met = total > 0 && complete === total;
      const submission = met ? latestAssessmentSubmission(assessment.id) : { state: "incomplete", changedSinceSubmission: false };
      const suffix = submission.state === "submitted"
        ? " · confirmed in the teacher register"
        : submission.state === "pending"
        ? " · awaiting register confirmation"
        : submission.changedSinceSubmission
        ? " · changed since the last submission"
        : " · complete on this device";
      return {
        label,
        met,
        state: met ? submission.state : "incomplete",
        required,
        detail: `${complete}/${total} answer${total === 1 ? "" : "s"} complete${suffix}`,
        note: item?.note || "",
        assessmentId: assessment.id,
      };
    }

    if (type === "photoOption") {
      const records = evidenceRecordsFor(item);
      const minimum = Math.max(1, Number(item?.minimum || 1) || 1);
      const count = records.length;
      const met = count >= minimum;
      const noun = String(item?.unitLabel || "submission");
      return {
        label,
        met,
        ongoing: !!item?.ongoing && met,
        state: met ? (item?.ongoing ? "ongoing" : "submitted") : "incomplete",
        required,
        detail: item?.ongoing
          ? `${count} ${noun}${count === 1 ? "" : "s"} confirmed in the teacher register`
          : `${Math.min(count, minimum)}/${minimum} ${noun}${minimum === 1 ? "" : "s"} confirmed in the teacher register`,
        note: item?.note || "",
        assessmentId: item?.assessmentId || "",
        optionId: item?.optionId || "",
      };
    }

    return { label, met: false, required, detail: `Unsupported tracker item type: ${type}`, note: item?.note || "", assessmentId: item?.assessmentId || "" };
  }

  function openTrackerItem(result) {
    const index = (ASSESSMENTS || []).findIndex((assessment) => assessment?.id === result.assessmentId);
    if (index < 0) return;
    const selector = document.getElementById("assessmentSelector");
    if (!selector) return;
    selector.value = String(index);
    window.loadAssessment();
    if (result.optionId) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const criteria = document.getElementById("photoEvidenceCriteria");
        if (!criteria) return;
        criteria.value = String(result.optionId);
        criteria.dispatchEvent(new Event("change", { bubbles: true }));
        criteria.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
    }
  }

  function trackerHost() {
    const selection = document.querySelector(".quizmaster-selection-grid");
    if (!selection) return null;
    let tracker = document.getElementById("qmEvidenceTracker");
    if (!tracker) {
      tracker = document.createElement("details");
      tracker.id = "qmEvidenceTracker";
      tracker.className = "qm-evidence-tracker";
      tracker.open = true;
      selection.insertAdjacentElement("afterend", tracker);
    }
    return tracker;
  }

  function removeTracker() {
    document.getElementById("qmEvidenceTracker")?.remove();
  }

  function getEvidenceProgress() {
    const config = CURRENT_QUESTION_SET?.evidenceTracker;
    if (!config || !Array.isArray(config.items) || !config.items.length) {
      return { config: null, results: [], metCount: 0, requiredCount: 0, percent: 0 };
    }
    const results = config.items.map(trackerResult);
    const requiredResults = results.filter((result) => result.required);
    const metCount = requiredResults.filter((result) => result.met).length;
    const readyCount = requiredResults.filter((result) => result.state === "ready").length;
    const submittedCount = requiredResults.filter((result) => result.state === "submitted" || result.state === "ongoing").length;
    const awaitingCount = requiredResults.filter((result) => result.state === "pending").length;
    const requiredCount = requiredResults.length;
    const todoCount = requiredResults.filter((result) => result.state === "incomplete").length;
    const percent = requiredCount ? Math.round((metCount / requiredCount) * 100) : 100;
    return { config, results, metCount, readyCount, submittedCount, awaitingCount, todoCount, pendingCount: todoCount, requiredCount, percent };
  }

  function renderEvidenceTracker() {
    const snapshot = getEvidenceProgress();
    const { config, results, readyCount, submittedCount, awaitingCount, todoCount, requiredCount, percent } = snapshot;
    if (!config) {
      removeTracker();
      return;
    }
    injectStyles();
    const tracker = trackerHost();
    if (!tracker) return;
    const wasOpen = tracker.open;
    tracker.replaceChildren();
    tracker.open = wasOpen;

    const summary = document.createElement("summary");
    const summaryText = document.createElement("div");
    summaryText.className = "qm-evidence-tracker__summary-text";
    const kicker = document.createElement("div");
    kicker.className = "qm-evidence-tracker__kicker";
    kicker.textContent = String(config.kicker || "Evidence progress");
    const title = document.createElement("h3");
    title.className = "qm-evidence-tracker__title";
    title.textContent = String(config.title || "Your evidence");
    summaryText.append(kicker, title);
    const score = document.createElement("span");
    score.className = "qm-evidence-tracker__score";
    score.textContent = requiredCount
      ? `${readyCount} ready · ${submittedCount} submitted${awaitingCount ? ` · ${awaitingCount} awaiting confirmation` : ""} · ${todoCount} to do`
      : `${results.length} progress checks`;
    summary.append(summaryText, score);
    tracker.appendChild(summary);

    const body = document.createElement("div");
    body.className = "qm-evidence-tracker__body";
    if (config.intro) {
      const intro = document.createElement("p");
      intro.className = "qm-evidence-tracker__intro";
      intro.textContent = String(config.intro);
      body.appendChild(intro);
    }
    const legend = document.createElement("div");
    legend.className = "qm-evidence-tracker__legend";
    [["Ready — not submitted", "is-ready"], ["Awaiting confirmation", "is-pending"], ["Submitted", "is-submitted"], ["Submitted — ongoing", "is-ongoing"], ["To do", "is-incomplete"]].forEach(([text, className]) => {
      const chip = document.createElement("span");
      chip.className = className;
      chip.textContent = text;
      legend.appendChild(chip);
    });
    body.appendChild(legend);
    const bar = document.createElement("div");
    bar.className = "qm-evidence-tracker__bar";
    const fill = document.createElement("span");
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    body.appendChild(bar);

    const list = document.createElement("div");
    list.className = "qm-evidence-tracker__list";
    results.forEach((result) => {
      const row = document.createElement("div");
      row.className = "qm-evidence-tracker__item";
      const state = result.state || (result.ongoing ? "ongoing" : result.met ? "ready" : "incomplete");
      row.classList.add(`is-${state}`);

      const icon = document.createElement("span");
      icon.className = "qm-evidence-tracker__icon";
      icon.textContent = state === "ongoing" ? "•" : state === "pending" ? "…" : (state === "ready" || state === "submitted") ? "✓" : "○";
      icon.setAttribute("aria-hidden", "true");

      const textWrap = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = result.label;
      const detail = document.createElement("small");
      detail.textContent = result.detail;
      const status = document.createElement("span");
      status.className = `qm-evidence-tracker__status is-${state}`;
      status.textContent = state === "submitted"
        ? "SUBMITTED"
        : state === "ongoing"
        ? "SUBMITTED — ONGOING"
        : state === "pending"
        ? "AWAITING CONFIRMATION"
        : state === "ready"
        ? "READY — NOT SUBMITTED"
        : "TO DO";
      textWrap.append(label, detail, status);
      if (result.note) {
        const note = document.createElement("small");
        note.textContent = String(result.note);
        textWrap.appendChild(note);
      }

      const open = document.createElement("button");
      open.type = "button";
      open.className = "qm-evidence-tracker__open";
      open.textContent = String(config.openLabel || "Open");
      open.addEventListener("click", (event) => {
        event.preventDefault();
        openTrackerItem(result);
      });
      if (!result.assessmentId) open.disabled = true;

      row.append(icon, textWrap, open);
      list.appendChild(row);
    });
    body.appendChild(list);

    const foot = document.createElement("p");
    foot.className = "qm-evidence-tracker__foot";
    foot.textContent = String(config.footer || "Ready means complete on this device only. Green Submitted appears only after QuizMaster receives confirmation from the teacher register. Your teacher still decides whether the evidence is sufficient for the standard.");
    body.appendChild(foot);
    tracker.appendChild(body);
  }

  function scheduleEvidenceTrackerRender(delay = 60) {
    clearTimeout(evidenceTrackerTimer);
    evidenceTrackerTimer = window.setTimeout(renderEvidenceTracker, delay);
  }

  function initEvidenceTrackerObservers() {
    document.addEventListener("input", (event) => {
      if (event.target?.closest?.("#questions")) scheduleEvidenceTrackerRender();
    });
    document.addEventListener("change", (event) => {
      if (event.target?.closest?.("#questions") || event.target?.id === "questionSetSelector") {
        scheduleEvidenceTrackerRender(event.target?.id === "questionSetSelector" ? 250 : 60);
      }
    });
    const selector = document.getElementById("assessmentSelector");
    if (selector && window.MutationObserver) {
      const observer = new MutationObserver(() => scheduleEvidenceTrackerRender(40));
      observer.observe(selector, { childList: true, subtree: true, attributes: true });
    }
    scheduleEvidenceTrackerRender(100);
    window.setTimeout(() => reconcilePendingSubmissions(), 700);
    window.setTimeout(() => reconcilePendingSubmissions(), 10000);
  }

  window.loadAssessment = function flexibleLoadAssessment(...args) {
    const idx = document.getElementById("assessmentSelector")?.value;
    const assessment = idx === "" || idx == null ? null : ASSESSMENTS?.[idx];
    if (assessment && Array.isArray(assessment.blocks)) materialiseFlexibleAssessment(assessment);
    const result = originalLoadAssessment.apply(this, args);
    if (assessment?.__flexMaterialised) {
      window.requestAnimationFrame(() => renderFlexibleEnhancements(assessment));
    }
    scheduleEvidenceTrackerRender();
    window.setTimeout(() => reconcilePendingSubmissions(), 500);
    return result;
  };

  async function trackedSubmitToTeacher(...args) {
    if (typeof originalSubmitToTeacher !== "function") return undefined;

    let trackedSubmissionId = "";
    let trackedAssessmentId = "";
    try {
      if (!submissionInProgress && !lastConfirmedSubmission && finalData && preparedPdfResult && preparedPukResult) {
        if (!currentSubmissionId) currentSubmissionId = makeSubmissionId();
        trackedSubmissionId = String(currentSubmissionId || "");
        trackedAssessmentId = String(finalData.assessmentId || "");
        if (trackedSubmissionId && trackedAssessmentId) {
          recordSubmission({
            submissionId: trackedSubmissionId,
            kind: "assessment",
            questionSetId: CURRENT_QUESTION_SET?.id || "",
            assessmentId: trackedAssessmentId,
            assessmentTitle: finalData.assessmentTitle || "",
            state: "pending",
            rootName: getSubmissionRootName(),
            startedAt: new Date().toISOString(),
            answerSignature: assessmentAnswerSignature(trackedAssessmentId),
          });

          // Rebuild the encrypted backup after the pending submission record has
          // been saved, so the uploaded .puk contains the submission ID needed
          // to reconcile against the register when it is restored later.
          preparedPukResult = await createProgressBackupForSubmission();
          try { updatePdfActionState(); } catch (_) {}
        }
      }
    } catch (trackingError) {
      console.warn("Flexible Groups: could not add the submission record to the .puk", trackingError);
    }

    const result = await originalSubmitToTeacher.apply(this, args);

    if (trackedSubmissionId) {
      try {
        if (submissionStateIsConfirmed(lastConfirmedSubmission?.state)) {
          updateSubmissionState(trackedSubmissionId, lastConfirmedSubmission.state, {
            confirmedAt: new Date().toISOString(),
            lastError: "",
          });

          // Refresh the downloadable .puk so a backup downloaded after the
          // confirmation already contains the confirmed submission state.
          preparedPukResult = await createProgressBackupForSubmission();
          try { updatePdfActionState(); } catch (_) {}
        } else {
          updateSubmissionState(trackedSubmissionId, "pending", {
            lastError: "Confirmation was not received yet. QuizMaster will check the register again when this backup is loaded.",
          });
        }
      } catch (trackingError) {
        console.warn("Flexible Groups: could not update the confirmed submission record", trackingError);
      }
      scheduleEvidenceTrackerRender();
    }

    return result;
  }

  if (typeof originalSubmitToTeacher === "function") {
    window.submitToTeacher = trackedSubmitToTeacher;
  }

  // Public helpers are intentionally small so future plugins can reuse the engine
  // without knowing how QuizMaster stores repeat counts internally.
  window.QuizMasterFlexible = Object.freeze({
    schemaVersion: FLEX_SCHEMA_MIN,
    pluginVersion: PLUGIN_VERSION,
    materialiseAssessment: materialiseFlexibleAssessment,
    getRepeatCount,
    setRepeatCount,
    conditionMatches,
    recordEvidence,
    recordSubmission,
    updateSubmissionState,
    reconcilePendingSubmissions,
    assessmentAnswerSignature,
    getEvidenceProgress,
    renderEvidenceTracker,
  });

  initEvidenceTrackerObservers();
})();
