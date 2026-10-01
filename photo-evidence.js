/*
 * PHS Photo / Project Evidence plugin v9 - camera, validation and Drive evidence upload
 * Submission is delegated to submission.js so photos and written evidence update the same unit record.
 * Requires submission.js and the unified assessment-records Apps Script gateway.
 *
 * Load after submission.js in index.html:
 *   <script src="photo-evidence.js?v=9" defer></script>
 *
 * Supports:
 * - live rear/front camera
 * - existing-photo upload
 * - repeatable project-stage evidence
 * - written record instead of photo where the JSON allows it
 * - configurable metadata questions for each evidence type
 * - stamped/resized JPG upload with a direct Drive link in the teacher unit record
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
  let fieldControls = new Map();

  const originalLoadAssessment = window.loadAssessment;
  if (typeof originalLoadAssessment !== "function") {
    console.warn("Photo Evidence plugin: assessment loadAssessment() was not available.");
    return;
  }

  function injectStyles() {
    if (document.getElementById("photoEvidenceStyles")) return;
    const style = document.createElement("style");
    style.id = "photoEvidenceStyles";
    style.textContent = `
      .photo-evidence-card{border:1px solid #d8dee8;border-radius:18px;padding:18px;background:#fff;box-shadow:0 8px 28px rgba(15,23,42,.06)}
      .photo-evidence-card h3{margin:0 0 6px;font-size:1.25rem}
      .photo-evidence-intro{margin:0 0 16px;color:#475569;line-height:1.5}
      .photo-evidence-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.8fr);gap:18px;align-items:start}
      .photo-evidence-field{margin-bottom:14px}
      .photo-evidence-field label{display:block;font-weight:750;margin-bottom:7px}
      .photo-evidence-field select,.photo-evidence-field input,.photo-evidence-field textarea{width:100%;box-sizing:border-box;min-height:48px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;background:#fff;color:#111827}
      .photo-evidence-field textarea{min-height:92px;resize:vertical}
      .photo-evidence-help{margin:8px 0 0;color:#64748b;font-size:.92rem;line-height:1.4}
      .photo-evidence-fields{margin-top:16px;padding-top:4px}
      .photo-evidence-required{color:#7a1f2b;font-weight:700}
      .photo-evidence-method{margin:14px 0;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc}
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
      .photo-evidence-camera-note{margin-top:8px;font-size:.84rem;color:#64748b;line-height:1.4}
      .photo-evidence-written-note{padding:13px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;line-height:1.4;margin-top:10px}
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
    if (stream) stream.getTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
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
    updateSubmitState();
  }

  function clearEvidenceFields() {
    for (const control of fieldControls.values()) control.value = "";
  }

  function endPhotoSession({ restoreSubmit = true } = {}) {
    stopCamera();
    resetCapturedPhoto();
    activeAssessment = null;
    elements = null;
    fieldControls = new Map();
    sessionSubmissions = [];
    if (restoreSubmit) setStandardSubmitVisible(true);
  }

  function selectedEvidence() {
    if (!elements?.criteria) return null;
    const id = elements.criteria.value;
    const options = activeAssessment?.photoEvidence?.options || [];
    return options.find((item) => String(item.id) === String(id)) || null;
  }

  function selectedMethod() {
    return elements?.method?.value || "photo";
  }

  function fieldValidation(def, value) {
    const validation = def?.validation;
    if (!validation?.pattern || !value) return { ok: true, message: "" };
    try {
      const check = new RegExp(String(validation.pattern), String(validation.flags || "i"));
      return {
        ok: check.test(value),
        message: String(validation.message || `Use the required safety terminology for ${def.label || def.id}.`),
      };
    } catch (error) {
      console.warn("Photo evidence validation pattern could not be read", def?.id, error);
      return { ok: true, message: "" };
    }
  }

  function collectFieldValues({ validate = false } = {}) {
    const option = selectedEvidence();
    const defs = option?.fields || [];
    const values = {};
    const missing = [];
    const invalid = [];
    defs.forEach((def) => {
      const control = fieldControls.get(String(def.id));
      const value = String(control?.value || "").trim();
      values[String(def.id)] = value;
      if (validate && def.required && !value) {
        missing.push(def.label || def.id);
        return;
      }
      if (validate && value) {
        const result = fieldValidation(def, value);
        if (!result.ok) invalid.push(result.message);
      }
    });
    if (validate && missing.length) throw new Error(`Complete: ${missing.join(", ")}.`);
    if (validate && invalid.length) throw new Error(invalid[0]);
    return values;
  }

  function updateSubmitState() {
    if (!elements?.submitBtn) return;
    const option = selectedEvidence();
    const method = selectedMethod();
    let fieldsOk = true;
    for (const def of option?.fields || []) {
      if (!def.required) continue;
      const value = String(fieldControls.get(String(def.id))?.value || "").trim();
      if (!value) fieldsOk = false;
    }
    const evidenceOk = method === "written" ? true : !!capturedBlob;
    elements.submitBtn.disabled = !(option && fieldsOk && evidenceOk);
    elements.submitBtn.textContent = method === "written" ? "Submit Written Evidence" : "Submit Photo Evidence";
  }

  function renderEvidenceFields() {
    if (!elements?.fields) return;
    const option = selectedEvidence();
    elements.fields.replaceChildren();
    fieldControls = new Map();
    for (const def of option?.fields || []) {
      const wrap = document.createElement("div");
      wrap.className = "photo-evidence-field";
      const label = document.createElement("label");
      label.htmlFor = `photoField_${def.id}`;
      label.append(document.createTextNode(def.label || def.id));
      if (def.required) {
        const required = document.createElement("span");
        required.className = "photo-evidence-required";
        required.textContent = " *";
        label.appendChild(required);
      }
      let control;
      if (def.type === "textarea") {
        control = document.createElement("textarea");
        control.rows = 3;
      } else {
        control = document.createElement("input");
        control.type = "text";
      }
      control.id = `photoField_${def.id}`;
      control.placeholder = def.placeholder || "";
      control.autocomplete = "off";
      control.addEventListener("input", updateSubmitState);
      fieldControls.set(String(def.id), control);
      wrap.append(label, control);
      if (def.help) {
        const help = document.createElement("div");
        help.className = "photo-evidence-help";
        help.textContent = String(def.help);
        wrap.appendChild(help);
      }
      elements.fields.appendChild(wrap);
    }
    updateSubmitState();
  }

  function updateMethodUi() {
    if (!elements) return;
    const method = selectedMethod();
    const isPhoto = method !== "written";
    elements.cameraShell.hidden = !isPhoto;
    elements.writtenNote.hidden = isPhoto;
    if (!isPhoto) {
      stopCamera();
      resetCapturedPhoto();
    }
    updateSubmitState();
  }

  function updateEvidenceHelp() {
    if (!elements) return;
    stopCamera();
    resetCapturedPhoto();
    const option = selectedEvidence();
    elements.help.textContent = option?.help || "Choose what this evidence is for.";
    renderEvidenceFields();
    updateSubmitState();
  }

  async function startCamera() {
    if (!elements) return;
    if (!navigator.mediaDevices?.getUserMedia) return setStatus("This browser cannot open the live camera. Use Choose existing photo instead.", "error");
    if (!window.isSecureContext && location.hostname !== "localhost" && location.protocol !== "file:") {
      return setStatus("Live camera access needs HTTPS. Use Choose existing photo or open the secure assessment site.", "error");
    }
    stopCamera();
    resetCapturedPhoto();
    setStatus("Opening camera…");
    try {
      const facingMode = useFrontCamera ? "user" : "environment";
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
      setStatus("Camera ready. Take the photo when the evidence is clearly visible.");
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
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
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
    return { studentName, studentId, teacherId, teacherName, teacherEmail, questionSetId, unitStandard: `${standardPrefix} ${standardNumber}`.trim() };
  }

  function drawStamp(ctx, width, height, evidenceLabel, identity, timestamp, fieldValues) {
    const base = Math.min(width, height);
    const fontSize = Math.max(18, Math.round(base * 0.028));
    const lineHeight = Math.round(fontSize * 1.25);
    const padX = Math.round(fontSize * 0.7);
    const padY = Math.round(fontSize * 0.55);
    const outer = Math.max(12, Math.round(base * 0.018));
    const stage = String(fieldValues?.stage || fieldValues?.area || "").trim();
    const lines = [`${identity.studentId} · ${identity.unitStandard}`, evidenceLabel];
    if (stage) lines.push(stage.slice(0, 80));
    lines.push(new Date(timestamp).toLocaleString("en-NZ"));
    ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.textBaseline = "top";
    const maxText = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const boxWidth = Math.min(width * 0.9, maxText + padX * 2);
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
          fetch(canvas.toDataURL("image/jpeg", quality)).then((response) => response.blob()).then(resolve, reject);
        } catch (error) { reject(error); }
      }, "image/jpeg", quality);
    });
  }

  async function makeEvidenceBlob(drawSource, sourceWidth, sourceHeight) {
    const option = selectedEvidence();
    if (!option) throw new Error("Choose what this evidence is for first.");
    const identity = identitySnapshot();
    if (!identity.studentId) throw new Error("Enter your Student ID first.");
    const fieldValues = collectFieldValues({ validate: true });
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
    drawStamp(ctx, fitted.width, fitted.height, option.label, identity, timestamp, fieldValues);
    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error("The prepared photo is too large. Try taking the photo again at a lower camera resolution.");
    capturedAt = timestamp;
    return blob;
  }

  async function captureFromVideo() {
    if (!elements?.video?.videoWidth || !stream) return setStatus("Camera is not ready yet.", "error");
    try {
      elements.shootBtn.disabled = true;
      const video = elements.video;
      const blob = await makeEvidenceBlob((ctx, w, h) => ctx.drawImage(video, 0, 0, w, h), video.videoWidth, video.videoHeight);
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
    if (!file.type?.startsWith("image/")) return setStatus("Please choose an image file.", "error");
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      try {
        const blob = await makeEvidenceBlob((ctx, w, h) => ctx.drawImage(image, 0, 0, w, h), image.naturalWidth || image.width, image.naturalHeight || image.height);
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
    updateSubmitState();
    setStatus("Photo ready. Check the image and your notes, then submit the evidence.");
  }

  function setStatus(message, type = "") {
    if (!elements?.status) return;
    elements.status.textContent = message;
    elements.status.className = `photo-evidence-status${type ? ` ${type}` : ""}`;
  }

  async function submitEvidence() {
    const option = selectedEvidence();
    const method = selectedMethod();
    if (!option) return setStatus("Choose what this evidence is for.", "error");

    let fieldValues;
    try { fieldValues = collectFieldValues({ validate: true }); }
    catch (error) { return setStatus(error.message, "error"); }

    if (method !== "written" && !capturedBlob) return setStatus("Take or choose a photo first.", "error");

    const identity = identitySnapshot();
    if (!identity.studentName) return setStatus("Enter your name first.", "error");
    if (!/^\d{3,6}$/.test(identity.studentId)) return setStatus("Enter a valid Student ID first.", "error");
    if (!identity.teacherId) return setStatus("Select your teacher first.", "error");
    if (!navigator.onLine) return setStatus("You are offline. Reconnect before submitting this evidence.", "error");
    if (!window.PHSSubmission?.submitPhotoEvidence) {
      return setStatus("The teacher-submission module is not available. Reload the page and try again.", "error");
    }

    elements.submitBtn.disabled = true;
    elements.startBtn.disabled = true;
    elements.chooseBtn.disabled = true;
    setStatus(method === "written" ? "Submitting written evidence…" : "Uploading photo evidence…");

    const mainDescriptor = fieldValues.stage || fieldValues.area || option.label;

    try {
      try { saveStudentInfo(); } catch (_) {}
      const status = await window.PHSSubmission.submitPhotoEvidence({
        assessment: activeAssessment,
        option,
        method,
        fieldValues,
        descriptor: mainDescriptor,
        blob: method === "written" ? null : capturedBlob,
        capturedAt: capturedAt || new Date().toISOString(),
      });

      sessionSubmissions.push({
        label: mainDescriptor,
        method,
        at: new Date(),
        url: String(status?.photoUrl || ""),
      });
      renderSessionSubmissions();
      setStatus(`Saved under Student ID ${identity.studentId}: ${mainDescriptor}`, "success");
      try { if (typeof showToast === "function") showToast("Evidence saved and added to the unit record."); } catch (_) {}
      resetCapturedPhoto();
      clearEvidenceFields();
      updateSubmitState();
    } catch (error) {
      console.error("Evidence submission failed", error);
      setStatus(error.message || "Evidence submission failed. Try again.", "error");
    } finally {
      elements.startBtn.disabled = false;
      elements.chooseBtn.disabled = false;
      updateSubmitState();
    }
  }

  function renderSessionSubmissions() {
    if (!elements?.session) return;
    elements.session.replaceChildren();
    if (!sessionSubmissions.length) return;
    const heading = document.createElement("strong");
    heading.textContent = "Evidence submitted this session";
    const list = document.createElement("ul");
    sessionSubmissions.forEach((item, index) => {
      const li = document.createElement("li");
      const time = item.at.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
      const prefix = `${index + 1}. ${item.label} (${item.method === "written" ? "written record" : "photo"}) - ${time}`;
      if (item.url) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = prefix;
        li.appendChild(link);
      } else li.textContent = prefix;
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
    title.textContent = assessment.title || "Evidence Upload";
    const intro = document.createElement("p");
    intro.className = "photo-evidence-intro";
    intro.textContent = assessment.subtitle || "Record the evidence for this part of your project.";

    const grid = document.createElement("div");
    grid.className = "photo-evidence-grid";
    const left = document.createElement("div");
    left.className = "photo-evidence-field";
    const label = document.createElement("label");
    label.htmlFor = "photoEvidenceCriteria";
    label.textContent = "What is this evidence for?";
    const criteria = document.createElement("select");
    criteria.id = "photoEvidenceCriteria";
    const options = assessment.photoEvidence?.options || [];
    if (options.length > 1) criteria.appendChild(new Option("Select evidence type", ""));
    options.forEach((option) => criteria.appendChild(new Option(option.label, option.id)));
    if (options.length === 1) criteria.value = String(options[0].id);
    const help = document.createElement("p");
    help.className = "photo-evidence-help";
    left.append(label, criteria, help);

    const right = document.createElement("div");
    const note = document.createElement("p");
    note.className = "photo-evidence-camera-note";
    note.textContent = "Photo records are resized before upload and stamped with Student ID, standard, evidence type and capture time. Every submitted record is saved to Drive and linked into the teacher unit record.";
    right.appendChild(note);
    grid.append(left, right);

    const methodWrap = document.createElement("div");
    methodWrap.className = "photo-evidence-field photo-evidence-method";
    const methodLabel = document.createElement("label");
    methodLabel.htmlFor = "photoEvidenceMethod";
    methodLabel.textContent = assessment.photoEvidence?.methodLabel || "Evidence method";
    const method = document.createElement("select");
    method.id = "photoEvidenceMethod";
    method.appendChild(new Option(assessment.photoEvidence?.photoMethodLabel || "Photo evidence", "photo"));
    if (assessment.photoEvidence?.allowWrittenRecord) {
      method.appendChild(new Option(assessment.photoEvidence?.writtenMethodLabel || "Written record", "written"));
    }
    methodWrap.append(methodLabel, method);

    const fields = document.createElement("div");
    fields.className = "photo-evidence-fields";

    const writtenNote = document.createElement("div");
    writtenNote.className = "photo-evidence-written-note";
    writtenNote.hidden = true;
    writtenNote.textContent = "Written record selected. Complete the stage details below. A photo is not required for this record.";

    const cameraShell = document.createElement("div");
    cameraShell.className = "photo-camera-shell";
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
    preview.alt = "Evidence photo preview";
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
    cameraShell.append(stage, actions, previewMeta);

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
    status.textContent = "Complete the evidence details, then take/upload a photo or choose written record if allowed.";
    const session = document.createElement("div");
    session.className = "photo-evidence-session";

    card.append(title, intro, grid, methodWrap, fields, writtenNote, cameraShell, submitRow, status, session);
    container.appendChild(card);

    elements = { card, criteria, help, method, fields, writtenNote, cameraShell, video, preview, empty, startBtn, chooseBtn, shootBtn, flipBtn, retakeBtn, fileInput, previewMeta, submitBtn, status, session };

    criteria.addEventListener("change", updateEvidenceHelp);
    method.addEventListener("change", updateMethodUi);
    startBtn.addEventListener("click", startCamera);
    chooseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => captureFromFile(fileInput.files?.[0]));
    shootBtn.addEventListener("click", captureFromVideo);
    flipBtn.addEventListener("click", flipCamera);
    retakeBtn.addEventListener("click", async () => { resetCapturedPhoto(); await startCamera(); });
    submitBtn.addEventListener("click", submitEvidence);

    updateEvidenceHelp();
    updateMethodUi();
  }

  window.loadAssessment = function photoAwareLoadAssessment(...args) {
    endPhotoSession({ restoreSubmit: true });
    const result = originalLoadAssessment.apply(this, args);
    const assessment = currentAssessment();
    if (isPhotoAssessment(assessment)) {
      window.setTimeout(() => {
        try { if (typeof currentAssessmentId !== "undefined" && currentAssessmentId !== assessment.id) return; } catch (_) {}
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
