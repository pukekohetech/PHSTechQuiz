import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "assessments");
const OUT = path.join(DIR, "question-sets.json");
const IGNORE = new Set(["_TEMPLATE.json", "question-sets.json"]);

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const entries = await fs.readdir(DIR, { withFileTypes: true });
  const files = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    if (IGNORE.has(entry.name)) continue;

    const full = path.join(DIR, entry.name);
    try {
      const raw = await fs.readFile(full, "utf8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") throw new Error("root is not an object");
      if (!data.questionSet || typeof data.questionSet !== "object") throw new Error("missing questionSet");
      if (!Array.isArray(data.assessments)) throw new Error("missing assessments array");
      if (!data.questionSet.id) throw new Error("questionSet.id is required");
      if (!data.assessments.length) throw new Error("assessments array is empty");

      for (const assessment of data.assessments) {
        if (!assessment?.id) throw new Error("every assessment needs an id");
        if (!Array.isArray(assessment.questions)) throw new Error(`assessment ${assessment.id} is missing questions`);
      }

      files.push(entry.name);
    } catch (error) {
      skipped.push({ file: entry.name, reason: error.message });
    }
  }

  files.sort((a, b) => a.localeCompare(b, "en"));
  const catalogue = {
    generatedAt: new Date().toISOString(),
    files
  };
  await fs.writeFile(OUT, JSON.stringify(catalogue, null, 2) + "\n", "utf8");

  console.log(`Assessment catalogue updated: ${files.length} valid JSON file(s).`);
  for (const item of skipped) console.warn(`Skipped ${item.file}: ${item.reason}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
