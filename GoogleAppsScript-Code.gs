/**
 * PHS Assessment & Evidence - Unified Assessment Records Gateway v2.0
 *
 * Purpose
 * -------
 * Receives a complete unit snapshot from QuizMaster and keeps ONE teacher-facing
 * row per student for each Teacher + Unit Standard tab.
 *
 * Each snapshot contains:
 *   - every defined question from the unit, answered or blank
 *   - every assessment section and its current progress/result
 *   - confirmed photo/evidence records and links
 *
 * Spreadsheet layout
 * ------------------
 *   Assessment Submissions - <year>
 *     _Submission Log
 *     RNR - SS 40540
 *     RY - SS 40540
 *     ...
 *
 * Teacher-standard tabs:
 *   Row 1 = stable machine keys
 *   Row 2 = readable labels
 *   Row 3+ = one row per student
 */

const UNIT_SHEET_CONFIG = {
  GATEWAY_VERSION: '2.0.0',
  TIME_ZONE: 'Pacific/Auckland',
  EXPECTED_APP_PREFIX: 'pukekohetech-',
  ALLOWED_ROOT_PREFIX: 'PHS ',
  SPREADSHEET_PREFIX: 'Assessment Records',
  LOG_SHEET: '_Submission Log',
  CACHE_TTL_SECONDS: 21600,
  DESTINATION_PROPERTY_PREFIX: 'PHS_ASSESSMENT_RECORDS_DEST_',
  MAX_QUESTIONS: 1000,
  MAX_EVIDENCE: 500,
  MAX_ANSWER_CHARS: 45000,
  MAX_LABEL_CHARS: 1400,
  MAX_IMAGE_BYTES: 12 * 1024 * 1024,
};

const UNIT_FIXED_COLUMNS = [
  ['__studentId', 'Student ID'],
  ['__studentName', 'Student'],
  ['__teacher', 'Teacher'],
  ['__unitStandard', 'Unit Standard'],
  ['__unitTitle', 'Unit title'],
  ['__questionSetId', 'Question Set ID'],
  ['__overallProgress', 'Overall progress'],
  ['__answeredQuestions', 'Answered questions'],
  ['__evidenceCount', 'Evidence records'],
  ['__lastAssessment', 'Last submitted section'],
  ['__lastResult', 'Last result'],
  ['__lastSubmitted', 'Last submitted'],
  ['__submissions', 'Sheet updates'],
  ['__status', 'Status'],
];

const UNIT_LOG_HEADERS = [
  'Submission ID',
  'Submitted At',
  'Trigger',
  'Student ID',
  'Student',
  'Teacher ID',
  'Teacher',
  'Unit Standard',
  'Question Set ID',
  'Assessment ID',
  'Assessment',
  'Score',
  'Total Marks',
  'Percentage',
  'Questions',
  'Answered',
  'Evidence',
  'Sheet',
  'Student Row',
  'App Version',
];

function setup() {
  DriveApp.getRootFolder().getId();
  SpreadsheetApp.flush();
  return {
    ok: true,
    state: 'ready',
    mode: 'assessment-records',
    gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
    message: 'Assessment records gateway authorised.',
    year: currentYear_(),
  };
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = params.callback || '';
  try {
    const action = String(params.action || 'health').toLowerCase();
    if (action === 'status') {
      const fastOnly = String(params.fast || '') === '1';
      const rootName = cleanText_(params.rootName, 100);
      return output_(getStatus_(String(params.submissionId || ''), fastOnly, rootName), callback);
    }

    return output_({
      ok: true,
      state: 'ready',
      mode: 'assessment-records',
      gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
      message: 'PHS assessment records gateway is ready.',
      year: currentYear_(),
    }, callback);
  } catch (error) {
    return output_({ ok: false, state: 'error', message: errorMessage_(error) }, callback);
  }
}

function doPost(e) {
  let submissionId = '';
  let claimed = false;
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('Missing request body.');
    const payload = JSON.parse(e.postData.contents);
    submissionId = cleanText_(payload.submissionId, 160);
    if (!submissionId) throw new Error('Missing submissionId.');

    const claim = claimSubmission_(submissionId);
    if (!claim.claimed) return output_(claim.status, '');
    claimed = true;

    const mode = String(payload.submissionMode || '').trim().toLowerCase();
    let result;
    if (mode === 'unit-sheet') {
      validateUnitPayload_(payload);
      result = saveUnitSnapshot_(payload);
    } else if (mode === 'photo-evidence') {
      validatePhotoPayload_(payload);
      result = savePhotoEvidence_(payload);
    } else {
      throw new Error('Unsupported submission mode.');
    }
    setStatus_(submissionId, result);
    return output_(result, '');
  } catch (error) {
    const result = {
      state: 'error',
      confirmed: false,
      gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
      submissionId,
      message: errorMessage_(error),
    };
    if (submissionId && claimed) setStatus_(submissionId, result);
    return output_(result, '');
  }
}

