// Life Story Book — the invention verifier, PORTED from the app (eternal-vault
// src/lib/life-story/verify-book.ts). A SEPARATE step that runs AFTER generation, on a
// finished draft. It never touches the writing stage: the writer is tuned for composed-but-
// plain prose and must not be made timid; this is the check that catches what slips through.
//
// For each chapter it takes the prose plus the source items the chapter draws on (the items
// the plan assigned, plus anything the writer's per-paragraph provenance cited, plus the
// family reference) and asks the model for every clause that ADDS something those sources
// do not support: a fact, a reason, a feeling, a characterization, a comparison, an
// inference, a sensory detail, dialogue, a scene, date arithmetic. Arrangement of sourced
// material passes. Output is a list of flags — chapter, exact text, category, why, and the
// nearest source it should trace to. Flagging only: nothing is deleted or rewritten here.
//
// Same Anthropic pattern as generate-book.js (non-streaming messages.create, env-overridable
// model, try/catch, max_tokens) plus output_config.format for a schema-valid flag list, as the
// planner does. Writes NOTHING — no database, no files.

const { BOOK_MODEL } = require("./generate-book");
const { BOOK_VERIFIER_SYSTEM_PROMPT, INVENTION_CATEGORIES, VERIFY_JSON_SCHEMA } = require("./book-prompts");

// Defaults to the writer's model; override independently if the verifier should run on a
// different (e.g. cheaper) model without touching generation.
const BOOK_VERIFIER_MODEL = process.env.ANTHROPIC_BOOK_VERIFIER_MODEL || BOOK_MODEL;

