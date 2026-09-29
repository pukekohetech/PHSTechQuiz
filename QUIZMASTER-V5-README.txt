QUIZMASTER v5 - MULTI-STANDARD QUESTION LIBRARY
===============================================

WHAT CHANGED
------------
QuizMaster is now one website that can load many unit standards.

One file in /questions = one unit standard.
One .puk = all saved assessment sections for that unit standard.
One PDF = one submitted assessment section.

STUDENT FLOW
------------
1. Enter Student Name / ID / Teacher.
2. Select Unit Standard.
3. QuizMaster loads that question file and fills the Assessment section list.
4. Select the assessment section and press Load Assessment.
5. Switching unit standards saves the current unit locally before loading the next one.

QUESTION FILE FORMAT
--------------------
Each questions/*.json file needs ONE top-level questionSet object and an assessments array.
Unit-standard metadata is written once, not copied into every assessment.

Example:
{
  "schemaVersion": 2,
  "questionSet": {
    "id": "us24352-v3",
    "label": "US 24352 - Safe working practices",
    "title": "...",
    "number": "24352",
    "version": "v3",
    "credits": 2,
    "standardType": "internal"
  },
  "deadline": { "day": 28, "month": 12, "label": "Submission deadline" },
  "assessments": [ ... ]
}

Inside each assessment you now only need section-specific information such as:
- id
- title
- subtitle
- attachSignoff
- questionGroups (optional)
- questions

AUTOMATIC QUESTION DETECTION
----------------------------
Do NOT manually maintain question-sets.json.

Add/edit/delete a .json file inside /questions and commit it to GitHub.
The included GitHub Action runs tools/build_question_catalog.py, reads the
questionSet metadata from every JSON file, and commits a refreshed
question-sets.json automatically.

For the Action to commit the generated catalogue, ensure the repository allows
GitHub Actions read/write access under repository Settings > Actions > General >
Workflow permissions.

You can also rebuild locally with:
  python3 tools/build_question_catalog.py

FILES ADDED
-----------
app-config.json                         QuizMaster title + teachers
question-sets.json                     generated catalogue - do not hand edit
questions/us99999-test.json            two-section test unit
questions/us24352-v3.json              grouped hazard example
questions/_TEMPLATE.json               ignored starter template
tools/build_question_catalog.py        catalogue generator
.github/workflows/build-question-catalog.yml

FILES NO LONGER USED
--------------------
The old root questions.json is no longer used and should be deleted from GitHub.

BACKUPS
-------
Example downloadable backup names:
  123456_us24352-v3.puk
  123456_us24356-v2.puk

The encrypted backup carries its questionSetId. Loading a v5 .puk can switch
QuizMaster to the correct installed unit standard automatically.

EXISTING FEATURES RETAINED
--------------------------
- grouped multi-part questions
- MC answer shuffling
- automatic Back to Form when loading an assessment
- encrypted .puk files
- autosave
- fast Google submission
- duplicate protection
- dynamic evidence storage root/year
- separate register row per assessment section
- reading comfort tools