function claimSubmission_(submissionId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const key = statusCacheKey_(submissionId);
    const raw = cache.get(key);
    if (raw) {
      try {
        const status = JSON.parse(raw);
        if (status && (status.state === 'confirmed' || status.state === 'duplicate')) {
          return {
            claimed: false,
            status: Object.assign({}, status, {
              state: 'duplicate',
              confirmed: true,
              message: 'This exact submission was already received.',
            }),
          };
        }
        if (status && status.state === 'processing') {
          const ageMs = Date.now() - Number(status.startedAtMs || 0);
          if (ageMs >= 0 && ageMs < 120000) return { claimed: false, status };
        }
      } catch (_) {}
    }

    const status = {
      state: 'processing',
      confirmed: false,
      submissionId,
      gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
      startedAtMs: Date.now(),
      message: 'Assessment record is being saved.',
    };
    cache.put(key, JSON.stringify(status), UNIT_SHEET_CONFIG.CACHE_TTL_SECONDS);
    return { claimed: true, status };
  } finally {
    lock.releaseLock();
  }
}

function validateUnitPayload_(payload) {
  const appId = cleanText_(payload.appId, 100);
  if (UNIT_SHEET_CONFIG.EXPECTED_APP_PREFIX && !appId.startsWith(UNIT_SHEET_CONFIG.EXPECTED_APP_PREFIX)) {
    throw new Error('Unrecognised assessment app.');
  }

  [
    'submissionId',
    'studentName',
    'studentId',
    'teacherName',
    'teacherId',
    'unitStandard',
    'questionSetId',
    'storageRootName',
  ].forEach((key) => {
    if (!String(payload[key] || '').trim()) throw new Error(`Missing ${key}.`);
  });

  if (!/^\d{3,6}$/.test(String(payload.studentId || '').trim())) throw new Error('Student ID is invalid.');
  normaliseCollectionName_(payload.storageRootName);

  const snapshot = payload.unitSnapshot;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Missing complete unit snapshot.');
  if (!Array.isArray(snapshot.assessments)) throw new Error('Unit snapshot assessments must be an array.');
  if (!Array.isArray(snapshot.questions)) throw new Error('Unit snapshot questions must be an array.');
  if (!Array.isArray(snapshot.evidenceDefinitions)) throw new Error('Unit snapshot evidenceDefinitions must be an array.');
  if (!Array.isArray(snapshot.evidence)) throw new Error('Unit snapshot evidence must be an array.');
  if (snapshot.questions.length > UNIT_SHEET_CONFIG.MAX_QUESTIONS) throw new Error('Too many questions in one unit snapshot.');
  if (snapshot.evidence.length > UNIT_SHEET_CONFIG.MAX_EVIDENCE) throw new Error('Too many evidence records in one unit snapshot.');
}

function validatePhotoPayload_(payload) {
  const appId = cleanText_(payload.appId, 100);
  if (UNIT_SHEET_CONFIG.EXPECTED_APP_PREFIX && !appId.startsWith(UNIT_SHEET_CONFIG.EXPECTED_APP_PREFIX)) {
    throw new Error('Unrecognised assessment app.');
  }

  [
    'submissionId', 'studentName', 'studentId', 'teacherName', 'teacherId',
    'unitStandard', 'questionSetId', 'assessmentId', 'assessmentTitle', 'storageRootName'
  ].forEach((key) => {
    if (!String(payload[key] || '').trim()) throw new Error(`Missing ${key}.`);
  });

  if (!/^\d{3,6}$/.test(String(payload.studentId || '').trim())) throw new Error('Student ID is invalid.');
  normaliseCollectionName_(payload.storageRootName);

  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== 'object') throw new Error('Missing photo evidence details.');
  if (!String(evidence.optionId || '').trim()) throw new Error('Missing evidence option ID.');

  const method = cleanText_(evidence.method, 20) || 'photo';
  if (method !== 'written') {
    const imageText = String(evidence.imageBase64 || '');
    if (!imageText) throw new Error('The photo file was empty.');
    const estimatedBytes = Math.floor(imageText.length * 0.75);
    if (estimatedBytes > UNIT_SHEET_CONFIG.MAX_IMAGE_BYTES) throw new Error('The photo is too large for this gateway.');
  }

  validateUnitPayload_(Object.assign({}, payload, { submissionMode: 'unit-sheet' }));
}

