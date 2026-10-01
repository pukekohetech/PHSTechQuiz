/**
 * PHS Assessment & Evidence - Google Sheets Submission Gateway Prototype v1
 *
 * This is a SEPARATE prototype gateway for normal written/reflection assessment
 * submissions. It does not create PDFs or .puk files.
 *
 * Storage model:
 *   <storageRootName> - <year>/
 *     Assessment Submissions - <year>   [Google Spreadsheet]
 *
 * Spreadsheet tabs:
 *   _Submission Log
 *   RNR - SS 40540
 *   RY - SS 40540
 *   RNR - US 24352
 *   ...
 *
 * Each teacher-standard tab contains:
 *   Row 1 = stable machine keys (question IDs and metadata IDs)
 *   Row 2 = teacher-friendly labels/question text
 *   Row 3+ = one row per student for that teacher + standard
 *
 * Re-submission updates the student's existing row while the append-only
 * _Submission Log keeps the audit history.
 */

const SHEET_CONFIG = {
  TIME_ZONE: 'Pacific/Auckland',
  EXPECTED_APP_PREFIX: 'pukekohetech-',
  ALLOWED_ROOT_PREFIX: 'PHS ',
  SPREADSHEET_PREFIX: 'Assessment Submissions',
  LOG_SHEET: '_Submission Log',
  CACHE_TTL_SECONDS: 21600,
  MAX_ANSWERS: 500,
  MAX_ANSWER_CHARS: 45000,
  MAX_QUESTION_CHARS: 1000,
  DESTINATION_PROPERTY_PREFIX: 'PHS_SHEET_DEST_',
};

const FIXED_COLUMNS = [
  ['__studentId', 'Student ID'],
  ['__studentName', 'Student'],
  ['__teacher', 'Teacher'],
  ['__unitStandard', 'Unit Standard'],
  ['__questionSetId', 'Question Set ID'],
  ['__lastAssessment', 'Last Assessment'],
  ['__lastResult', 'Last Result'],
  ['__lastSubmitted', 'Last Submitted'],
  ['__submissions', 'Submissions'],
  ['__status', 'Status'],
];

const LOG_HEADERS = [
  'Submission ID',
  'Submitted At',
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
  'Answer Count',
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
    message: 'Google Sheets submission prototype authorised.',
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
      mode: 'sheet',
      message: 'PHS Google Sheets submission gateway is ready.',
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

    validatePayload_(payload);
    const result = saveSheetSubmission_(payload);
    setStatus_(submissionId, result);
    return output_(result, '');
  } catch (error) {
    const result = {
      state: 'error',
      confirmed: false,
      submissionId,
      message: errorMessage_(error),
    };
    if (submissionId && claimed) setStatus_(submissionId, result);
    return output_(result, '');
  }
}

