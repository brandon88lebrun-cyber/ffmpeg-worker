// Life Story Book — the generator engine, PORTED from the app (eternal-vault
// src/lib/life-story/generate-book.ts). Same two stages, same parsing, same retry rules;
// types dropped, CommonJS. Consumes the LifeStoryContent blob the app's gatherer produced
// and the app handed over in the /life-story-jobs body. It reads NO user data itself.
//   Stage 1  planBook()      one model call, whole model in → chapter plan out (structured JSON)
//   Stage 2  writeChapter()  one model call PER chapter, in plan order, each given only its
//                            assigned source items + the family reference + the subject's own
//                            words as the voice to imitate; returns prose + per-paragraph
//                            provenance (parsed from a trailing marker block, see book-prompts)
//
// This module writes NOTHING: no database, no files. It calls the model and returns data.
//
// Anthropic pattern as in the app: non-streaming messages.create, env-overridable model
// constant, try/catch around every call, max_tokens as the only sampling parameter (no
// temperature / top_p / thinking config — current models reject those with 400). The one
// addition is output_config.format on the planner call so the plan comes back as schema-valid
// JSON rather than prose we would have to scrape.

const {
  ARC_STAGES,
  BOOK_CHAPTER_SYSTEM_PROMPT,
  BOOK_PLAN_JSON_SCHEMA,
  BOOK_PLAN_MAX_CHAPTERS,
  BOOK_PLAN_MIN_CHAPTERS,
  BOOK_PLANNER_SYSTEM_PROMPT,
  PROVENANCE_MARKER,
} = require("./book-prompts");

// Default is the current top-tier general model: the book is a one-time artifact of maybe a
// dozen calls, and the whole product promise is the prose. Override with ANTHROPIC_BOOK_MODEL
// (e.g. 'claude-sonnet-5' to match INTERVIEW_MODEL) — the id swap is the whole change.
const BOOK_MODEL = process.env.ANTHROPIC_BOOK_MODEL || "claude-opus-5";

// Generous on purpose: current models think before answering and the thinking counts against
// max_tokens. A tight cap truncates the JSON / the chapter mid-thought with stop_reason
// 'max_tokens'. Both stay under the SDK's non-streaming ceiling.
const PLAN_MAX_TOKENS = 16000;
const CHAPTER_MAX_TOKENS = 8000;

/** One attempt per stage plus one retry on an empty / malformed / truncated result. */
const ATTEMPTS_PER_CALL = 2;

// ── Content helpers ─────────────────────────────────────────────────────────────────────────

/** Items the planner may assign to chapters — everything that is not tree structure. */
function assignableItems(content) {
  return [...content.dated, ...content.undated].filter((i) => i.sourceType !== "tree_relation");
}

function relationItems(content) {
  return [...content.dated, ...content.undated].filter((i) => i.sourceType === "tree_relation");
}

/** The subject's own recorded words — interviews and Q&A — the voice the writer imitates. */
function voiceItems(content) {
  return [...content.undated, ...content.dated].filter(
    (i) => i.sourceType === "interview" || i.sourceType === "qa",
  );
}