function savePhotoEvidence_(payload) {
  const collectionName = normaliseCollectionName_(payload.storageRootName);
  const destination = getOrCreateDestination_(collectionName);
  const evidence = payload.evidence || {};
  const method = cleanText_(evidence.method, 20) || 'photo';
  const studentId = cleanText_(payload.studentId, 60);
  const studentName = cleanText_(payload.studentName, 120);
  const teacherId = cleanText_(payload.teacherId, 40) || 'Teacher';
  const teacherName = cleanText_(payload.teacherName, 100) || teacherId;
  const standard = normaliseStandard_(payload.unitStandard);
  const questionSetId = cleanText_(payload.questionSetId, 100);
  const submissionId = cleanText_(payload.submissionId, 160);
  const optionId = cleanText_(evidence.optionId, 120) || 'evidence';
  const descriptor = cleanText_(evidence.descriptor, 180) || cleanText_(evidence.optionLabel, 180) || optionId;

  let photoUrl = '';
  if (method !== 'written') {
    const bytes = Utilities.base64Decode(String(evidence.imageBase64 || ''));
    if (!bytes.length) throw new Error('The photo file was empty.');
    if (bytes.length > UNIT_SHEET_CONFIG.MAX_IMAGE_BYTES) throw new Error('The photo is too large for this gateway.');

    const teacherFolder = getOrCreateFolder_(destination.root, safeFolderPart_(`${teacherId} - ${teacherName}`, 120));
    const studentFolder = getOrCreateFolder_(teacherFolder, safeFolderPart_(`${studentId} - ${studentName}`, 120));
    const unitFolder = getOrCreateFolder_(studentFolder, safeFolderPart_(questionSetId || standard, 100));
    const evidenceFolder = getOrCreateFolder_(unitFolder, 'Evidence Photos');
    const shortId = safeFilePart_(submissionId, 70);
    const fileName = `${safeFilePart_(studentId, 40)}_${safeFilePart_(optionId, 50)}_${safeFilePart_(descriptor, 70)}_${shortId}.jpg`;
    const blob = Utilities.newBlob(bytes, 'image/jpeg', fileName);
    const file = replaceFile_(evidenceFolder, fileName, blob);
    photoUrl = file.getUrl();
  }

  const snapshot = payload.unitSnapshot || {};
  if (!Array.isArray(snapshot.evidence)) snapshot.evidence = [];
  let record = snapshot.evidence.find((item) => String(item?.submissionId || '') === submissionId);
  if (!record) {
    record = {
      assessmentId: cleanText_(payload.assessmentId, 140),
      optionId,
      optionLabel: cleanText_(evidence.optionLabel, 220),
      descriptor,
      method,
      submissionId,
      submittedAt: cleanText_(payload.submittedAt, 80) || new Date().toISOString(),
      state: 'confirmed',
      repeatable: evidence.repeatable !== false,
      fieldValues: evidence.fieldValues || {},
    };
    snapshot.evidence.push(record);
  }
  record.state = 'confirmed';
  record.photoUrl = photoUrl;
  record.pdfUrl = '';
  record.fieldValues = evidence.fieldValues || record.fieldValues || {};
  record.submittedAt = cleanText_(payload.submittedAt, 80) || record.submittedAt || new Date().toISOString();

  snapshot.totals = snapshot.totals || {};
  snapshot.totals.evidenceCount = snapshot.evidence.length;

  const sheetPayload = Object.assign({}, payload, {
    submissionMode: 'unit-sheet',
    trigger: 'photoEvidence',
    score: 0,
    totalMarks: 0,
    percentage: 0,
    unitSnapshot: snapshot,
  });

  const result = saveUnitSnapshot_(sheetPayload);
  result.photoUrl = photoUrl;
  result.message = method === 'written'
    ? 'Written evidence saved and the unit record was updated.'
    : 'Photo saved to Drive and linked into the unit record.';
  return result;
}