function validatePayload_(payload) {
  const appId = cleanText_(payload.appId, 100);
  if (SHEET_CONFIG.EXPECTED_APP_PREFIX && !appId.startsWith(SHEET_CONFIG.EXPECTED_APP_PREFIX)) {
    throw new Error('Unrecognised assessment app.');
  }

  if (String(payload.submissionMode || '').toLowerCase() !== 'sheet') {
    throw new Error('This gateway accepts sheet submissions only.');
  }

  [
    'submissionId',
    'studentName',
    'studentId',
    'teacherName',
    'teacherId',
    'unitStandard',
    'questionSetId',
    'assessmentId',
    'assessmentTitle',
    'storageRootName',
  ].forEach((key) => {
    if (!String(payload[key] || '').trim()) throw new Error(`Missing ${key}.`);
  });

  if (!/^\d{3,6}$/.test(String(payload.studentId || '').trim())) {
    throw new Error('Student ID is invalid.');
  }

  const pct = Number(payload.percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Percentage is invalid.');

  if (!Array.isArray(payload.answers)) throw new Error('Answers must be an array.');
  if (payload.answers.length > SHEET_CONFIG.MAX_ANSWERS) throw new Error('Too many answers in one submission.');

  normaliseCollectionName_(payload.storageRootName);
}

function saveSheetSubmission_(payload) {
  const collectionName = normaliseCollectionName_(payload.storageRootName);
  const destination = getOrCreateDestination_(collectionName);
  const spreadsheet = destination.spreadsheet;

  const teacherId = cleanText_(payload.teacherId, 40) || 'Teacher';
  const teacherName = cleanText_(payload.teacherName, 100) || teacherId;
  const studentId = cleanText_(payload.studentId, 60);
  const studentName = cleanText_(payload.studentName, 120);
  const standard = normaliseStandard_(payload.unitStandard);
  const questionSetId = cleanText_(payload.questionSetId, 100);
  const assessmentId = cleanText_(payload.assessmentId, 100);
  const assessmentTitle = cleanText_(payload.assessmentTitle, 180) || assessmentId;
  const submissionId = cleanText_(payload.submissionId, 160);
  const answers = normaliseAnswers_(payload.answers);
  const now = new Date();
  const resultText = `${Number(payload.score || 0)}/${Number(payload.totalMarks || 0)} (${Number(payload.percentage || 0)}%)`;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const logSheet = getOrCreateLogSheet_(spreadsheet);

    const existingLogRow = findSubmissionLogRow_(logSheet, submissionId);
    if (existingLogRow) {
      const old = logSheet.getRange(existingLogRow, 1, 1, LOG_HEADERS.length).getDisplayValues()[0];
      return {
        state: 'duplicate',
        confirmed: true,
        message: 'This exact submission was already received.',
        submissionId,
        collectionName,
        year: destination.year,
        spreadsheetUrl: spreadsheet.getUrl(),
        tabName: String(old[14] || ''),
        studentRow: Number(old[15] || 0),
      };
    }

    const tabName = safeSheetName_(`${teacherId} - ${standard}`);
    const sheet = getOrCreateTeacherStandardSheet_(spreadsheet, tabName);

    const assessmentColumns = [
      [`__assessment:${assessmentId}:status`, `${assessmentTitle} - Status`],
      [`__assessment:${assessmentId}:result`, `${assessmentTitle} - Result`],
      [`__assessment:${assessmentId}:submitted`, `${assessmentTitle} - Submitted`],
    ];

    const answerColumns = answers.map((answer) => [
      `q:${answer.questionId}`,
      `${answer.questionId} - ${answer.question}${answer.maxPoints ? ` [${answer.maxPoints} mark${answer.maxPoints === 1 ? '' : 's'}]` : ''}`,
    ]);

    const columnMap = ensureColumns_(sheet, FIXED_COLUMNS.concat(assessmentColumns, answerColumns));
    const row = findOrCreateStudentRow_(sheet, studentId);
    const lastColumn = sheet.getLastColumn();
    const values = sheet.getRange(row, 1, 1, lastColumn).getValues()[0];

    setValueByKey_(values, columnMap, '__studentId', forceText_(studentId));
    setValueByKey_(values, columnMap, '__studentName', sheetText_(studentName));
    setValueByKey_(values, columnMap, '__teacher', sheetText_(`${teacherId} - ${teacherName}`));
    setValueByKey_(values, columnMap, '__unitStandard', sheetText_(standard));
    setValueByKey_(values, columnMap, '__questionSetId', sheetText_(questionSetId));
    setValueByKey_(values, columnMap, '__lastAssessment', sheetText_(assessmentTitle));
    setValueByKey_(values, columnMap, '__lastResult', sheetText_(resultText));
    setValueByKey_(values, columnMap, '__lastSubmitted', now);

    const submissionsColumn = columnMap.get('__submissions');
    const previousSubmissions = submissionsColumn ? Number(values[submissionsColumn - 1] || 0) : 0;
    setValueByKey_(values, columnMap, '__submissions', previousSubmissions + 1);
    setValueByKey_(values, columnMap, '__status', 'Confirmed');

    setValueByKey_(values, columnMap, `__assessment:${assessmentId}:status`, 'Submitted');
    setValueByKey_(values, columnMap, `__assessment:${assessmentId}:result`, sheetText_(resultText));
    setValueByKey_(values, columnMap, `__assessment:${assessmentId}:submitted`, now);

    answers.forEach((answer) => {
      setValueByKey_(values, columnMap, `q:${answer.questionId}`, sheetText_(answer.answer));
    });

    sheet.getRange(row, 1, 1, lastColumn).setValues([values]);
    sheet.getRange(row, 1).setNumberFormat('@');

    appendSubmissionLog_(logSheet, [
      forceText_(submissionId),
      now,
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
      answers.length,
      sheetText_(tabName),
      row,
      sheetText_(payload.appVersion || ''),
    ]);

    SpreadsheetApp.flush();

    return {
      state: 'confirmed',
      confirmed: true,
      message: 'Answers saved to Google Sheets.',
      submissionId,
      collectionName,
      year: destination.year,
      rootFolderName: destination.rootFolderName,
      spreadsheetUrl: spreadsheet.getUrl(),
      tabName,
      studentRow: row,
      answerCount: answers.length,
    };
  } finally {
    lock.releaseLock();
  }
}

