/*
 * QuizMaster photo evidence extension - test build
 *
 * Adds support for assessments with:
 *   submissionMode: "photoEvidence"
 * and one or more questions with:
 *   type: "photo"
 *
 * This test deliberately uses the EXISTING QuizMaster submission gateway.
 * The selected image is compressed, placed on a one-page PDF with its evidence
 * label, and submitted with the normal encrypted .puk backup. No Apps Script
 * changes are required for this test.
 */
(() => {
  "use strict";

  const PHOTO_MODE = "photoEvidence";
  const DEFAULT_MAX_DIMENSION = 1800;
  const DEFAULT_JPEG_QUALITY = 0.82;

  let photoBusy = false;
  let previewObjectUrl = "";
  let pendingSubmission = null;

  const originalLoadAssessment = window.loadAssessment;
  const originalSubmitWork = window.submitWork;

  function getSelectedAssessment() {
    const selector = document.getElementById("assessmentSelector");
    if (!selector || selector.value === "") return null;
    return ASSESSMENTS?.[Number(selector.value)] || null;
  }

  function isPhotoAssessment(assessment) {
    return assessment?.submissionMode === PHOTO_MODE;
  }

  function getPhotoQuestion(assessment) {
    return (assessment?.questions || []).find((q) => q.type === "photo") || null;
  }

  function getSubmitButton() {
    return document.querySelector('#form button[onclick="submitWork()"]');
  }

  function setNormalSubmitLabel() {
    const button = getSubmitButton();
    if (button) button.textContent = "Submit & Grade";
  }

  function setPhotoSubmitLabel() {
    const button = getSubmitButton();
    if (button) button.textContent = photoBusy ? "Submitting Photo..." : "Submit Photo Evidence";
  }

  function injectPhotoStyles() {
    if (document.getElementById("quizmaster-photo-evidence-styles")) return;
    const style = document.createElement("style");
    style.id = "quizmaster-photo-evidence-styles";
    style.textContent = `
      .photo-evidence-card {
        display: grid;
        gap: 14px;
      }
      .photo-evidence-intro {
        margin: 0;
        color: #475569;
        line-height: 1.5;
      }
      .photo-evidence-label {
        display: grid;
        gap: 7px;
        font-weight: 700;
      }
      .photo-evidence-label small {
        font-weight: 400;
        color: #64748b;
        line-height: 1.45;
      }
      .photo-evidence-select,
      .photo-evidence-file {
        width: 100%;
        box-sizing: border-box;
      }
      .photo-evidence-preview-wrap {
        display: none;
        border: 1px solid #d7dce3;
        border-radius: 12px;
        padding: 10px;
        background: #f8fafc;
      }
      .photo-evidence-preview-wrap.is-visible {
        display: block;
      }
      .photo-evidence-preview {
        display: block;
        width: 100%;
        max-height: 460px;
        object-fit: contain;
        border-radius: 8px;
        background: #fff;
      }
      .photo-evidence-file-meta {
        margin: 8px 0 0;
        font-size: 0.88rem;
        color: #64748b;
      }
      .photo-evidence-status {
        min-height: 1.5em;
        margin: 0;
        font-weight: 650;
      }
      .photo-evidence-status.success { color: #166534; }
      .photo-evidence-status.error { color: #b91c1c; }
      .photo-evidence-status.busy { color: #334155; }
      .photo-evidence-recent {
        margin: 0;
        padding-left: 20px;
        color: #475569;
      }
      .photo-evidence-recent:empty { display: none; }
    `;
    document.head.appendChild(style);
  }

  function clearPreview() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = "";
    const wrap = document.getElementById("photoEvidencePreviewWrap");
    const img = document.getElementById("photoEvidencePreview");
    const meta = document.getElementById("photoEvidenceFileMeta");
    if (img) img.removeAttribute("src");
    if (meta) meta.textContent = "";
    wrap?.classList.remove("is-visible");
  }

  function resetPendingSubmission() {
    pendingSubmission = null;
  }

  function renderPhotoEvidenceUi(assessment) {
    injectPhotoStyles();
    const q = getPhotoQuestion(assessment);
    if (!q) {
      showToast("Photo evidence assessment is missing its photo question.", false);
      return;
    }

    const wrap = document.getElementById("q-" + String(q.id).toLowerCase());
    if (!wrap) return;

    clearPreview();
    resetPendingSubmission();
    wrap.replaceChildren();
    wrap.className = "question photo-evidence-card";

    const header = document.createElement("div");
    header.className = "question-header";
    const left = document.createElement("span");
    left.textContent = "Photo evidence";
    const right = document.createElement("span");
    right.textContent = "Upload 1 photo";
    header.append(left, right);
    wrap.appendChild(header);

    const prompt = document.createElement("p");
    prompt.textContent = q.text || "Choose what this photo is evidence for, then take or upload one image.";
    wrap.appendChild(prompt);

    const intro = document.createElement("p");
    intro.className = "photo-evidence-intro";
    intro.textContent = assessment.photoEvidence?.instructions ||
      "Choose the evidence type, then take a photo or select one from your device. Submit one photo at a time.";
    wrap.appendChild(intro);

    const criteriaLabel = document.createElement("label");
    criteriaLabel.className = "photo-evidence-label";
    criteriaLabel.htmlFor = "q" + q.id;
    criteriaLabel.appendChild(document.createTextNode("What is this photo evidence for?"));

    const criteriaSelect = document.createElement("select");
    criteriaSelect.id = "q" + q.id;
    criteriaSelect.className = "answer-field photo-evidence-select";
    criteriaSelect.appendChild(new Option("Select the evidence type", ""));
    (assessment.photoEvidence?.criteria || []).forEach((criterion) => {
      criteriaSelect.appendChild(new Option(criterion.label, criterion.id));
    });
    const saved = getAnswer(q.id);
    if (saved) criteriaSelect.value = saved;
    criteriaSelect.addEventListener("change", () => {
      saveAnswer(q.id);
      updateCriterionHelp(assessment, criteriaSelect.value);
      resetPendingSubmission();
    });
    criteriaLabel.appendChild(criteriaSelect);

    const criteriaHelp = document.createElement("small");
    criteriaHelp.id = "photoEvidenceCriterionHelp";
    criteriaLabel.appendChild(criteriaHelp);
    wrap.appendChild(criteriaLabel);

    const fileLabel = document.createElement("label");
    fileLabel.className = "photo-evidence-label";
    fileLabel.htmlFor = "photoEvidenceFile";
    fileLabel.appendChild(document.createTextNode("Take or upload a photo"));

    const fileInput = document.createElement("input");
    fileInput.id = "photoEvidenceFile";
    fileInput.className = "photo-evidence-file";
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.setAttribute("capture", "environment");
    fileInput.addEventListener("change", () => {
      resetPendingSubmission();
      showPhotoPreview(fileInput.files?.[0] || null);
    });
    fileLabel.appendChild(fileInput);

    const fileHelp = document.createElement("small");
    fileHelp.textContent = "On a phone or tablet you can take a new photo or choose one already saved on the device.";
    fileLabel.appendChild(fileHelp);
    wrap.appendChild(fileLabel);

    const previewWrap = document.createElement("div");
    previewWrap.id = "photoEvidencePreviewWrap";
    previewWrap.className = "photo-evidence-preview-wrap";
    const preview = document.createElement("img");
    preview.id = "photoEvidencePreview";
    preview.className = "photo-evidence-preview";
    preview.alt = "Selected photo preview";
    const fileMeta = document.createElement("p");
    fileMeta.id = "photoEvidenceFileMeta";
    fileMeta.className = "photo-evidence-file-meta";
    previewWrap.append(preview, fileMeta);
    wrap.appendChild(previewWrap);

    const status = document.createElement("p");
    status.id = "photoEvidenceStatus";
    status.className = "photo-evidence-status";
    status.setAttribute("aria-live", "polite");
    wrap.appendChild(status);

    const recent = document.createElement("ul");
    recent.id = "photoEvidenceRecent";
    recent.className = "photo-evidence-recent";
    wrap.appendChild(recent);

    updateCriterionHelp(assessment, criteriaSelect.value);
    setPhotoSubmitLabel();
  }

  function updateCriterionHelp(assessment, value) {
    const help = document.getElementById("photoEvidenceCriterionHelp");
    if (!help) return;
    const criterion = (assessment.photoEvidence?.criteria || []).find((item) => item.id === value);
    help.textContent = criterion?.help || "Choose the requirement that this photo supports.";
  }

  function showPhotoPreview(file) {
    clearPreview();
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setPhotoStatus("Please choose an image file.", "error");
      return;
    }
    previewObjectUrl = URL.createObjectURL(file);
    const wrap = document.getElementById("photoEvidencePreviewWrap");
    const img = document.getElementById("photoEvidencePreview");
    const meta = document.getElementById("photoEvidenceFileMeta");
    if (img) img.src = previewObjectUrl;
    if (meta) meta.textContent = `${file.name || "Photo"} · ${formatBytes(file.size || 0)}`;
    wrap?.classList.add("is-visible");
    setPhotoStatus("", "");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setPhotoStatus(message, state) {
    const status = document.getElementById("photoEvidenceStatus");
    if (!status) return;
    status.textContent = message || "";
    status.className = "photo-evidence-status" + (state ? ` ${state}` : "");
  }

  async function loadImageForCanvas(file) {
    if (window.createImageBitmap) {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw(ctx, width, height) {
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close?.();
          },
        };
      } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          draw(ctx, width, height) {
            ctx.drawImage(img, 0, 0, width, height);
            URL.revokeObjectURL(url);
          },
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("This image format could not be opened. Try a JPG, PNG, or WebP image."));
      };
      img.src = url;
    });
  }

  async function compressPhoto(file, assessment) {
    const maxDimension = Number(assessment.photoEvidence?.maxImageDimension || DEFAULT_MAX_DIMENSION);
    const quality = Number(assessment.photoEvidence?.jpegQuality || DEFAULT_JPEG_QUALITY);
    const source = await loadImageForCanvas(file);
    if (!source.width || !source.height) throw new Error("The selected image had no usable dimensions.");

    const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("The browser could not prepare the photo.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    source.draw(ctx, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("The browser could not compress the photo.");
    return { blob, width, height };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read the photo."));
      reader.readAsDataURL(blob);
    });
  }

  async function createPhotoEvidencePdf(photo, details) {
    if (!window.jspdf?.jsPDF) await loadFirstAvailableScript(PDF_LIBRARY_URLS.jspdf);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });

    const margin = 15;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Photo Evidence", margin, 18);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.text(`${details.unitStandard}${details.standardVersion ? ` ${details.standardVersion}` : ""}`, margin, 27);
    doc.text(`${details.studentName} (${details.studentId})`, margin, 34);
    doc.text(`Evidence: ${details.evidenceLabel}`, margin, 41, { maxWidth: pageWidth - margin * 2 });
    doc.text(`Submitted: ${new Date().toLocaleString("en-NZ")}`, margin, 50);

    const dataUrl = await blobToDataUrl(photo.blob);
    const maxW = pageWidth - margin * 2;
    const maxH = pageHeight - 72;
    const ratio = Math.min(maxW / photo.width, maxH / photo.height);
    const drawW = photo.width * ratio;
    const drawH = photo.height * ratio;
    const x = (pageWidth - drawW) / 2;
    const y = 60;
    doc.addImage(dataUrl, "JPEG", x, y, drawW, drawH, undefined, "FAST");

    const arrayBuffer = doc.output("arraybuffer");
    return new Blob([arrayBuffer], { type: "application/pdf" });
  }

  function makePhotoSubmissionId() {
    const random = new Uint32Array(2);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(random);
    else {
      random[0] = Math.floor(Math.random() * 0xffffffff);
      random[1] = Math.floor(Math.random() * 0xffffffff);
    }
    return `photo_${Date.now()}_${random[0].toString(36)}${random[1].toString(36)}`;
  }

  function currentStandardCode() {
    if (!CURRENT_QUESTION_SET) return "Unit Standard";
    const prefix = CURRENT_QUESTION_SET.standardPrefix || (/^ss/i.test(CURRENT_QUESTION_SET.id || "") ? "SS" : "US");
    return `${prefix} ${CURRENT_QUESTION_SET.number}`;
  }

  function selectedCriterion(assessment, value) {
    return (assessment.photoEvidence?.criteria || []).find((criterion) => criterion.id === value) || null;
  }

  async function submitPhotoEvidence(assessment) {
    if (photoBusy) return;

    const studentName = document.getElementById("name")?.value.trim() || "";
    const studentId = document.getElementById("id")?.value.trim() || "";
    const teacherSelector = document.getElementById("teacher");
    const teacherId = teacherSelector?.value || "";
    const question = getPhotoQuestion(assessment);
    const criterionSelect = question ? document.getElementById("q" + question.id) : null;
    const criterion = selectedCriterion(assessment, criterionSelect?.value || "");
    const fileInput = document.getElementById("photoEvidenceFile");
    const file = fileInput?.files?.[0] || null;

    if (!studentName) return setPhotoStatus("Enter your name first.", "error");
    if (!studentId) return setPhotoStatus("Enter your Student ID first.", "error");
    if (!teacherId) return setPhotoStatus("Select your teacher first.", "error");
    if (!criterion) return setPhotoStatus("Choose what the photo is evidence for.", "error");
    if (!file) return setPhotoStatus("Take or choose a photo first.", "error");
    if (!navigator.onLine) return setPhotoStatus("No internet connection. Reconnect before submitting the photo.", "error");

    const endpoint = getSubmissionEndpoint();
    const storageRootName = getSubmissionRootName();
    if (!endpoint) return setPhotoStatus("Teacher submission is not configured yet.", "error");
    if (!storageRootName) return setPhotoStatus("Evidence storage is not configured yet.", "error");

    const teacher = TEACHERS.find((item) => item.id === teacherId) || {};
    const signature = `${file.name}|${file.size}|${file.lastModified}|${criterion.id}`;
    if (!pendingSubmission || pendingSubmission.signature !== signature) {
      pendingSubmission = { id: makePhotoSubmissionId(), signature };
    }

    photoBusy = true;
    setPhotoSubmitLabel();
    setPhotoStatus("Preparing photo...", "busy");

    try {
      saveStudentInfo();
      if (question) saveAnswer(question.id);

      const compressed = await compressPhoto(file, assessment);
      const details = {
        studentName,
        studentId,
        unitStandard: currentStandardCode(),
        standardVersion: CURRENT_QUESTION_SET?.version || "",
        evidenceLabel: criterion.label,
      };

      setPhotoStatus(`Preparing upload (${formatBytes(compressed.blob.size)})...`, "busy");
      const [pdfBlob, pukResult] = await Promise.all([
        createPhotoEvidencePdf(compressed, details),
        createProgressBackupForSubmission(),
      ]);
      const pdfBase64 = await blobToBase64(pdfBlob);

      const submissionId = pendingSubmission.id;
      const shortRef = submissionId.replace(/^photo_/, "").slice(0, 24);
      const dynamicAssessmentId = `${assessment.id}-${criterion.id}-${shortRef}`;
      const payload = {
        submissionId,
        appId: APP_ID,
        appVersion: APP_VERSION,
        questionSetId: CURRENT_QUESTION_SET?.id || "",
        storageRootName,
        studentName,
        studentId,
        teacherId: teacher.id || teacherId,
        teacherName: teacher.name || teacherSelector.options[teacherSelector.selectedIndex]?.text || teacherId,
        teacherEmail: teacher.email || "",
        unitStandard: details.unitStandard,
        standardVersion: details.standardVersion,
        assessmentId: dynamicAssessmentId,
        assessmentTitle: `${assessment.title} - ${criterion.label}`,
        score: 1,
        totalMarks: 1,
        percentage: 100,
        submittedAt: new Date().toISOString(),
        pdfMimeType: "application/pdf",
        pdfBase64,
        pukText: pukResult.pukText,
      };

      setPhotoStatus("Uploading photo evidence...", "busy");
      await fetch(endpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      setPhotoStatus("Upload received. Confirming...", "busy");
      const status = await waitForSubmissionStatus(endpoint, submissionId, storageRootName);
      if (!status || (status.state !== "confirmed" && status.state !== "duplicate")) {
        throw new Error("The photo was sent, but confirmation was not received. Press Submit Photo Evidence again to safely retry.");
      }

      const recent = document.getElementById("photoEvidenceRecent");
      if (recent) {
        const item = document.createElement("li");
        item.textContent = `${criterion.label} - submitted ${new Date().toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}`;
        recent.prepend(item);
      }

      setPhotoStatus(`Saved under Student ID ${studentId}. You can now choose another photo and submit again.`, "success");
      showToast("Photo evidence submitted.");
      if (fileInput) fileInput.value = "";
      clearPreview();
      pendingSubmission = null;
    } catch (error) {
      console.error("Photo evidence submission failed:", error);
      setPhotoStatus(error?.message || "Photo submission failed. Your selected image is still on this device.", "error");
      showToast("Photo submission was not confirmed.", false);
    } finally {
      photoBusy = false;
      setPhotoSubmitLabel();
    }
  }

  window.loadAssessment = function () {
    const result = originalLoadAssessment.apply(this, arguments);
    const assessment = getSelectedAssessment();
    if (isPhotoAssessment(assessment)) {
      window.setTimeout(() => renderPhotoEvidenceUi(assessment), 0);
    } else {
      setNormalSubmitLabel();
    }
    return result;
  };

  window.submitWork = function () {
    const assessment = getSelectedAssessment();
    if (isPhotoAssessment(assessment)) {
      submitPhotoEvidence(assessment);
      return;
    }
    return originalSubmitWork.apply(this, arguments);
  };
})();