function saveUnitSnapshot_(payload) {
  const collectionName = normaliseCollectionName_(payload.storageRootName);
  const destination = getOrCreateDestination_(collectionName);
  const spreadsheet = destination.spreadsheet;

  const teacherId = cleanText_(payload.teacherId, 40) || 'Teacher';
  const teacherName = cleanText_(payload.teacherName, 100) || teacherId;
  const studentId = cleanText_(payload.studentId, 60);
  const studentName = cleanText_(payload.studentName, 120);
  const standard = normaliseStandard_(payload.unitStandard);
  const questionSetId = cleanText_(payload.questionSetId, 100);
  const assessmentId = cleanText_(payload.assessmentId, 120) || 'unit-snapshot';
  const assessmentTitle = cleanText_(payload.assessmentTitle, 220) || assessmentId;
  const submissionId = cleanText_(payload.submissionId, 160);
  const trigger = cleanText_(payload.trigger, 40) || 'assessment';
  const now = new Date();

  const snapshot = normaliseSnapshot_(payload.unitSnapshot);
  const resultText = Number(payload.totalMarks || 0) > 0
    ? `${Number(payload.score || 0)}/${Number(payload.totalMarks || 0)} (${Number(payload.percentage || 0)}%)`
    : trigger === 'photoEvidence' ? 'Photo evidence updated' : '';

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const logSheet = getOrCreateLogSheet_(spreadsheet);
    const existingLogRow = findSubmissionLogRow_(logSheet, submissionId);
    if (existingLogRow) {
      const old = logSheet.getRange(existingLogRow, 1, 1, UNIT_LOG_HEADERS.length).getDisplayValues()[0];
      return {
        state: 'duplicate',
        confirmed: true,
        gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
        message: 'This exact submission was already received.',
        submissionId,
        collectionName,
        year: destination.year,
        spreadsheetUrl: spreadsheet.getUrl(),
        tabName: String(old[17] || ''),
        studentRow: Number(old[18] || 0),
      };
    }

    const tabName = safeSheetName_(`${teacherId} - ${standard}`);
    const sheet = getOrCreateTeacherStandardSheet_(spreadsheet, tabName);

    const assessmentColumns = [];
    snapshot.assessments.forEach((assessment) => {
      const base = `a:${assessment.assessmentId}`;
      assessmentColumns.push([`${base}:status`, `${assessment.assessmentTitle} - Status`]);
      assessmentColumns.push([`${base}:result`, `${assessment.assessmentTitle} - Result`]);
      assessmentColumns.push([`${base}:submitted`, `${assessment.assessmentTitle} - Last submitted`]);
    });

    const questionColumns = snapshot.questions.map((q) => [
      `q:${q.assessmentId}:${q.questionId}`,
      `${q.assessmentTitle} | ${q.questionId} - ${q.question}${q.maxPoints ? ` [${q.maxPoints} mark${q.maxPoints === 1 ? '' : 's'}]` : ''}`,
    ]);

    const evidenceColumns = [];
    snapshot.evidenceDefinitions.forEach((def) => {
      evidenceColumns.push([
        `e:${def.assessmentId}:${def.optionId}`,
        `${def.assessmentTitle} | ${def.optionLabel} - Photo/evidence file link(s)`,
      ]);
      (def.fields || []).forEach((field) => {
        evidenceColumns.push([
          `ef:${def.assessmentId}:${def.optionId}:${field.id}`,
          `${def.assessmentTitle} | ${def.optionLabel} - ${field.label}`,
        ]);
      });
    });

    const columnMap = ensureColumns_(sheet, UNIT_FIXED_COLUMNS.concat(assessmentColumns, questionColumns, evidenceColumns));
    const row = findOrCreateStudentRow_(sheet, studentId, columnMap);
    const lastColumn = sheet.getLastColumn();
    const values = sheet.getRange(row, 1, 1, lastColumn).getValues()[0];

    // Clear previous unit-dynamic values first. This prevents stale answers or
    // stale repeat-group/photo links remaining after a learner removes/clears work.
    columnMap.forEach((column, key) => {
      if (key.startsWith('a:') || key.startsWith('q:') || key.startsWith('e:') || key.startsWith('ef:')) values[column - 1] = '';
    });

    setValueByKey_(values, columnMap, '__studentId', forceText_(studentId));
    setValueByKey_(values, columnMap, '__studentName', sheetText_(studentName));
    setValueByKey_(values, columnMap, '__teacher', sheetText_(`${teacherId} - ${teacherName}`));
    setValueByKey_(values, columnMap, '__unitStandard', sheetText_(standard));
    setValueByKey_(values, columnMap, '__unitTitle', sheetText_(snapshot.unitTitle || ''));
    setValueByKey_(values, columnMap, '__questionSetId', sheetText_(questionSetId));

    const totals = snapshot.totals || {};
    setValueByKey_(
      values,
      columnMap,
      '__overallProgress',
      sheetText_(`${Number(totals.submittedSections || 0)}/${Number(totals.assessmentCount || snapshot.assessments.length)} sections with submitted work`)
    );
    setValueByKey_(
      values,
      columnMap,
      '__answeredQuestions',
      sheetText_(`${Number(totals.answeredQuestionCount || 0)}/${Number(totals.questionCount || snapshot.questions.length)}`)
    );
    setValueByKey_(values, columnMap, '__evidenceCount', Number(totals.evidenceCount || snapshot.evidence.length));
    setValueByKey_(values, columnMap, '__lastAssessment', sheetText_(assessmentTitle));
    setValueByKey_(values, columnMap, '__lastResult', sheetText_(resultText));
    setValueByKey_(values, columnMap, '__lastSubmitted', now);

    const submissionsColumn = columnMap.get('__submissions');
    const previousSubmissions = submissionsColumn ? Number(values[submissionsColumn - 1] || 0) : 0;
    setValueByKey_(values, columnMap, '__submissions', previousSubmissions + 1);
    setValueByKey_(values, columnMap, '__status', 'Confirmed');

    snapshot.assessments.forEach((assessment) => {
      const base = `a:${assessment.assessmentId}`;
      setValueByKey_(values, columnMap, `${base}:status`, sheetText_(assessment.status));
      setValueByKey_(values, columnMap, `${base}:result`, sheetText_(assessment.result));
      setValueByKey_(values, columnMap, `${base}:submitted`, dateValueOrBlank_(assessment.lastSubmitted));
    });

    snapshot.questions.forEach((q) => {
      setValueByKey_(values, columnMap, `q:${q.assessmentId}:${q.questionId}`, sheetText_(q.answer));
    });

    snapshot.evidenceDefinitions.forEach((def) => {
      const matches = snapshot.evidence.filter((record) =>
        record.assessmentId === def.assessmentId && record.optionId === def.optionId
      );
      const lines = matches.map((record, index) => {
        const descriptor = record.descriptor || record.optionLabel || `Evidence ${index + 1}`;
        const method = record.method === 'written' ? 'written record' : 'photo';
        const url = record.photoUrl || record.pdfUrl || '';
        return url
          ? `${index + 1}. ${descriptor} (${method}) - ${url}`
          : `${index + 1}. ${descriptor} (${method})`;
      });
      setValueByKey_(values, columnMap, `e:${def.assessmentId}:${def.optionId}`, sheetText_(lines.join('\n')));

      (def.fields || []).forEach((field) => {
        const detailLines = matches
          .map((record, index) => {
            const value = String(record.fieldValues?.[field.id] || '').trim();
            if (!value) return '';
            const descriptor = record.descriptor || record.optionLabel || `Evidence ${index + 1}`;
            return `${index + 1}. ${descriptor}: ${value}`;
          })
          .filter(Boolean);
        setValueByKey_(
          values,
          columnMap,
          `ef:${def.assessmentId}:${def.optionId}:${field.id}`,
          sheetText_(detailLines.join('\n'))
        );
      });
    });

    sheet.getRange(row, 1, 1, lastColumn).setValues([values]);
    const studentIdColumn = Number(columnMap.get('__studentId') || 1);
    sheet.getRange(row, studentIdColumn).setNumberFormat('@');
    sheet.getRange(row, 1, 1, lastColumn).setWrap(true).setVerticalAlignment('top');

    appendSubmissionLog_(logSheet, [
      forceText_(submissionId),
      now,
      sheetText_(trigger),
      forceText_(studentId),
      sheetText_(studentName),
      sheetText_(teacherId),
      sheetText_(teacherName),
      sheetText_(standard),
      sheetText_(questionSetId),
      sheetText_(assessmentId),
      sheetText_(assessmentTitle),
      Number(payload.score || 0),
      Number(payload.totalMarks || 0),
      Number(payload.percentage || 0),
      snapshot.questions.length,
      Number(snapshot.totals?.answeredQuestionCount || 0),
      snapshot.evidence.length,
      sheetText_(tabName),
      row,
      sheetText_(payload.appVersion || ''),
    ]);

    SpreadsheetApp.flush();

    return {
      state: 'confirmed',
      confirmed: true,
      gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
      message: 'Assessment record saved to Google Sheets.',
      submissionId,
      collectionName,
      year: destination.year,
      rootFolderName: destination.rootFolderName,
      spreadsheetUrl: spreadsheet.getUrl(),
      tabName,
      studentRow: row,
      questionCount: snapshot.questions.length,
      answeredQuestionCount: Number(snapshot.totals?.answeredQuestionCount || 0),
      evidenceCount: snapshot.evidence.length,
    };
  } finally {
    lock.releaseLock();
  }
}