function normaliseAnswers_(answers) {
  const seen = new Set();
  return (answers || []).map((raw, index) => {
    const questionId = cleanText_(raw && raw.questionId, 180);
    if (!questionId) throw new Error(`Answer ${index + 1} is missing questionId.`);
    if (seen.has(questionId)) throw new Error(`Duplicate questionId in submission: ${questionId}`);
    seen.add(questionId);

    return {
      questionId,
      question: cleanText_(raw && raw.question, SHEET_CONFIG.MAX_QUESTION_CHARS),
      type: cleanText_(raw && raw.type, 30),
      group: cleanText_(raw && raw.group, 100),
      part: cleanText_(raw && raw.part, 20),
      answer: String((raw && raw.answer) == null ? '' : raw.answer).slice(0, SHEET_CONFIG.MAX_ANSWER_CHARS),
      earned: Number(raw && raw.earned || 0),
      maxPoints: Number(raw && raw.maxPoints || 0),
    };
  });
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
        };
      }
    } catch (_) {}
  }

  const driveRoot = DriveApp.getRootFolder();
  const root = getOrCreateFolder_(driveRoot, rootFolderName);
  const spreadsheetName = `${SHEET_CONFIG.SPREADSHEET_PREFIX} - ${year}`;

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

  return { root, spreadsheet, year, rootFolderName };
}

function getOrCreateLogSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_CONFIG.LOG_SHEET);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    const first = sheets.length === 1 ? sheets[0] : null;
    if (first && first.getLastRow() === 0 && first.getLastColumn() === 0) {
      sheet = first;
      sheet.setName(SHEET_CONFIG.LOG_SHEET);
    } else if (first && first.getName() === 'Sheet1' && first.getLastRow() <= 1 && first.getLastColumn() <= 1 && !first.getRange('A1').getValue()) {
      sheet = first;
      sheet.setName(SHEET_CONFIG.LOG_SHEET);
    } else {
      sheet = spreadsheet.insertSheet(SHEET_CONFIG.LOG_SHEET);
    }
  }

  const current = sheet.getRange(1, 1, 1, LOG_HEADERS.length).getDisplayValues()[0];
  if (current.join('\u001f') !== LOG_HEADERS.join('\u001f')) {
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('C:C').setNumberFormat('@');
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
  const existingLast = Math.max(sheet.getLastColumn(), 1);
  const keys = sheet.getRange(1, 1, 1, existingLast).getDisplayValues()[0];
  const labels = sheet.getRange(2, 1, 1, existingLast).getDisplayValues()[0];
  const map = new Map();

  keys.forEach((key, index) => {
    const clean = String(key || '').trim();
    if (clean) map.set(clean, index + 1);
  });

  definitions.forEach(([key, label]) => {
    if (!map.has(key)) {
      const col = map.size ? sheet.getLastColumn() + 1 : 1;
      sheet.getRange(1, col).setValue(forceText_(key));
      sheet.getRange(2, col).setValue(sheetText_(label));
      map.set(key, col);
    } else {
      const col = map.get(key);
      if (String(labels[col - 1] || '') !== String(label || '')) {
        sheet.getRange(2, col).setValue(sheetText_(label));
      }
    }
  });

  const lastColumn = sheet.getLastColumn();
  if (lastColumn > 0) {
    sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold').setBackground('#eeeeee');
    sheet.getRange(2, 1, 1, lastColumn).setFontWeight('bold');
  }
  sheet.getRange('A:A').setNumberFormat('@');
  return map;
}

function findOrCreateStudentRow_(sheet, studentId) {
  const lastRow = sheet.getLastRow();
  if (lastRow >= 3) {
    const match = sheet.getRange(3, 1, lastRow - 2, 1)
      .createTextFinder(String(studentId))
      .matchEntireCell(true)
      .findNext();
    if (match) return match.getRow();
  }

  return Math.max(3, lastRow + 1);
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

function appendSubmissionLog_(sheet, row) {
  sheet.appendRow(row);
  const r = sheet.getLastRow();
  sheet.getRange(r, 1).setNumberFormat('@');
  sheet.getRange(r, 3).setNumberFormat('@');
}

function setValueByKey_(values, columnMap, key, value) {
  const col = columnMap.get(key);
  if (!col) throw new Error(`Sheet column was not created: ${key}`);
  values[col - 1] = value;
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
      startedAtMs: Date.now(),
      message: 'Submission is being saved.',
    };
    cache.put(key, JSON.stringify(status), SHEET_CONFIG.CACHE_TTL_SECONDS);
    return { claimed: true, status };
  } finally {
    lock.releaseLock();
  }
}

