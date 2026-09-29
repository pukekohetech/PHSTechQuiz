#!/usr/bin/env python3
"""Build root question-sets.json from every assessment JSON in questions/.

NORMAL WORKFLOW
---------------
1. Add, replace, rename, or delete a .json file anywhere under questions/.
2. GitHub Actions runs this script automatically.
3. The generated root question-sets.json is committed.
4. QuizMaster sees the change without manually editing the catalogue.

Files beginning with "_" are ignored, so questions/_TEMPLATE.json is safe.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "questions"
OUTPUT = ROOT / "question-sets.json"


def fail(message: str) -> None:
    raise SystemExit(f"Question catalogue error: {message}")


def standard_prefix(meta: dict, qid: str, label: str) -> str:
    source = " ".join(
        str(value or "").strip()
        for value in (label, qid, meta.get("title"))
        if str(value or "").strip()
    )
    match = re.search(r"\b(US|SS)\s*[-:]?\s*\d{3,6}\b", source, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    if re.match(r"^(US|SS)\d", qid, re.IGNORECASE):
        return qid[:2].upper()
    return "US"


def validate_image(image: str, path: Path, aid: str, question_id: str) -> None:
    image = image.strip()

    if image.lower().startswith("data:"):
        match = re.fullmatch(
            r"data:image/(webp|png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=\s]+)",
            image,
            flags=re.IGNORECASE,
        )
        if not match:
            fail(f"{path.name} / {aid} / {question_id}: unsupported embedded image data URL")
        encoded = re.sub(r"\s+", "", match.group(2))
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            fail(f"{path.name} / {aid} / {question_id}: embedded image base64 is invalid")
        if not decoded:
            fail(f"{path.name} / {aid} / {question_id}: embedded image is empty")
        return

    if re.match(r"^https?://", image, re.IGNORECASE):
        return

    # QuizMaster resolves local image paths from the site root.
    local_path = ROOT / image.lstrip("/")
    if not local_path.is_file():
        fail(
            f"{path.name} / {aid} / {question_id}: image file does not exist: {image}"
        )


def main() -> None:
    if not QUESTIONS.is_dir():
        fail("questions/ folder does not exist")

    entries = []
    seen_ids = set()
    files = sorted(
        p for p in QUESTIONS.rglob("*.json")
        if not p.name.startswith("_")
    )

    if not files:
        fail("no JSON question files were found in questions/")

    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            fail(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")

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
        if not isinstance(assessments, list) or not assessments:
            fail(f"{path.name}: at least one assessment is required")

        prefix = standard_prefix(meta, qid, label)
        if not label:
            label = f"{prefix} {number}"

        assessment_ids = set()
        for assessment in assessments:
            aid = str((assessment or {}).get("id", "")).strip()
            if not aid:
                fail(f"{path.name}: every assessment needs an id")
            if aid in assessment_ids:
                fail(f"{path.name}: duplicate assessment id {aid}")
            assessment_ids.add(aid)

            questions = (assessment or {}).get("questions", [])
            if not isinstance(questions, list):
                fail(f"{path.name} / {aid}: questions must be an array")

            question_ids = set()
            for question in questions:
                question_id = str((question or {}).get("id", "")).strip()
                if not question_id:
                    fail(f"{path.name} / {aid}: every question needs an id")
                if question_id in question_ids:
                    fail(f"{path.name} / {aid}: duplicate question id {question_id}")
                question_ids.add(question_id)

                image = (question or {}).get("image")
                if image is not None:
                    if not isinstance(image, str) or not image.strip():
                        fail(f"{path.name} / {aid} / {question_id}: image must be a non-empty string")
                    validate_image(image, path, aid, question_id)

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

    entries.sort(key=lambda item: (
        int(item["number"]),
        item["version"],
        item["label"].lower(),
    ))

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