function normaliseSnapshot_(snapshot) {
  const questionSeen = new Set();
  const questions = (snapshot.questions || []).map((raw, index) => {
    const assessmentId = cleanText_(raw?.assessmentId, 140);
    const questionId = cleanText_(raw?.questionId, 220);
    if (!assessmentId || !questionId) throw new Error(`Question ${index + 1} is missing an ID.`);
    const key = `${assessmentId}|${questionId}`;
    if (questionSeen.has(key)) throw new Error(`Duplicate question in unit snapshot: ${key}`);
    questionSeen.add(key);
    return {
      assessmentId,
      assessmentTitle: cleanText_(raw?.assessmentTitle, 220),
      questionId,
      question: cleanText_(raw?.question, UNIT_SHEET_CONFIG.MAX_LABEL_CHARS),
      answer: String(raw?.answer == null ? '' : raw.answer).slice(0, UNIT_SHEET_CONFIG.MAX_ANSWER_CHARS),
      earned: Number(raw?.earned || 0),
      maxPoints: Number(raw?.maxPoints || 0),
    };
  });

  const assessments = (snapshot.assessments || []).map((raw, index) => ({
    assessmentId: cleanText_(raw?.assessmentId, 140) || `assessment-${index + 1}`,
    assessmentTitle: cleanText_(raw?.assessmentTitle, 220) || `Assessment ${index + 1}`,
    status: cleanText_(raw?.status, 80),
    result: cleanText_(raw?.result, 120),
    lastSubmitted: cleanText_(raw?.lastSubmitted, 80),
  }));

  const evidenceDefinitions = (snapshot.evidenceDefinitions || []).map((raw, index) => ({
    assessmentId: cleanText_(raw?.assessmentId, 140),
    assessmentTitle: cleanText_(raw?.assessmentTitle, 220),
    optionId: cleanText_(raw?.optionId, 140) || `evidence-${index + 1}`,
    optionLabel: cleanText_(raw?.optionLabel, 220) || `Evidence ${index + 1}`,
    fields: (Array.isArray(raw?.fields) ? raw.fields : []).map((field, fieldIndex) => ({
      id: cleanText_(field?.id, 140) || `field-${fieldIndex + 1}`,
      label: cleanText_(field?.label, 220) || `Evidence detail ${fieldIndex + 1}`,
    })),
  }));

  const evidence = (snapshot.evidence || []).map((raw) => ({
    assessmentId: cleanText_(raw?.assessmentId, 140),
    optionId: cleanText_(raw?.optionId, 140),
    optionLabel: cleanText_(raw?.optionLabel, 220),
    descriptor: cleanText_(raw?.descriptor, 500),
    method: cleanText_(raw?.method, 40),
    submissionId: cleanText_(raw?.submissionId, 180),
    submittedAt: cleanText_(raw?.submittedAt, 80),
    state: cleanText_(raw?.state, 40),
    photoUrl: safeUrl_(raw?.photoUrl),
    pdfUrl: safeUrl_(raw?.pdfUrl),
    fieldValues: normaliseFieldValues_(raw?.fieldValues),
  }));

  return {
    unitTitle: cleanText_(snapshot.unitTitle, 300),
    assessments,
    questions,
    evidenceDefinitions,
    evidence,
    totals: snapshot.totals && typeof snapshot.totals === 'object' ? snapshot.totals : {},
  };
}

