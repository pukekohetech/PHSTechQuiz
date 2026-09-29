#!/usr/bin/env python3
"""Build question-sets.json from every JSON file in questions/.

One file must describe exactly one unit standard through its top-level
questionSet object. The browser uses the generated catalogue; teachers only
need to add/remove/edit files in questions/.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "questions"
OUTPUT = ROOT / "question-sets.json"


def fail(message: str) -> None:
    raise SystemExit(f"Question catalogue error: {message}")


def main() -> None:
    entries = []
    seen_ids = set()
    files = sorted(p for p in QUESTIONS.rglob("*.json") if not p.name.startswith("_"))
    if not files:
        fail("no JSON question files were found in questions/")

    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            fail(f"{path.name} is not valid JSON: {exc}")

        meta = raw.get("questionSet")
        if not isinstance(meta, dict):
            fail(f"{path.name} is missing top-level questionSet metadata")

        qid = str(meta.get("id", "")).strip()
        number = re.sub(r"\D", "", str(meta.get("number", "")))
        label = str(meta.get("label", "")).strip()
        assessments = raw.get("assessments", raw.get("ASSESSMENTS", []))

        if not qid:
            fail(f"{path.name}: questionSet.id is required")
        if qid in seen_ids:
            fail(f"duplicate questionSet.id: {qid}")
        if not re.fullmatch(r"\d{3,6}", number):
            fail(f"{path.name}: questionSet.number must be 3-6 digits")
        if not label:
            label = f"US {number}"
        if not isinstance(assessments, list) or not assessments:
            fail(f"{path.name}: at least one assessment is required")

        assessment_ids = set()
        for assessment in assessments:
            aid = str((assessment or {}).get("id", "")).strip()
            if not aid:
                fail(f"{path.name}: every assessment needs an id")
            if aid in assessment_ids:
                fail(f"{path.name}: duplicate assessment id {aid}")
            assessment_ids.add(aid)
            question_ids = set()
            for question in (assessment or {}).get("questions", []):
                question_id = str((question or {}).get("id", "")).strip()
                if not question_id:
                    fail(f"{path.name} / {aid}: every question needs an id")
                if question_id in question_ids:
                    fail(f"{path.name} / {aid}: duplicate question id {question_id}")
                question_ids.add(question_id)

        seen_ids.add(qid)
        entries.append({
            "id": qid,
            "label": label,
            "file": path.relative_to(ROOT).as_posix(),
            "number": number,
            "version": str(meta.get("version", "")).strip(),
            "credits": meta.get("credits", 0),
            "title": str(meta.get("title", "")).strip(),
            "assessmentCount": len(assessments),
        })

    entries.sort(key=lambda x: (int(x["number"]), x["version"], x["label"].lower()))
    output = {
        "schemaVersion": 1,
        "generated": True,
        "questionSets": entries,
    }
    text = json.dumps(output, indent=2, ensure_ascii=False) + "\n"
    if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != text:
        OUTPUT.write_text(text, encoding="utf-8")
        print(f"Updated {OUTPUT.name}: {len(entries)} question set(s)")
    else:
        print(f"{OUTPUT.name} already current: {len(entries)} question set(s)")


if __name__ == "__main__":
    main()
