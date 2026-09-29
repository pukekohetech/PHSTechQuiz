/*
 * QuizMaster Flexible Groups plugin v1
 * Generic schema-v3 repeatable question groups for any standard.
 *
 * Load after script.js and BEFORE photo-evidence.js:
 *   <script src="flexible-groups.js?v=1" defer></script>
 *
 * Existing schema-v2 standards continue to work unchanged.
 */
(() => {
  "use strict";

  const FLEX_SCHEMA_MIN = 3;
  const originalLoadAssessment = window.loadAssessment;

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
      @media (max-width:640px){.flex-repeat-controls__count{width:100%;margin-right:0}.flex-repeat-controls button{flex:1 1 auto}}
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

  function materialiseFlexibleAssessment(assessment) {
    if (!Array.isArray(assessment?.blocks)) return false;

    const groups = [];
    const questions = [];
    const repeatMeta = [];

    assessment.blocks.forEach((block, blockIndex) => {
      const type = String(block?.type || "group").trim();
      const blockId = safeId(block?.id || `block-${blockIndex + 1}`, `block-${blockIndex + 1}`);

      if (type === "group") {
        const groupId = blockId;
        const vars = { n: 1, count: 1, min: 1, max: 1 };
        groups.push(groupDefinition(block, vars, groupId));
        (block.questions || []).forEach((q, qIndex) => {
          const qid = safeId(q?.id || `q${qIndex + 1}`, `q${qIndex + 1}`);
          questions.push(cloneQuestion(q, { id: qid, group: groupId }));
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

  function rerenderAssessment(assessment) {
    try { persistCurrentAssessmentAnswers(); } catch (_) {}
    materialiseFlexibleAssessment(assessment);
    originalLoadAssessment();
    window.requestAnimationFrame(() => renderRepeatControls(assessment));
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
          rerenderAssessment(assessment);
          showToast(`Added another ${noun}.`);
          window.requestAnimationFrame(() => {
            const newSection = findGroupSection(`${blockId}-${count + 1}`);
            newSection?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
        controls.appendChild(addBtn);
      }

      lastSection.insertAdjacentElement("afterend", controls);
    });
  }

  window.loadAssessment = function flexibleLoadAssessment(...args) {
    const idx = document.getElementById("assessmentSelector")?.value;
    const assessment = idx === "" || idx == null ? null : ASSESSMENTS?.[idx];
    if (assessment && Array.isArray(assessment.blocks)) materialiseFlexibleAssessment(assessment);
    const result = originalLoadAssessment.apply(this, args);
    if (assessment?.__flexMaterialised) {
      window.requestAnimationFrame(() => renderRepeatControls(assessment));
    }
    return result;
  };

  // Public helpers are intentionally small so future plugins can reuse the engine
  // without knowing how QuizMaster stores repeat counts internally.
  window.QuizMasterFlexible = Object.freeze({
    schemaVersion: FLEX_SCHEMA_MIN,
    materialiseAssessment: materialiseFlexibleAssessment,
    getRepeatCount,
    setRepeatCount,
  });
})();