function normaliseFieldValues_(value) {
  const output = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  Object.keys(value).slice(0, 100).forEach((key) => {
    const cleanKey = cleanText_(key, 140);
    if (!cleanKey) return;
    output[cleanKey] = String(value[key] == null ? '' : value[key]).slice(0, UNIT_SHEET_CONFIG.MAX_ANSWER_CHARS);
  });
  return output;
}

function currentYear_() {
  return Utilities.formatDate(new Date(), UNIT_SHEET_CONFIG.TIME_ZONE, 'yyyy');
}

function normaliseCollectionName_(value) {
  let name = cleanText_(value, 100);
  name = name.replace(/\s+-\s+\d{4}\s*$/, '').trim();
  name = safeFolderPart_(name, 90);
  if (!name) throw new Error('Evidence collection name is missing.');
  if (UNIT_SHEET_CONFIG.ALLOWED_ROOT_PREFIX && !name.startsWith(UNIT_SHEET_CONFIG.ALLOWED_ROOT_PREFIX)) {
    throw new Error(`Evidence collection name must begin with "${UNIT_SHEET_CONFIG.ALLOWED_ROOT_PREFIX}".`);
  }
  return name;
}

function destinationPropertyKey_(collectionName, year) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    `${collectionName.toLowerCase()}|${year}`
  );
  const token = Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '').slice(0, 40);
  return `${UNIT_SHEET_CONFIG.DESTINATION_PROPERTY_PREFIX}${token}`;
}

function getOrCreateDestination_(collectionName) {
  const year = currentYear_();
  const rootFolderName = `${collectionName} - ${year}`;
  const propertyKey = destinationPropertyKey_(collectionName, year);
  const cached = PropertiesService.getScriptProperties().getProperty(propertyKey);

  if (cached) {
    try {
      const record = JSON.parse(cached);
      if (record && record.rootFolderId && record.spreadsheetId) {
        return {
          root: DriveApp.getFolderById(record.rootFolderId),
          spreadsheet: SpreadsheetApp.openById(record.spreadsheetId),
          year,
          rootFolderName,
          collectionName,
        };
      }
    } catch (_) {}
  }

  const driveRoot = DriveApp.getRootFolder();
  const root = getOrCreateFolder_(driveRoot, rootFolderName);
  const spreadsheetName = `${UNIT_SHEET_CONFIG.SPREADSHEET_PREFIX} - ${year}`;

  let spreadsheet = null;
  const files = root.getFilesByName(spreadsheetName);
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      spreadsheet = SpreadsheetApp.openById(file.getId());
      break;
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create(spreadsheetName);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(root);
  }

  getOrCreateLogSheet_(spreadsheet);
  PropertiesService.getScriptProperties().setProperty(propertyKey, JSON.stringify({
    rootFolderId: root.getId(),
    spreadsheetId: spreadsheet.getId(),
  }));

  return { root, spreadsheet, year, rootFolderName, collectionName };
}

function getExistingDestination_(collectionName) {
  const clean = normaliseCollectionName_(collectionName);
  const year = currentYear_();
  const raw = PropertiesService.getScriptProperties().getProperty(destinationPropertyKey_(clean, year));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (!record || !record.rootFolderId || !record.spreadsheetId) return null;
    return {
      root: DriveApp.getFolderById(record.rootFolderId),
      spreadsheet: SpreadsheetApp.openById(record.spreadsheetId),
      year,
      rootFolderName: `${clean} - ${year}`,
      collectionName: clean,
    };
  } catch (_) {
    return null;
  }
}

function getOrCreateLogSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(UNIT_SHEET_CONFIG.LOG_SHEET);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    const first = sheets.length === 1 ? sheets[0] : null;
    if (first && first.getName() === 'Sheet1' && first.getLastRow() <= 1 && !first.getRange('A1').getValue()) {
      sheet = first;
      sheet.setName(UNIT_SHEET_CONFIG.LOG_SHEET);
    } else {
      sheet = spreadsheet.insertSheet(UNIT_SHEET_CONFIG.LOG_SHEET);
    }
  }

  ensureSheetSize_(sheet, 2, UNIT_LOG_HEADERS.length);
  const current = sheet.getRange(1, 1, 1, UNIT_LOG_HEADERS.length).getDisplayValues()[0];
  if (current.join('\u001f') !== UNIT_LOG_HEADERS.join('\u001f')) {
    sheet.getRange(1, 1, 1, UNIT_LOG_HEADERS.length).setValues([UNIT_LOG_HEADERS]).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('D:D').setNumberFormat('@');
  return sheet;
}

function getOrCreateTeacherStandardSheet_(spreadsheet, tabName) {
  let sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) sheet = spreadsheet.insertSheet(tabName);
  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(2);
  return sheet;
}

function ensureColumns_(sheet, definitions) {
  // Batch header creation. v1.3 wrote each new key, label and width separately,
  // which could make the first complete-unit submission slow enough for the
  // browser confirmation window to expire.
  ensureSheetSize_(sheet, 3, 1);

  const contentLast = Math.max(sheet.getLastColumn(), 1);
  const keys = sheet.getRange(1, 1, 1, contentLast).getDisplayValues()[0];
  const labels = sheet.getRange(2, 1, 1, contentLast).getDisplayValues()[0];
  const map = new Map();

  keys.forEach((key, index) => {
    const clean = String(key || '').trim();
    if (clean) map.set(clean, index + 1);
  });

  // A brand-new Google Sheet reports one blank column. Reuse A rather than
  // starting at B so Student ID really is the first column.
  const sheetIsBlank = !keys.some((value) => String(value || '').trim());
  let nextColumn = sheetIsBlank ? 1 : contentLast + 1;

  const missing = [];
  const labelUpdates = new Map();

  definitions.forEach(([key, label]) => {
    if (!key) return;
    const wantedLabel = String(label || '');

    if (map.has(key)) {
      const col = map.get(key);
      if (String(labels[col - 1] || '') !== wantedLabel) {
        labelUpdates.set(col, sheetText_(wantedLabel));
      }
      return;
    }

    const col = nextColumn++;
    map.set(key, col);
    missing.push({ col, key: forceText_(key), label: sheetText_(wantedLabel) });
  });

  if (missing.length) {
    const firstCol = missing[0].col;
    const lastCol = missing[missing.length - 1].col;
    ensureSheetSize_(sheet, 3, lastCol);

    const keyRow = Array(lastCol - firstCol + 1).fill('');
    const labelRow = Array(lastCol - firstCol + 1).fill('');

    missing.forEach((item) => {
      const offset = item.col - firstCol;
      keyRow[offset] = item.key;
      labelRow[offset] = item.label;
    });

    sheet.getRange(1, firstCol, 1, keyRow.length).setValues([keyRow]);
    sheet.getRange(2, firstCol, 1, labelRow.length).setValues([labelRow]);
  }

  if (labelUpdates.size) {
    // Existing labels may have changed in the JSON. Updating the complete label
    // row in one call is much faster than one Spreadsheet service call per cell.
    const lastCol = Math.max(sheet.getLastColumn(), nextColumn - 1, 1);
    ensureSheetSize_(sheet, 3, lastCol);
    const fullLabels = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
    labelUpdates.forEach((value, col) => { fullLabels[col - 1] = value; });
    sheet.getRange(2, 1, 1, lastCol).setValues([fullLabels]);
  }

  const lastColumn = Math.max(sheet.getLastColumn(), nextColumn - 1, 1);
  ensureSheetSize_(sheet, 3, lastColumn);

  sheet.getRange(1, 1, 1, lastColumn)
    .setFontColor('#64748b')
    .setFontSize(8)
    .setWrap(true);

  sheet.getRange(2, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setWrap(true)
    .setVerticalAlignment('bottom');

  // Widths in batches rather than one call per new column.
  const fixedCount = Math.min(UNIT_FIXED_COLUMNS.length, lastColumn);
  if (fixedCount > 0) sheet.setColumnWidths(1, fixedCount, 150);
  if (lastColumn > fixedCount) sheet.setColumnWidths(fixedCount + 1, lastColumn - fixedCount, 320);

  return map;
}

function findOrCreateStudentRow_(sheet, studentId, columnMap) {
  const studentIdColumn = Number(columnMap?.get('__studentId') || 1);
  const lastRow = sheet.getLastRow();

  if (lastRow >= 3) {
    const match = sheet.getRange(3, studentIdColumn, lastRow - 2, 1)
      .createTextFinder(String(studentId))
      .matchEntireCell(true)
      .findNext();
    if (match) return match.getRow();
  }

  const row = Math.max(3, lastRow + 1);
  ensureSheetSize_(sheet, row, Math.max(sheet.getLastColumn(), studentIdColumn));
  return row;
}

function appendSubmissionLog_(sheet, row) {
  ensureSheetSize_(sheet, sheet.getLastRow() + 1, UNIT_LOG_HEADERS.length);
  sheet.appendRow(row);
}

function findSubmissionLogRow_(sheet, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const match = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(submissionId))
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : 0;
}

