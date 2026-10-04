const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
globalThis.assert = assert;

const plugin = fs.readFileSync(require('path').join(__dirname, 'flexible-groups.js'),'utf8');

const prefix = `
var window = globalThis;
try { Object.defineProperty(globalThis.navigator || {}, 'onLine', {value:true, configurable:true}); } catch (_) {}
var navigator = globalThis.navigator || { onLine:true };
var document = {
  head: { appendChild(){} },
  body: {},
  addEventListener(){},
  getElementById(){ return null; },
  querySelector(){ return null; },
  querySelectorAll(){ return []; },
  createElement(){ return { className:'', style:{}, dataset:{}, append(){}, appendChild(){}, setAttribute(){}, addEventListener(){}, remove(){}, replaceChildren(){}, insertAdjacentElement(){}, classList:{add(){},remove(){},contains(){return false;}} }; }
};
var MutationObserver = function(){ this.observe=function(){}; };
window.MutationObserver = MutationObserver;
var data = { answers: { written: { q1: 'correct' } } };
var STORAGE_KEY = 'TEST';
function storageSet(){}
function xorDecode(v){ return v || ''; }
function xorEncode(v){ return v || ''; }
var currentAssessmentId = 'written';
var ASSESSMENTS = [{ id:'written', title:'Written', questions:[{id:'q1',maxPoints:1,rubric:[{points:1,check:/^correct$/i}]}] }, { id:'photos', title:'Photos', questions:[] }];
var CURRENT_QUESTION_SET = { id:'ss-test', evidenceTracker:{ items:[{id:'w',type:'assessment',assessmentId:'written',label:'Written'},{id:'p',type:'photoOption',assessmentId:'photos',optionId:'stage',label:'Stage'}] } };
function loadAssessment(){}
var finalData = { assessmentId:'written', assessmentTitle:'Written' };
var preparedPdfResult = { pdfBlob:{} };
var preparedPukResult = { initial:true };
var currentSubmissionId = 'sub-1';
var submissionInProgress = false;
var lastConfirmedSubmission = null;
var backupSnapshots = [];
async function createProgressBackupForSubmission(){
  const snap = JSON.parse(JSON.stringify(data.submissionRecords || []));
  backupSnapshots.push(snap);
  return { pukText:'x', snapshot:snap };
}
function makeSubmissionId(){ return 'generated'; }
function getSubmissionEndpoint(){ return 'https://example.invalid/exec'; }
function getSubmissionRootName(){ return 'Root'; }
function updatePdfActionState(){}
async function jsonpRequest(endpoint, params){ return {state:'confirmed', submissionId:params.submissionId}; }
async function submitToTeacher(){
  assert.strictEqual((preparedPukResult.snapshot || [])[0].state, 'pending', 'uploaded PUK should contain pending submission record');
  lastConfirmedSubmission = { state:'confirmed' };
}
`;

vm.runInThisContext(prefix + '\n' + plugin, {filename:'flexible-groups-v5-test.js'});

(async()=>{
  let p = window.QuizMasterFlexible.getEvidenceProgress();
  assert.strictEqual(p.results[0].state,'ready');
  await window.submitToTeacher();
  p = window.QuizMasterFlexible.getEvidenceProgress();
  assert.strictEqual(p.results[0].state,'submitted');
  assert.strictEqual(data.submissionRecords.length,1);
  assert.strictEqual(data.submissionRecords[0].state,'confirmed');
  assert.strictEqual(backupSnapshots[0][0].state,'pending');
  assert.strictEqual(backupSnapshots.at(-1)[0].state,'confirmed');

  data.answers.written.q1='correct changed';
  ASSESSMENTS[0].questions[0].rubric=[{points:1,check:/^correct changed$/i}];
  p = window.QuizMasterFlexible.getEvidenceProgress();
  assert.strictEqual(p.results[0].state,'ready');
  assert.ok(p.results[0].detail.includes('changed since the last submission'));

  window.QuizMasterFlexible.recordSubmission({ submissionId:'photo-1', kind:'photoEvidence', assessmentId:'photos', optionId:'stage', optionLabel:'Stage', descriptor:'Cutting', state:'pending', rootName:'Root', repeatable:true });
  await window.QuizMasterFlexible.reconcilePendingSubmissions({force:true});
  assert.strictEqual(data.submissionRecords.find(x=>x.submissionId==='photo-1').state,'confirmed');
  assert.strictEqual(data.evidenceRecords.length,1);
  assert.strictEqual(data.evidenceRecords[0].submissionId,'photo-1');
  p = window.QuizMasterFlexible.getEvidenceProgress();
  assert.strictEqual(p.results[1].state,'submitted');

  console.log('PASS: normal submission becomes green after confirmation');
  console.log('PASS: PUK snapshot contains pending ID before upload and confirmed state after confirmation');
  console.log('PASS: editing after submission returns tracker to READY — NOT SUBMITTED');
  console.log('PASS: restored pending photo submission reconciles against register and becomes submitted');
  process.exit(0);
})().catch(err=>{console.error(err);process.exit(1);});
