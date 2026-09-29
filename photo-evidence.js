/*
 * QuizMaster Photo Evidence plugin v2
 * Live camera behaviour adapted from the user's PHS Evidence Camera workflow.
 *
 * Add after script.js in index.html:
 *   <script src="photo-evidence.js?v=2" defer></script>
 *
 * A question-set assessment enables this UI with:
 *   "mode": "photo-evidence",
 *   "photoEvidence": { "options": [...] },
 *   "questions": []
 */
(() => {
  "use strict";

  const PHOTO_MODE = "photo-evidence";
  const DEFAULT_MAX_DIMENSION = 1920;
  const DEFAULT_JPEG_QUALITY = 0.8;
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

  let stream = null;
  let useFrontCamera = false;
  let capturedBlob = null;
  let capturedAt = "";
  let capturedObjectUrl = "";
  let activeAssessment = null;
  let elements = null;
  let sessionSubmissions = [];

  const originalLoadAssessment = window.loadAssessment;
  if (typeof originalLoadAssessment !== "function") {
    console.warn("Photo Evidence plugin: QuizMaster loadAssessment() was not available.");
    return;
  }

  function injectStyles() {
    if (document.getElementById("photoEvidenceStyles")) return;
    const style = document.createElement("style");
    style.id = "photoEvidenceStyles";
    style.textContent = `
      .photo-evidence-card{border:1px solid #d8dee8;border-radius:18px;padding:18px;background:#fff;box-shadow:0 8px 28px rgba(15,23,42,.06)}
      .photo-evidence-card h3{margin:0 0 6px;font-size:1.2rem}
      .photo-evidence-intro{margin:0 0 16px;color:#475569;line-height:1.45}
      .photo-evidence-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.8fr);gap:18px;align-items:start}
      .photo-evidence-field label{display:block;font-weight:750;margin-bottom:7px}
      .photo-evidence-field select{width:100%;min-height:48px}
      .photo-evidence-help{min-height:2.8em;margin:8px 0 0;color:#64748b;font-size:.92rem;line-height:1.4}
      .photo-camera-shell{margin-top:16px;border-radius:18px;overflow:hidden;background:#0b0c0f;border:1px solid #20242b}
      .photo-camera-stage{position:relative;aspect-ratio:16/9;display:grid;place-items:center;background:#050607;overflow:hidden}
      .photo-camera-stage video,.photo-camera-stage img{width:100%;height:100%;object-fit:contain;background:#050607}
      .photo-camera-empty{padding:24px;text-align:center;color:#cbd5e1;line-height:1.45}
      .photo-camera-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;padding:12px;background:#111318;border-top:1px solid #252a33}
      .photo-camera-actions button,.photo-evidence-submit-row button{min-height:44px;padding:10px 16px;border-radius:12px;border:1px solid #d4d9e1;font-weight:750;cursor:pointer}
      .photo-camera-actions button{background:#fff;color:#111827}
      .photo-camera-actions .photo-shutter{background:#7a1f2b;color:#fff;border-color:#7a1f2b}
      .photo-camera-actions button:disabled,.photo-evidence-submit-row button:disabled{opacity:.48;cursor:not-allowed}
      .photo-preview-meta{display:none;padding:12px 14px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#334155;font-size:.92rem}
      .photo-evidence-submit-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}
      .photo-evidence-submit{background:#7a1f2b;color:#fff;border-color:#7a1f2b!important}
      .photo-evidence-status{margin-top:12px;padding:11px 13px;border-radius:12px;background:#f1f5f9;color:#334155;line-height:1.4}
      .photo-evidence-status.success{background:#ecfdf5;color:#166534;border:1px solid #bbf7d0}
      .photo-evidence-status.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
      .photo-evidence-session{margin-top:16px;border-top:1px solid #e2e8f0;padding-top:13px}
      .photo-evidence-session strong{display:block;margin-bottom:7px}
      .photo-evidence-session ul{margin:0;padding-left:20px;color:#475569}
      .photo-evidence-camera-note{margin-top:8px;font-size:.82rem;color:#64748b}
      @media (max-width:760px){.photo-evidence-grid{grid-template-columns:1fr}.photo-evidence-card{padding:14px}.photo-camera-stage{aspect-ratio:4/3}}
    `;
    document.head.appendChild(style);
  }

  function currentAssessment() {
    const idx = document.getElementById("assessmentSelector")?.value;
    if (idx === "" || idx == null) return null;
    try { return ASSESSMENTS?.[idx] || null; } catch (_) { return null; }
  }

  function isPhotoAssessment(assessment) {
    return String(assessment?.mode || "").toLowerCase() === PHOTO_MODE || !!assessment?.photoEvidence;
  }

  function setStandardSubmitVisible(visible) {
    const button = document.querySelector('#form button[onclick="submitWork()"]');
    const group = button?.closest(".btn-group");
    if (group) group.style.display = visible ? "" : "none";
  }

  function revokeCapturedUrl() {
    if (!capturedObjectUrl) return;
    try { URL.revokeObjectURL(capturedObjectUrl); } catch (_) {}
    capturedObjectUrl = "";
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }
    stream = null;
    if (elements?.video) elements.video.srcObject = null;
    if (elements?.shootBtn) elements.shootBtn.disabled = true;
    if (elements?.flipBtn) elements.flipBtn.disabled = true;
  }

  function resetCapturedPhoto() {
    capturedBlob = null;
    capturedAt = "";
    revokeCapturedUrl();
    if (!elements) return;
    elements.preview.removeAttribute("src");
    elements.preview.hidden = true;
    elements.video.hidden = !stream;
    elements.empty.hidden = !!stream;
    elements.previewMeta.style.display = "none";
    elements.submitBtn.disabled = true;
  }

  function endPhotoSession({ restoreSubmit = true } = {}) {
    stopCamera();
    resetCapturedPhoto();
    activeAssessment = null;
    elements = null;
    sessionSubmissions = [];
    if (restoreSubmit) setStandardSubmitVisible(true);
  }

  function selectedEvidence() {
    if (!elements?.criteria) return null;
    const id = elements.criteria.value;
    const options = activeAssessment?.photoEvidence?.options || [];
    return options.find((item) => String(item.id) === String(id)) || null;
  }

  function updateEvidenceHelp() {
    if (!elements) return;
    const option = selectedEvidence();
    elements.help.textContent = option?.help || "Choose what this photo is evidence for.";
    elements.submitBtn.disabled = !(capturedBlob && option);
  }

  async function startCamera() {
    if (!elements) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser cannot open the live camera. Use Choose existing photo instead.", "error");
      return;
    }
    if (!window.isSecureContext && location.hostname !== "localhost" && location.protocol !== "file:") {
      setStatus("Live camera access needs HTTPS. Use Choose existing photo or open the secure QuizMaster site.", "error");
      return;
    }

    stopCamera();
    resetCapturedPhoto();
    setStatus("Opening camera…");
    try {
      const facingMode = useFrontCamera ? "user" : "environment";
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      elements.video.srcObject = stream;
      elements.video.setAttribute("playsinline", "");
      elements.video.muted = true;
      await new Promise((resolve) => {
        if (elements.video.readyState >= 1 && elements.video.videoWidth) return resolve();
        elements.video.onloadedmetadata = () => resolve();
      });
      await elements.video.play();
      elements.empty.hidden = true;
      elements.video.hidden = false;
      elements.shootBtn.disabled = false;
      elements.flipBtn.disabled = false;
      setStatus("Camera ready. Choose the evidence type, then take the photo.");
    } catch (error) {
      console.error("Photo Evidence camera error", error);
      stopCamera();
      elements.empty.hidden = false;
      setStatus("Camera access was denied or failed. You can still choose an existing photo.", "error");
    }
  }

  async function flipCamera() {
    useFrontCamera = !useFrontCamera;
    await startCamera();
  }

  function fitDimensions(width, height, maxDimension) {
    const max = Math.max(width, height);
    if (!max || max <= maxDimension) return { width, height };
    const scale = maxDimension / max;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function identitySnapshot() {
    const studentName = document.getElementById("name")?.value.trim() || "";
    const studentId = document.getElementById("id")?.value.trim() || "";
    const teacherSelect = document.getElementById("teacher");
    const teacherId = teacherSelect?.value || "";
    let teacherName = teacherSelect?.selectedOptions?.[0]?.textContent?.trim() || "";
    let teacherEmail = "";
    try {
      const match = TEACHERS?.find((teacher) => String(teacher.id) === String(teacherId));
      if (match?.name) teacherName = match.name;
      if (match?.email) teacherEmail = match.email;
    } catch (_) {}

    let standardPrefix = "US";
    let standardNumber = "";
    let questionSetId = "";
    try {
      standardPrefix = CURRENT_QUESTION_SET?.standardPrefix || "US";
      standardNumber = CURRENT_QUESTION_SET?.number || "";
      questionSetId = CURRENT_QUESTION_SET?.id || "";
    } catch (_) {}

    return {
      studentName,
      studentId,
      teacherId,
      teacherName,
      teacherEmail,
      questionSetId,
      unitStandard: `${standardPrefix} ${standardNumber}`.trim(),
    };
  }

  function drawStamp(ctx, width, height, evidenceLabel, identity, timestamp) {
    const base = Math.min(width, height);
    const fontSize = Math.max(17, Math.round(base * 0.026));
    const lineHeight = Math.round(fontSize * 1.3);
    const padX = Math.round(fontSize * 0.7);
    const padY = Math.round(fontSize * 0.55);
    const outer = Math.max(12, Math.round(base * 0.018));
    const lines = [
      `${identity.studentId} · ${identity.unitStandard}`,
      evidenceLabel,
      new Date(timestamp).toLocaleString("en-NZ"),
    ];

    ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textBaseline = "top";
    const maxText = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const boxWidth = Math.min(width * 0.88, maxText + padX * 2);
    const boxHeight = lineHeight * lines.length + padY * 2;
    const x = width - outer - boxWidth;
    const y = height - outer - boxHeight;

    ctx.fillStyle = "rgba(15,23,42,.82)";
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ctx.fillStyle = "#fff";
    let ty = y + padY;
    for (const line of lines) {
      ctx.fillText(line, x + padX, ty, boxWidth - padX * 2);
      ty += lineHeight;
    }
  }

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) return resolve(blob);
        try {
          fetch(canvas.toDataURL("image/jpeg", quality))
            .then((response) => response.blob())
            .then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      }, "image/jpeg", quality);
    });
  }

  async function makeEvidenceBlob(drawSource, sourceWidth, sourceHeight) {
    const option = selectedEvidence();
    if (!option) throw new Error("Choose what this photo is evidence for first.");
    const identity = identitySnapshot();
    if (!identity.studentId) throw new Error("Enter your Student ID first.");

    const config = activeAssessment?.photoEvidence || {};
    const maxDimension = Math.max(800, Number(config.maxDimension) || DEFAULT_MAX_DIMENSION);
    const quality = Math.min(.95, Math.max(.6, Number(config.jpegQuality) || DEFAULT_JPEG_QUALITY));
    const fitted = fitDimensions(sourceWidth, sourceHeight, maxDimension);
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, fitted.width, fitted.height);
    drawSource(ctx, fitted.width, fitted.height);
    const timestamp = new Date().toISOString();
    drawStamp(ctx, fitted.width, fitted.height, option.label, identity, timestamp);
    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("The prepared photo is too large. Try taking the photo again at a lower camera resolution.");
    }
    capturedAt = timestamp;
    return blob;
  }

  async function captureFromVideo() {
    if (!elements?.video?.videoWidth || !stream) {
      setStatus("Camera is not ready yet.", "error");
      return;
    }
    try {
      elements.shootBtn.disabled = true;
      const video = elements.video;
      const blob = await makeEvidenceBlob(
        (ctx, w, h) => ctx.drawImage(video, 0, 0, w, h),
        video.videoWidth,
        video.videoHeight
      );
      stopCamera();
      showCaptured(blob);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not prepare that photo.", "error");
      if (stream) elements.shootBtn.disabled = false;
    }
  }

  async function captureFromFile(file) {
    if (!file) return;
    if (!file.type?.startsWith("image/")) {
      setStatus("Please choose an image file.", "error");
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const blob = await makeEvidenceBlob(
          (ctx, w, h) => ctx.drawImage(image, 0, 0, w, h),
          width,
          height
        );
        stopCamera();
        showCaptured(blob);
      } catch (error) {
        console.error(error);
        setStatus(error.message || "Could not prepare that image.", "error");
      } finally {
        URL.revokeObjectURL(url);
        elements.fileInput.value = "";
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      elements.fileInput.value = "";
      setStatus("That image format could not be opened on this device.", "error");
    };
    image.src = url;
  }

  function showCaptured(blob) {
    capturedBlob = blob;
    revokeCapturedUrl();
    capturedObjectUrl = URL.createObjectURL(blob);
    elements.preview.src = capturedObjectUrl;
    elements.preview.hidden = false;
    elements.video.hidden = true;
    elements.empty.hidden = true;
    const option = selectedEvidence();
    elements.previewMeta.textContent = `${option?.label || "Photo evidence"} · ${Math.max(1, Math.round(blob.size / 1024))} KB`;
    elements.previewMeta.style.display = "block";
    elements.submitBtn.disabled = !option;
    setStatus("Photo ready. Check it, then submit the evidence.");
  }

  function setStatus(message, type = "") {
    if (!elements?.status) return;
    elements.status.textContent = message;
    elements.status.className = `photo-evidence-status${type ? ` ${type}` : ""}`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("The photo could not be read."));
      reader.readAsDataURL(blob);
    });
  }

  async function readBlobDimensions(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return dims;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const dims = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
        URL.revokeObjectURL(url);
        resolve(dims);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("The captured photo could not be opened."));
      };
      img.src = url;
    });
  }

  async function createPhotoEvidencePdf(photoBlob, details) {
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
    doc.text(`Captured: ${new Date(details.capturedAt).toLocaleString("en-NZ")}`, margin, 50);

    const dims = await readBlobDimensions(photoBlob);
    const dataUrl = await blobToDataUrl(photoBlob);
    const maxW = pageWidth - margin * 2;
    const maxH = pageHeight - 72;
    const ratio = Math.min(maxW / dims.width, maxH / dims.height);
    const drawW = dims.width * ratio;
    const drawH = dims.height * ratio;
    const x = (pageWidth - drawW) / 2;
    doc.addImage(dataUrl, "JPEG", x, 60, drawW, drawH, undefined, "FAST");

    return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
  }

  function safePart(value) {
    return String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_ .-]+|[_ .-]+$/g, "") || "photo";
  }

  function compactTimestamp(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function makeSubmissionId() {
    const random = new Uint32Array(2);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(random);
    else {
      random[0] = Math.floor(Math.random() * 0xffffffff);
      random[1] = Math.floor(Math.random() * 0xffffffff);
    }
    return `photo_${Date.now()}_${random[0].toString(36)}${random[1].toString(36)}`;
  }

  async function submitPhoto() {
    const option = selectedEvidence();
    if (!capturedBlob) return setStatus("Take or choose a photo first.", "error");
    if (!option) return setStatus("Choose what the photo is evidence for.", "error");

    const identity = identitySnapshot();
    if (!identity.studentName) return setStatus("Enter your name first.", "error");
    if (!/^\d{3,6}$/.test(identity.studentId)) return setStatus("Enter a valid Student ID first.", "error");
    if (!identity.teacherId) return setStatus("Select your teacher first.", "error");
    if (!navigator.onLine) return setStatus("You are offline. Reconnect before submitting this photo.", "error");

    let endpoint = "";
    let storageRootName = "";
    try {
      endpoint = getSubmissionEndpoint();
      storageRootName = getSubmissionRootName();
    } catch (_) {}
    if (!endpoint) return setStatus("Teacher submission is not configured yet.", "error");
    if (!storageRootName) return setStatus("Evidence storage is not configured.", "error");

    elements.submitBtn.disabled = true;
    elements.startBtn.disabled = true;
    elements.chooseBtn.disabled = true;
    setStatus("Preparing photo evidence…");

    const submissionId = makeSubmissionId();
    try {
      try { saveStudentInfo(); } catch (_) {}

      const timestamp = capturedAt || new Date().toISOString();
      const details = {
        studentName: identity.studentName,
        studentId: identity.studentId,
        unitStandard: identity.unitStandard,
        standardVersion: (() => { try { return CURRENT_QUESTION_SET?.version || ""; } catch (_) { return ""; } })(),
        evidenceLabel: option.label,
        capturedAt: timestamp,
      };

      // Keep the known-good QuizMaster submission route: the captured JPG is
      // wrapped in a one-page evidence PDF and submitted with the encrypted .puk.
      // This preserves the existing Drive filing and document/submission register.
      const [pdfBlob, pukResult] = await Promise.all([
        createPhotoEvidencePdf(capturedBlob, details),
        createProgressBackupForSubmission(),
      ]);
      const pdfBase64 = await blobToBase64(pdfBlob);

      const shortRef = submissionId.replace(/^photo_/, "").slice(0, 24);
      const dynamicAssessmentId = `${activeAssessment?.id || "photo-evidence-upload"}-${option.id}-${shortRef}`;
      const payload = {
        submissionId,
        appId: typeof APP_ID !== "undefined" ? APP_ID : "pukekohetech-quizmaster",
        appVersion: typeof APP_VERSION !== "undefined" ? APP_VERSION : "",
        questionSetId: identity.questionSetId,
        storageRootName,
        studentName: identity.studentName,
        studentId: identity.studentId,
        teacherId: identity.teacherId,
        teacherName: identity.teacherName,
        teacherEmail: identity.teacherEmail,
        unitStandard: identity.unitStandard,
        standardVersion: details.standardVersion,
        assessmentId: dynamicAssessmentId,
        assessmentTitle: `${activeAssessment?.title || "Photo Evidence Upload"} - ${option.label}`,
        score: 1,
        totalMarks: 1,
        percentage: 100,
        submittedAt: new Date().toISOString(),
        pdfMimeType: "application/pdf",
        pdfBase64,
        pukText: pukResult.pukText,
      };

      setStatus("Uploading photo evidence and updating the register…");
      await fetch(endpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      setStatus("Upload received. Confirming the register…");
      const status = await waitForSubmissionStatus(endpoint, submissionId, storageRootName);
      if (!status || (status.state !== "confirmed" && status.state !== "duplicate")) {
        throw new Error("The photo was sent, but confirmation was not received. Tap Submit Photo Evidence again to safely retry.");
      }

      sessionSubmissions.push({ label: option.label, at: new Date(), url: status?.pdfUrl || "" });
      renderSessionSubmissions();
      setStatus(`Saved under Student ID ${identity.studentId} and recorded in the register: ${option.label}`, "success");
      try { if (typeof showToast === "function") showToast("Photo evidence saved."); } catch (_) {}
      resetCapturedPhoto();
    } catch (error) {
      console.error("Photo evidence submission failed", error);
      setStatus(error.message || "Photo submission failed. Try again.", "error");
    } finally {
      elements.startBtn.disabled = false;
      elements.chooseBtn.disabled = false;
      elements.submitBtn.disabled = !capturedBlob || !selectedEvidence();
    }
  }

  function renderSessionSubmissions() {
    if (!elements?.session) return;
    elements.session.replaceChildren();
    if (!sessionSubmissions.length) return;
    const heading = document.createElement("strong");
    heading.textContent = "Submitted this session";
    const list = document.createElement("ul");
    sessionSubmissions.forEach((item) => {
      const li = document.createElement("li");
      const time = item.at.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
      if (item.url) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `${item.label} - ${time}`;
        li.appendChild(link);
      } else {
        li.textContent = `${item.label} - ${time}`;
      }
      list.appendChild(li);
    });
    elements.session.append(heading, list);
  }

  function renderPhotoEvidence(assessment) {
    injectStyles();
    activeAssessment = assessment;
    sessionSubmissions = [];
    setStandardSubmitVisible(false);

    const container = document.getElementById("questions");
    if (!container) return;
    container.replaceChildren();

    const card = document.createElement("section");
    card.className = "photo-evidence-card";

    const title = document.createElement("h3");
    title.textContent = assessment.title || "Photo Evidence Upload";
    const intro = document.createElement("p");
    intro.className = "photo-evidence-intro";
    intro.textContent = assessment.subtitle || "Choose what the photo is evidence for, then take or upload the image.";

    const grid = document.createElement("div");
    grid.className = "photo-evidence-grid";

    const left = document.createElement("div");
    left.className = "photo-evidence-field";
    const label = document.createElement("label");
    label.htmlFor = "photoEvidenceCriteria";
    label.textContent = "What is this photo evidence for?";
    const criteria = document.createElement("select");
    criteria.id = "photoEvidenceCriteria";
    criteria.appendChild(new Option("Select evidence type", ""));
    (assessment.photoEvidence?.options || []).forEach((option) => {
      criteria.appendChild(new Option(option.label, option.id));
    });
    const help = document.createElement("p");
    help.className = "photo-evidence-help";
    help.textContent = "Choose what this photo is evidence for.";
    left.append(label, criteria, help);

    const right = document.createElement("div");
    const note = document.createElement("p");
    note.className = "photo-evidence-camera-note";
    note.textContent = "Photos are resized before upload and stamped with Student ID, standard, evidence type and capture time.";
    right.appendChild(note);
    grid.append(left, right);

    const shell = document.createElement("div");
    shell.className = "photo-camera-shell";
    const stage = document.createElement("div");
    stage.className = "photo-camera-stage";
    const empty = document.createElement("div");
    empty.className = "photo-camera-empty";
    empty.textContent = "Start the live camera or choose an existing photo.";
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.hidden = true;
    const preview = document.createElement("img");
    preview.alt = "Photo evidence preview";
    preview.hidden = true;
    stage.append(empty, video, preview);

    const actions = document.createElement("div");
    actions.className = "photo-camera-actions";
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.textContent = "Start camera";
    const chooseBtn = document.createElement("button");
    chooseBtn.type = "button";
    chooseBtn.textContent = "Choose existing photo";
    const shootBtn = document.createElement("button");
    shootBtn.type = "button";
    shootBtn.className = "photo-shutter";
    shootBtn.textContent = "Take photo";
    shootBtn.disabled = true;
    const flipBtn = document.createElement("button");
    flipBtn.type = "button";
    flipBtn.textContent = "Flip camera";
    flipBtn.disabled = true;
    const retakeBtn = document.createElement("button");
    retakeBtn.type = "button";
    retakeBtn.textContent = "Retake";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.hidden = true;
    actions.append(startBtn, chooseBtn, shootBtn, flipBtn, retakeBtn, fileInput);

    const previewMeta = document.createElement("div");
    previewMeta.className = "photo-preview-meta";
    shell.append(stage, actions, previewMeta);

    const submitRow = document.createElement("div");
    submitRow.className = "photo-evidence-submit-row";
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "photo-evidence-submit";
    submitBtn.textContent = "Submit Photo Evidence";
    submitBtn.disabled = true;
    submitRow.appendChild(submitBtn);

    const status = document.createElement("div");
    status.className = "photo-evidence-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = "Choose an evidence type, then take or upload a photo.";
    const session = document.createElement("div");
    session.className = "photo-evidence-session";

    card.append(title, intro, grid, shell, submitRow, status, session);
    container.appendChild(card);

    elements = { card, criteria, help, video, preview, empty, startBtn, chooseBtn, shootBtn, flipBtn, retakeBtn, fileInput, previewMeta, submitBtn, status, session };

    criteria.addEventListener("change", updateEvidenceHelp);
    startBtn.addEventListener("click", startCamera);
    chooseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => captureFromFile(fileInput.files?.[0]));
    shootBtn.addEventListener("click", captureFromVideo);
    flipBtn.addEventListener("click", flipCamera);
    retakeBtn.addEventListener("click", async () => {
      resetCapturedPhoto();
      await startCamera();
    });
    submitBtn.addEventListener("click", submitPhoto);
  }

  window.loadAssessment = function photoAwareLoadAssessment(...args) {
    endPhotoSession({ restoreSubmit: true });
    const result = originalLoadAssessment.apply(this, args);
    const assessment = currentAssessment();
    if (isPhotoAssessment(assessment)) {
      window.setTimeout(() => {
        try {
          if (typeof currentAssessmentId !== "undefined" && currentAssessmentId !== assessment.id) return;
        } catch (_) {}
        renderPhotoEvidence(assessment);
      }, 0);
    }
    return result;
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("questionSetSelector")?.addEventListener("change", () => endPhotoSession({ restoreSubmit: true }));
    document.getElementById("assessmentSelector")?.addEventListener("change", () => {
      stopCamera();
      resetCapturedPhoto();
      setStandardSubmitVisible(true);
    });
  });

  window.addEventListener("pagehide", () => stopCamera());
})();