function getStatus_(submissionId, fastOnly, rootName) {
  submissionId = cleanText_(submissionId, 160);
  if (!submissionId) return { state: 'error', confirmed: false, message: 'Missing submissionId.' };

  const cached = CacheService.getScriptCache().get(statusCacheKey_(submissionId));
  if (cached) {
    try {
      const status = JSON.parse(cached);
      if (status && status.state !== 'processing') return status;
    } catch (_) {}
  }

  if (fastOnly) return { state: 'pending', confirmed: false, submissionId };
  if (!rootName) return { state: 'pending', confirmed: false, submissionId };

  try {
    const collectionName = normaliseCollectionName_(rootName);
    const destination = getOrCreateDestination_(collectionName);
    const logSheet = getOrCreateLogSheet_(destination.spreadsheet);
    const row = findSubmissionLogRow_(logSheet, submissionId);
    if (!row) return { state: 'pending', confirmed: false, submissionId };

    const values = logSheet.getRange(row, 1, 1, LOG_HEADERS.length).getDisplayValues()[0];
    return {
      state: 'confirmed',
      confirmed: true,
      submissionId,
      message: 'Submission is recorded in Google Sheets.',
      spreadsheetUrl: destination.spreadsheet.getUrl(),
      tabName: String(values[14] || ''),
      studentRow: Number(values[15] || 0),
    };
  } catch (error) {
    return { state: 'pending', confirmed: false, submissionId, message: errorMessage_(error) };
  }
}

function statusCacheKey_(submissionId) {
  return `sheet-status:${submissionId}`;
}

function setStatus_(submissionId, status) {
  CacheService.getScriptCache().put(
    statusCacheKey_(submissionId),
    JSON.stringify(status || {}),
    SHEET_CONFIG.CACHE_TTL_SECONDS
  );
}

function currentYear_() {
  return Utilities.formatDate(new Date(), SHEET_CONFIG.TIME_ZONE, 'yyyy');
}

function normaliseCollectionName_(value) {
  let name = cleanText_(value, 100).replace(/\s+-\s+\d{4}\s*$/, '').trim();
  name = safeFolderPart_(name, 90);
  if (!name) throw new Error('Sheet collection name is missing.');
  if (SHEET_CONFIG.ALLOWED_ROOT_PREFIX && !name.startsWith(SHEET_CONFIG.ALLOWED_ROOT_PREFIX)) {
    throw new Error(`Sheet collection name must begin with "${SHEET_CONFIG.ALLOWED_ROOT_PREFIX}".`);
  }
  return name;
}

function normaliseStandard_(value) {
  const raw = cleanText_(value, 100);
  const match = raw.match(/\b(US|SS)\s*[-:]?\s*(\d{3,6})\b/i);
  if (match) return `${match[1].toUpperCase()} ${match[2]}`;
  const digits = raw.match(/\b\d{3,6}\b/);
  return digits ? `US ${digits[0]}` : raw || 'Unit Standard';
}

function destinationPropertyKey_(collectionName, year) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    `${collectionName.toLowerCase()}|${year}`
  );
  const token = Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '').slice(0, 40);
  return `${SHEET_CONFIG.DESTINATION_PROPERTY_PREFIX}${token}`;
}

function getOrCreateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function safeSheetName_(value) {
  let name = cleanText_(value, 100).replace(/[\\\/\?\*\[\]:]/g, ' - ').replace(/\s+/g, ' ').trim();
  if (!name) name = 'Assessment';
  return name.slice(0, 100);
}

function safeFolderPart_(value, maxLength) {
  return cleanText_(value, maxLength || 100)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

function cleanText_(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength || 1000)
    .trim();
}

function sheetText_(value) {
  let text = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, SHEET_CONFIG.MAX_ANSWER_CHARS);

  // Prevent student-controlled content from becoming a spreadsheet formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return text;
}

function forceText_(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith("'") ? text : `'${text}`;
}

function errorMessage_(error) {
  return String(error && error.message || error || 'Unknown error').slice(0, 1000);
}

function output_(object, callback) {
  const json = JSON.stringify(object || {});
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(callback)) {
    return ContentService
      .createTextOutput(`${callback}(${json});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