const VERIFY_MAX_TOKENS = 8000;
const ATTEMPTS_PER_CALL = 2;

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function normalise(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, "—")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function paragraphsOf(prose) {
  return prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function formatItem(item) {
  const head = [`[${item.sourceId}]`, item.sourceType, item.label ? `"${item.label}"` : null, item.date ?? (item.year ? String(item.year) : null)]
    .filter(Boolean)
    .join(" · ");
  return `${head}\n${item.text.trim()}`;
}

function formatRelation(item) {
  const r = item.relation;
  if (!r) return `- [${item.sourceId}] ${item.text}`;
  const span =
    r.birthYear && r.deathYear
      ? `${r.birthYear}–${r.deathYear}`
      : r.birthYear
        ? `born ${r.birthDate ?? r.birthYear}`
        : r.deathYear
          ? `died ${r.deathYear}`
          : "no dates recorded";
  return `- [${item.sourceId}] ${r.fullName} — ${r.relationship} (${span})`;
}

function verifierUserMessage(content, chapter, items) {
  const relations = [...content.dated, ...content.undated].filter((i) => i.sourceType === "tree_relation");
  const paras = paragraphsOf(chapter.prose);
  const numbered = paras.map((p, i) => `¶${i + 1}\n${p}`).join("\n\n");
  const provenance = chapter.provenance.length
    ? chapter.provenance.map((p) => `¶${p.paragraph}: ${p.sourceIds.join(", ") || "(none)"}`).join("\n")
    : "(the writer declared no provenance)";
  return [
    `CHAPTER ${chapter.chapterNumber} — "${chapter.title}"\n\n${numbered}`,
    `WRITER'S PROVENANCE (its claim, not your evidence)\n${provenance}`,
    `SOURCE ITEMS (${items.length})\n\n${items.map(formatItem).join("\n\n")}`,
    `FAMILY REFERENCE (counts as a source)\n${relations.length ? relations.map(formatRelation).join("\n") : "(none)"}`,
    `Report every clause that adds something these sources do not support. Pass arrangement. JSON only.`,
  ].join("\n\n---\n\n");
}

// ── Model call ──────────────────────────────────────────────────────────────────────────────

async function callVerifier(anthropic, user, label) {
  try {
    const response = await anthropic.messages.create({
      model: BOOK_VERIFIER_MODEL,
      max_tokens: VERIFY_MAX_TOKENS,
      system: BOOK_VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: VERIFY_JSON_SCHEMA } },
    });
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    if (response.stop_reason === "refusal") return { ok: false, error: `${label}: model refused`, inputTokens, outputTokens };
    if (response.stop_reason === "max_tokens") return { ok: false, error: `${label}: truncated at max_tokens`, inputTokens, outputTokens };
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { ok: false, error: `${label}: empty response`, inputTokens, outputTokens };
    return { ok: true, text, inputTokens, outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[life-story-verify] ${label} failed:`, message);
    return { ok: false, error: `${label}: ${message}`, inputTokens: 0, outputTokens: 0 };
  }
}

function parseFlags(raw, chapter) {
  let json;
  try {
    const m = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    json = JSON.parse(m ? m[1] : raw);
  } catch (_) {
    return { error: "verifier output was not valid JSON" };
  }
  const obj = json;
  if (!obj || !Array.isArray(obj.flags)) return { error: "verifier output missing flags array" };
  const proseNorm = normalise(chapter.prose);
  const catSet = new Set(INVENTION_CATEGORIES);
  const warnings = [];
  const flags = [];
  for (const f of obj.flags) {
    if (!f || typeof f !== "object") continue;
    const text = typeof f.text === "string" ? f.text.trim() : "";
    if (!text) continue;
    const category = typeof f.category === "string" && catSet.has(f.category) ? f.category : "fact";
    if (typeof f.category === "string" && !catSet.has(f.category)) {
      warnings.push(`chapter ${chapter.chapterNumber}: unknown category "${f.category}" — recorded as fact`);
    }
    const textFound = proseNorm.includes(normalise(text));
    if (!textFound) warnings.push(`chapter ${chapter.chapterNumber}: flagged text not found verbatim in prose — "${text}"`);
    flags.push({
      chapterNumber: chapter.chapterNumber,
      paragraph: typeof f.paragraph === "number" ? f.paragraph : 0,
      text,
      textFound,
      category,
      reason: typeof f.reason === "string" ? f.reason.trim() : "",
      nearestSourceId: typeof f.nearest_source_id === "string" && f.nearest_source_id ? f.nearest_source_id : null,
    });
  }
  return { flags, warnings };
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────

/**
 * Verify one chapter. One model call (retried once on malformed / truncated / empty output).
 * Never throws; a failed call yields status 'unchecked' with the error. Costs credits.
 */
async function verifyChapter(anthropic, content, chapter, usage, warnings) {
  const byId = new Map([...content.dated, ...content.undated].map((i) => [i.sourceId, i]));
  const cited = chapter.provenance.flatMap((p) => p.sourceIds);
  const ids = Array.from(new Set([...chapter.sourceIds, ...cited]));
  const items = ids.map((id) => byId.get(id)).filter((i) => !!i && i.sourceType !== "tree_relation");
  if (!items.length) {
    return { chapterNumber: chapter.chapterNumber, title: chapter.title, status: "unchecked", flags: [], error: "no source items resolved" };
  }
  const user = verifierUserMessage(content, chapter, items);
  let lastError = "no attempt made";
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CALL; attempt++) {
    const label = `verify chapter ${chapter.chapterNumber} (attempt ${attempt})`;
    const outcome = await callVerifier(anthropic, user, label);
    usage.calls += 1;
    usage.inputTokens += outcome.inputTokens;
    usage.outputTokens += outcome.outputTokens;
    if (!outcome.ok) {
      lastError = outcome.error;
      warnings.push(outcome.error);
      continue;
    }
    const parsed = parseFlags(outcome.text, chapter);
    if ("error" in parsed) {
      lastError = `${label}: ${parsed.error}`;
      warnings.push(lastError);
      continue;
    }
    warnings.push(...parsed.warnings);
    return {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      status: parsed.flags.length ? "flagged" : "verified",
      flags: parsed.flags,
    };
  }
  return { chapterNumber: chapter.chapterNumber, title: chapter.title, status: "unchecked", flags: [], error: lastError };
}

/**
 * Verify every chapter of a finished draft, in order. Independent of generation: pass it the
 * chapters from generateLifeStoryBook. Never throws. Writes nothing. Costs credits: one call
 * per chapter.
 */
async function verifyBook(anthropic, content, chapters, options = {}) {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const warnings = [];
  const results = [];
  for (const chapter of chapters) {
    const result = await verifyChapter(anthropic, content, chapter, usage, warnings);
    results.push(result);
    if (options.onChapter) options.onChapter(result);
  }
  return { model: BOOK_VERIFIER_MODEL, results, usage, warnings };
}

module.exports = { BOOK_VERIFIER_MODEL, verifyBook, verifyChapter };