function countWords(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function sourceWordCount(items) {
  return items.reduce((sum, i) => sum + i.wordCount, 0);
}

function describeSubject(subject) {
  const lines = [`Name: ${subject.fullName ?? "unknown"}`];
  if (subject.birthYear) {
    lines.push(`Born: ${subject.birthDate ?? subject.birthYear}${subject.birthPlace ? `, ${subject.birthPlace}` : ""}`);
  } else if (subject.birthPlace) {
    lines.push(`Birthplace: ${subject.birthPlace}`);
  }
  lines.push(subject.deathYear ? `Died: ${subject.deathDate ?? subject.deathYear}` : "Living.");
  return lines.join("\n");
}

function formatItem(item) {
  const head = [`[${item.sourceId}]`, item.sourceType, item.label ? `"${item.label}"` : null, item.date ?? (item.year ? String(item.year) : null)]
    .filter(Boolean)
    .join(" · ");
  const photo = item.photoRef ? `\n(photo attached: ${item.photoRef})` : "";
  return `${head}${photo}\n${item.text.trim()}`;
}

function formatRelation(item) {
  const r = item.relation;
  if (!r) return item.text;
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

function familyReference(content) {
  const rels = relationItems(content);
  if (!rels.length) return "FAMILY REFERENCE\n(no family tree recorded)";
  return `FAMILY REFERENCE (from the family tree; relationship is to the subject)\n${rels.map(formatRelation).join("\n")}`;
}

function voiceSample(content) {
  const items = voiceItems(content);
  if (!items.length) return "VOICE SAMPLE\n(the subject recorded no interviews or answers; write plainly)";
  return `VOICE SAMPLE — the subject's own recorded words, for cadence only\n\n${items
    .map((i) => i.text.trim())
    .join("\n\n")}`;
}

// ── Model call ──────────────────────────────────────────────────────────────────────────────

async function callModel(anthropic, req) {
  try {
    const params = {
      model: BOOK_MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    };
    if (req.jsonSchema) params.output_config = { format: { type: "json_schema", schema: req.jsonSchema } };
    const response = await anthropic.messages.create(params);
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    if (response.stop_reason === "refusal") {
      return { ok: false, error: `${req.label}: model refused (stop_reason=refusal)`, inputTokens, outputTokens };
    }
    if (response.stop_reason === "max_tokens") {
      return { ok: false, error: `${req.label}: truncated at max_tokens=${req.maxTokens}`, inputTokens, outputTokens };
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { ok: false, error: `${req.label}: empty response`, inputTokens, outputTokens };
    return { ok: true, text, inputTokens, outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[life-story-book] ${req.label} failed:`, message);
    return { ok: false, error: `${req.label}: ${message}`, inputTokens: 0, outputTokens: 0 };
  }
}

function addUsage(usage, outcome) {
  usage.calls += 1;
  usage.inputTokens += outcome.inputTokens;
  usage.outputTokens += outcome.outputTokens;
}

// ── Stage 1: plan ───────────────────────────────────────────────────────────────────────────

function plannerUserMessage(content) {
  const dated = content.dated.filter((i) => i.sourceType !== "tree_relation");
  const undated = content.undated.filter((i) => i.sourceType !== "tree_relation");
  const assignable = assignableItems(content);
  const sections = [
    `SUBJECT\n${describeSubject(content.subject)}`,
    familyReference(content),
    `DATED ITEMS (chronological)\n\n${dated.length ? dated.map(formatItem).join("\n\n") : "(none)"}`,
    `UNDATED ITEMS\n\n${undated.length ? undated.map(formatItem).join("\n\n") : "(none)"}`,
    `ASSIGNABLE SOURCE IDS (${assignable.length}; every source_ids entry must come from this list)\n${assignable
      .map((i) => i.sourceId)
      .join(", ")}`,
    `Total narrative words available: ${content.totalWordCount}. Plan the chapter count this material supports, within ${BOOK_PLAN_MIN_CHAPTERS} to ${BOOK_PLAN_MAX_CHAPTERS}.`,
  ];
  return sections.join("\n\n---\n\n");
}

function stripFences(text) {
  const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text;
}

/**
 * Turn the model's JSON into a validated BookPlan or an error string. Drops unknown ids and
 * empty chapters (warning each), renumbers sequentially, then enforces the chapter range.
 */
function parsePlan(raw, content) {
  let json;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (_) {
    return { error: "plan was not valid JSON" };
  }
  if (!json || typeof json !== "object") return { error: "plan JSON was not an object" };
  const obj = json;
  if (typeof obj.book_title !== "string" || !obj.book_title.trim()) return { error: "plan missing book_title" };
  if (!Array.isArray(obj.chapters)) return { error: "plan missing chapters array" };

  const known = new Set(assignableItems(content).map((i) => i.sourceId));
  const stageSet = new Set(ARC_STAGES);
  const warnings = [];
  const chapters = [];

  obj.chapters.forEach((c, idx) => {
    const ch = c && typeof c === "object" ? c : {};
    const title = typeof ch.title === "string" ? ch.title.trim() : "";
    const stage = typeof ch.arc_stage === "string" ? ch.arc_stage : "";
    const brief = typeof ch.brief === "string" ? ch.brief.trim() : "";
    const rawIds = Array.isArray(ch.source_ids) ? ch.source_ids.filter((s) => typeof s === "string") : [];
    const ids = [];
    for (const id of rawIds) {
      if (!known.has(id)) {
        warnings.push(`plan chapter ${idx + 1} "${title}": dropped unknown source id ${id}`);
        continue;
      }
      if (!ids.includes(id)) ids.push(id);
    }
    if (!title) {
      warnings.push(`plan chapter ${idx + 1}: dropped — no title`);
      return;
    }
    if (!stageSet.has(stage)) {
      warnings.push(`plan chapter ${idx + 1} "${title}": dropped — arc_stage "${stage}" not in vocabulary`);
      return;
    }
    if (!ids.length) {
      warnings.push(`plan chapter ${idx + 1} "${title}": dropped — no valid source ids`);
      return;
    }
    chapters.push({ chapterNumber: chapters.length + 1, title, arcStage: stage, brief, sourceIds: ids });
  });

  if (chapters.length < BOOK_PLAN_MIN_CHAPTERS || chapters.length > BOOK_PLAN_MAX_CHAPTERS) {
    return {
      error: `plan has ${chapters.length} usable chapter(s); need ${BOOK_PLAN_MIN_CHAPTERS}–${BOOK_PLAN_MAX_CHAPTERS}`,
    };
  }

  const assigned = new Set(chapters.flatMap((c) => c.sourceIds));
  const unassignedSourceIds = Array.from(known).filter((id) => !assigned.has(id));

  return { plan: { bookTitle: obj.book_title.trim(), chapters, unassignedSourceIds }, warnings };
}

/**
 * Validate a plan supplied as JSON text (a frozen tuning plan, or a stored plan) with the same
 * rules the planner's output goes through: same shape (book_title, chapters[] with
 * chapter_number / title / arc_stage / brief / source_ids), unknown ids dropped, empty chapters
 * dropped, sequential renumbering, chapter-count range enforced. No model call.
 */
function validatePlanJson(raw, content) {
  return parsePlan(raw, content);
}

/**
 * Stage 1. One model call (retried once on a malformed / truncated / empty result). Returns a
 * validated plan; never throws. Costs credits on every call.
 */
async function planBook(anthropic, content) {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const warnings = [];
  if (!assignableItems(content).length) {
    return { status: "failed", error: "no narrative items to plan from", usage, warnings };
  }
  const user = plannerUserMessage(content);
  let lastError = "plan: no attempt made";
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CALL; attempt++) {
    const outcome = await callModel(anthropic, {
      system: BOOK_PLANNER_SYSTEM_PROMPT,
      user,
      maxTokens: PLAN_MAX_TOKENS,
      label: `plan (attempt ${attempt})`,
      jsonSchema: BOOK_PLAN_JSON_SCHEMA,
    });
    addUsage(usage, outcome);
    if (!outcome.ok) {
      lastError = outcome.error;
      warnings.push(outcome.error);
      continue;
    }
    const parsed = parsePlan(outcome.text, content);
    if ("error" in parsed) {
      lastError = `plan (attempt ${attempt}): ${parsed.error}`;
      warnings.push(lastError);
      continue;
    }
    warnings.push(...parsed.warnings);
    return { status: "ok", plan: parsed.plan, usage, warnings };
  }
  return { status: "failed", error: lastError, usage, warnings };
}

// ── Stage 2: write one chapter ──────────────────────────────────────────────────────────────

function outline(plan, current) {
  return plan.chapters
    .map((c) => `${c.chapterNumber === current ? "→ " : "  "}${c.chapterNumber}. ${c.title} (${c.arcStage})`)
    .join("\n");
}

function lastParagraph(prose) {
  const paras = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras[paras.length - 1] ?? "";
}

function chapterUserMessage(content, plan, chapter, items, previousProse) {
  const sections = [
    `SUBJECT\n${describeSubject(content.subject)}`,
    `BOOK: "${plan.bookTitle}"\n\nOUTLINE (you are writing the chapter marked →)\n${outline(plan, chapter.chapterNumber)}`,
    `YOUR CHAPTER\n${chapter.chapterNumber}. ${chapter.title} — ${chapter.arcStage}\nBrief: ${chapter.brief || "(none)"}`,
    previousProse
      ? `CLOSING PARAGRAPH OF THE PREVIOUS CHAPTER (continue from it; do not repeat it)\n${lastParagraph(previousProse)}`
      : "This is the first chapter. There is nothing before it.",
    `SOURCE ITEMS FOR THIS CHAPTER (${items.length}) — with the family reference, the only place facts may come from\n\n${items
      .map(formatItem)
      .join("\n\n")}`,
    familyReference(content),
    voiceSample(content),
    `Write chapter ${chapter.chapterNumber}, "${chapter.title}". Prose, then the ${PROVENANCE_MARKER} block.`,
  ];
  return sections.join("\n\n---\n\n");
}

/** Paragraphs of the prose, split on blank lines — the same rule the writer is given. */
function paragraphsOf(prose) {
  return prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Split the writer's output into prose + provenance. Missing block ⇒ whole text is prose and
 * provenance is empty (warned, not retried — the prose is still usable; the verifier will
 * flag it). Unknown ids are dropped with a warning; paragraph-count mismatches and uncited
 * paragraphs are warned. Never throws.
 */
function parseChapterOutput(raw, allowedIds, label) {
  const warnings = [];
  const idx = raw.indexOf(PROVENANCE_MARKER);
  if (idx === -1) {
    warnings.push(`${label}: no ${PROVENANCE_MARKER} block — provenance empty`);
    return { prose: raw.trim(), provenance: [], warnings };
  }
  const prose = raw.slice(0, idx).trim();
  const block = raw.slice(idx + PROVENANCE_MARKER.length);
  const provenance = [];
  for (const line of block.split("\n")) {
    const m = line.trim().match(/^(\d+)\s*[:.)-]\s*(.*)$/);
    if (!m) continue;
    const paragraph = Number(m[1]);
    const ids = [];
    for (const tok of m[2].split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)) {
      if (!allowedIds.has(tok)) {
        warnings.push(`${label}: provenance paragraph ${paragraph} cites unknown id ${tok} — dropped`);
        continue;
      }
      if (!ids.includes(tok)) ids.push(tok);
    }
    provenance.push({ paragraph, sourceIds: ids });
  }
  const nParas = paragraphsOf(prose).length;
  if (provenance.length !== nParas) {
    warnings.push(`${label}: prose has ${nParas} paragraph(s) but provenance lists ${provenance.length}`);
  }
  for (const p of provenance) {
    if (!p.sourceIds.length) warnings.push(`${label}: paragraph ${p.paragraph} cites no known source`);
  }
  return { prose, provenance, warnings };
}

/**
 * Stage 2 for one chapter. One model call (retried once on an empty / truncated result).
 * `previousProse` is the finished previous chapter, for continuity; null for chapter 1.
 * Returns prose + provenance, or null; never throws. Costs credits on every call.
 */
async function writeChapter(anthropic, content, plan, chapter, previousProse, usage, warnings) {
  const byId = new Map(assignableItems(content).map((i) => [i.sourceId, i]));
  const items = chapter.sourceIds.map((id) => byId.get(id)).filter(Boolean);
  if (!items.length) {
    warnings.push(`chapter ${chapter.chapterNumber}: no source items resolved`);
    return null;
  }
  // Provenance may cite this chapter's items and any family-reference entry.
  const allowedIds = new Set([...chapter.sourceIds, ...relationItems(content).map((i) => i.sourceId)]);
  const user = chapterUserMessage(content, plan, chapter, items, previousProse);
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CALL; attempt++) {
    const label = `chapter ${chapter.chapterNumber} (attempt ${attempt})`;
    const outcome = await callModel(anthropic, { system: BOOK_CHAPTER_SYSTEM_PROMPT, user, maxTokens: CHAPTER_MAX_TOKENS, label });
    addUsage(usage, outcome);
    if (!outcome.ok) {
      warnings.push(outcome.error);
      continue;
    }
    const parsed = parseChapterOutput(outcome.text, allowedIds, `chapter ${chapter.chapterNumber}`);
    if (!parsed.prose) {
      warnings.push(`${label}: empty prose before provenance block`);
      continue;
    }
    warnings.push(...parsed.warnings);
    return { prose: parsed.prose, provenance: parsed.provenance };
  }
  return null;
}

// ── Orchestrator ────────────────────────────────────────────────────────────────────────────

/**
 * The full engine: plan, then chapters in order. Sequential by design — each chapter sees the
 * previous chapter's close. Never throws. Writes nothing. Costs credits on every call: the
 * caller decides whether generation is warranted BEFORE calling this.
 */
async function generateLifeStoryBook(anthropic, content, options = {}) {
  const { onProgress } = options;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const warnings = [];

  let plan;
  if (options.plan) {
    plan = options.plan;
    warnings.push(`plan: frozen plan supplied — Stage 1 skipped (${plan.chapters.length} chapters)`);
  } else {
    if (onProgress) onProgress({ kind: "plan_start" });
    const planned = await planBook(anthropic, content);
    usage.calls += planned.usage.calls;
    usage.inputTokens += planned.usage.inputTokens;
    usage.outputTokens += planned.usage.outputTokens;
    warnings.push(...planned.warnings);
    if (planned.status === "failed") {
      return { status: "failed", stage: "plan", error: planned.error, partial: { plan: null, chapters: [] }, usage, warnings };
    }
    plan = planned.plan;
  }
  if (onProgress) onProgress({ kind: "plan_done", plan });

  const byId = new Map(assignableItems(content).map((i) => [i.sourceId, i]));
  const chapters = [];
  let previousProse = null;

  for (const spec of plan.chapters) {
    if (onProgress) onProgress({ kind: "chapter_start", chapterNumber: spec.chapterNumber, title: spec.title });
    const written = await writeChapter(anthropic, content, plan, spec, previousProse, usage, warnings);
    if (!written) {
      return {
        status: "failed",
        stage: "chapter",
        chapterNumber: spec.chapterNumber,
        error: `chapter ${spec.chapterNumber} "${spec.title}" could not be written`,
        partial: { plan, chapters },
        usage,
        warnings,
      };
    }
    const photoRefs = spec.sourceIds
      .map((id) => byId.get(id))
      .filter((i) => !!i && i.sourceType === "photo_caption" && !!i.photoRef)
      .map((i) => i.photoRef);
    const chapter = {
      chapterNumber: spec.chapterNumber,
      title: spec.title,
      arcStage: spec.arcStage,
      prose: written.prose,
      sourceIds: spec.sourceIds,
      photoRefs,
      wordCount: countWords(written.prose),
      sourceWordCount: sourceWordCount(spec.sourceIds.map((id) => byId.get(id)).filter(Boolean)),
      provenance: written.provenance,
    };
    chapters.push(chapter);
    previousProse = written.prose;
    if (onProgress) onProgress({ kind: "chapter_done", chapter });
  }

  return {
    status: "ok",
    book: { model: BOOK_MODEL, subject: content.subject, plan, chapters, usage, warnings },
  };
}

module.exports = { BOOK_MODEL, generateLifeStoryBook, planBook, writeChapter, parseChapterOutput, validatePlanJson };