function ensureSheetSize_(sheet, minRows, minColumns) {
  if (sheet.getMaxRows() < minRows) sheet.insertRowsAfter(sheet.getMaxRows(), minRows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < minColumns) sheet.insertColumnsAfter(sheet.getMaxColumns(), minColumns - sheet.getMaxColumns());
}

function setValueByKey_(values, columnMap, key, value) {
  const col = columnMap.get(key);
  if (col) values[col - 1] = value;
}

function getOrCreateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function safeSheetName_(value) {
  let name = String(value || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = 'Sheet';
  return name.slice(0, 99);
}

function safeFilePart_(value, maxLength) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, maxLength || 100) || 'file';
}

function replaceFile_(folder, name, blob) {
  const matches = folder.getFilesByName(name);
  while (matches.hasNext()) matches.next().setTrashed(true);
  return folder.createFile(blob.setName(name));
}

function safeFolderPart_(value, maxLength) {
  return cleanText_(value, maxLength).replace(/[\\\/\0]/g, '-').replace(/\s+/g, ' ').trim();
}

function normaliseStandard_(value) {
  const raw = cleanText_(value, 80);
  const prefixed = raw.match(/\b(US|SS)\s*[-:]?\s*(\d{3,6})\b/i);
  if (prefixed) return `${prefixed[1].toUpperCase()} ${prefixed[2]}`;
  const compact = raw.match(/\b(US|SS)(\d{3,6})\b/i);
  if (compact) return `${compact[1].toUpperCase()} ${compact[2]}`;
  return raw || 'Unit Standard';
}

function cleanText_(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength || 1000);
}

function sheetText_(value) {
  const text = String(value == null ? '' : value);
  // Prevent user-controlled strings from becoming spreadsheet formulas.
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function forceText_(value) {
  return `'${String(value == null ? '' : value).replace(/^'/, '')}`;
}

function safeUrl_(value) {
  const url = cleanText_(value, 2000);
  if (!url) return '';
  return /^https:\/\//i.test(url) ? url : '';
}

function dateValueOrBlank_(value) {
  const text = cleanText_(value, 80);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : sheetText_(text);
}

function statusCacheKey_(submissionId) {
  return `unit-sheet-status:${submissionId}`;
}

function setStatus_(submissionId, status) {
  CacheService.getScriptCache().put(
    statusCacheKey_(submissionId),
    JSON.stringify(status),
    UNIT_SHEET_CONFIG.CACHE_TTL_SECONDS
  );
}

function getStatus_(submissionId, fastOnly, rootName) {
  if (!submissionId) return { state: 'error', message: 'Missing submissionId.' };
  const cached = CacheService.getScriptCache().get(statusCacheKey_(submissionId));
  if (cached) return JSON.parse(cached);
  if (fastOnly) return { state: 'pending', confirmed: false, submissionId };
  if (!rootName) return { state: 'pending', confirmed: false, submissionId };

  try {
    const destination = getExistingDestination_(rootName);
    if (!destination) return { state: 'pending', confirmed: false, submissionId };
    const log = getOrCreateLogSheet_(destination.spreadsheet);
    const row = findSubmissionLogRow_(log, submissionId);
    if (row) {
      const values = log.getRange(row, 1, 1, UNIT_LOG_HEADERS.length).getDisplayValues()[0];
      return {
        state: 'confirmed',
        confirmed: true,
        gatewayVersion: UNIT_SHEET_CONFIG.GATEWAY_VERSION,
        submissionId,
        collectionName: destination.collectionName,
        year: destination.year,
        message: 'Complete unit record is recorded.',
        tabName: String(values[17] || ''),
        studentRow: Number(values[18] || 0),
        spreadsheetUrl: destination.spreadsheet.getUrl(),
      };
    }
  } catch (_) {}
  return { state: 'pending', confirmed: false, submissionId };
}

function output_(value, callback) {
  const json = JSON.stringify(value);
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$\.]*$/.test(callback)) {
    return ContentService.createTextOutput(`${callback}(${json});`).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function errorMessage_(error) {
  return String(error && error.message || error || 'Unknown error').slice(0, 1000);
}
