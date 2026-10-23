import type { Cue } from "../types";

export interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
  acAsrConf?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  wWinId?: number;
  segs?: Json3Seg[];
}

export interface Json3Payload {
  events?: Json3Event[];
}

interface TimedToken {
  text: string;
  startMs: number;
  endMs: number;
  syllables: number;
}

const ABBREV_REGEX =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Fig|No|Vol|Inc|Ltd|Co)\.$|\b[A-Z]\.$/i;
const STRONG_PUNCT_REGEX = /[.?!。？！…]+["')\]）】》]*$/;
const CLAUSE_PUNCT_REGEX = /[,;:—，；：、]+["')\]）】》]*$/;
const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

// Closed-class English determiners & quantifiers
const DETERMINERS = new Set([
  "a",
  "an",
  "the",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "some",
  "any",
  "no",
  "every",
  "each",
  "all",
  "both",
  "half",
  "many",
  "few",
  "several",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
]);

// Closed-class function words that strictly cannot end a subtitle cue
const ALWAYS_HANGING_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "every",
  "each",
  "to",
  "of",
  "for",
  "with",
  "by",
  "from",
  "as",
  "into",
  "like",
  "than",
  "without",
  "through",
  "between",
  "until",
  "till",
  "against",
  "and",
  "or",
  "nor",
  "yet",
  "because",
  "since",
  "unless",
  "although",
  "though",
  "while",
  "if",
  "when",
  "where",
  "how",
  "what",
  "who",
  "whom",
  "whose",
  "which",
  "i",
  "he",
  "she",
  "we",
  "they",
  "i'm",
  "you're",
  "we're",
  "they're",
  "he's",
  "she's",
  "it's",
  "that's",
  "there's",
  "who's",
  "what's",
  "i'll",
  "you'll",
  "we'll",
  "they'll",
  "i'd",
  "you'd",
  "i've",
  "you've",
  "we've",
  "not",
  "quite",
  "very",
  "too",
  "more",
  "most",
  "such",
]);

// Closed-class auxiliaries, modals, strandable prepositions, and demonstratives
const SOFT_HANGING_WORDS = new Set([
  "in",
  "on",
  "at",
  "over",
  "under",
  "after",
  "before",
  "about",
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "can't",
  "couldn't",
  "shouldn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "some",
  "any",
  "no",
  "this",
  "that",
  "these",
  "those",
]);

// Closed-class prepositions, phrasal particles, and auxiliaries/copulas that attach to the preceding phrase/subject
const PHRASE_CONTINUERS = new Set([
  "for",
  "to",
  "with",
  "of",
  "from",
  "in",
  "on",
  "at",
  "by",
  "into",
  "like",
  "than",
  "without",
  "about",
  "through",
  "over",
  "under",
  "between",
  "after",
  "before",
  "until",
  "till",
  "against",
  "up",
  "down",
  "out",
  "off",
  "away",
  "back",
  "around",
  "along",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "am",
  "has",
  "have",
  "had",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "did",
  "does",
  "didn't",
  "doesn't",
  "won't",
  "wouldn't",
  "can't",
  "couldn't",
]);

// Closed-class nominative subject pronouns & unambiguous clause starters
const NOMINATIVE_STARTERS = new Set([
  "i",
  "i'm",
  "i'll",
  "i'd",
  "i've",
  "we",
  "we're",
  "they",
  "they're",
  "he",
  "she",
  "you're",
  "you'll",
  "you've",
  "that's",
  "there's",
  "who's",
  "it's",
  "maybe",
]);

const PURE_STARTERS = new Set([...NOMINATIVE_STARTERS, "now", "when", "if", "but", "look"]);

const GAP_STARTERS = new Set([
  "you",
  "this",
  "who",
  "what",
  "where",
  "why",
  "how",
  "so",
  "take",
  "lose",
  "and",
  "from",
  "do",
  "don't",
]);

const TIME_UNITS = new Set(["day", "week", "month", "year", "hour", "minute", "second", "time"]);

function hasCjk(text: string): boolean {
  return CJK_CHAR_REGEX.test(text);
}

function isSentenceEnd(text: string): boolean {
  const trimmed = text.trim();
  if (!STRONG_PUNCT_REGEX.test(trimmed)) return false;
  if (ABBREV_REGEX.test(trimmed)) return false;
  return true;
}

function isClauseEnd(text: string): boolean {
  return CLAUSE_PUNCT_REGEX.test(text.trim());
}

function normWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, "");
}

function countSyllables(word: string): number {
  if (/^\$?\d+$/.test(word)) return 3;
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const cleaned = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const matches = cleaned.match(/[aeiouy]{1,2}/g);
  return Math.max(1, matches ? matches.length : 1);
}

function joinTokens(tokens: TimedToken[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].text.replace(/\s+/g, " ").trim();
    if (!raw) continue;
    if (!out) {
      out = raw;
      continue;
    }
    const prevLast = out[out.length - 1];
    const currFirst = raw[0];
    const noSpaceAfter = /[\u3000-\u303f\u3040-\u9fff\uff00-\uffef([{"'“‘—-]/.test(prevLast);
    const noSpaceBefore =
      /[\u3000-\u303f\u3040-\u9fff\uff00-\uffef.,!?;:%)\]}"'”’—-]/.test(currFirst) ||
      /^'(?:s|t|re|ve|m|ll|d)\b/i.test(raw);

    if (noSpaceAfter || noSpaceBefore) {
      out += raw;
    } else {
      out += " " + raw;
    }
  }
  return out.trim();
}

function detectAsrTrack(events: Json3Event[], trackKind?: string): boolean {
  if (trackKind === "asr") return true;
  let offsetSegCount = 0;
  let appendCount = 0;
  for (const ev of events) {
    if (ev.aAppend === 1) appendCount++;
    if (ev.segs) {
      for (const s of ev.segs) {
        if (typeof s.tOffsetMs === "number" && s.tOffsetMs > 0) {
          offsetSegCount++;
        }
      }
    }
    if (offsetSegCount >= 5 || appendCount >= 3) return true;
  }
  return false;
}

/**
 * Dynamic Programming (Viterbi shortest-path) cue segmentation for unpunctuated ASR token streams.
 * Finds the globally optimal sequence of cue boundaries balancing:
 * - Acoustic silence gaps (syllable-duration compensated)
 * - Closed-class syntactic constraints (determiner phrases, prepositional attachment, clause starters)
 * - Balanced reading length & duration
 */
function segmentUnpunctuatedTokensDP(tokens: TimedToken[]): Cue[] {
  const n = tokens.length;
  if (n === 0) return [];

  const MAX_WORDS_PER_CUE = 18;
  const dpCost = new Float64Array(n + 1).fill(Infinity);
  const dpPrev = new Int32Array(n + 1).fill(0);
  dpCost[0] = 0;

  // Precompute boundary transition cost at split after token `j` (0 <= j < n - 1)
  const boundaryCost = new Float64Array(n);
  boundaryCost[n - 1] = -200; // End of stream is always a free natural boundary

  for (let j = 0; j < n - 1; j++) {
    const prev = j > 0 ? tokens[j - 1] : null;
    const curr = tokens[j];
    const next = tokens[j + 1];
    const afterNext = j + 2 < n ? tokens[j + 2] : null;

    const onsetDeltaMs = next.startMs - curr.startMs;
    const silenceGapMs = onsetDeltaMs - curr.syllables * 115;

    const normPrev = prev ? normWord(prev.text) : "";
    const normCurr = normWord(curr.text);
    const normNext = normWord(next.text);
    const normAfterNext = afterNext ? normWord(afterNext.text) : "";

    if (onsetDeltaMs >= 1400) {
      boundaryCost[j] = -600;
      continue;
    }

    const isNothingBut =
      (normCurr === "nothing" || normCurr === "anything" || normCurr === "none") &&
      normNext === "but";
    const nextIsNominative = NOMINATIVE_STARTERS.has(normNext);
    const nextIsPureStarter = PURE_STARTERS.has(normNext) && !isNothingBut;
    const nextIsGapStarter = GAP_STARTERS.has(normNext);

    // Subject "you" ("you grew", "you scream", "you controlled") vs object/embedded "you" ("on you", "with you", "which side you on")
    const prevIsWhNoun =
      prev !== null &&
      (normPrev === "which" || normPrev === "what" || normPrev === "whose" || normPrev === "whatever");
    const prevIsPrepOrDet =
      (PHRASE_CONTINUERS.has(normCurr) && !DETERMINERS.has(normPrev)) ||
      DETERMINERS.has(normCurr) ||
      ALWAYS_HANGING_WORDS.has(normCurr) ||
      prevIsWhNoun;
    const nextIsSubjectYou =
      normNext === "you" &&
      !prevIsPrepOrDet &&
      onsetDeltaMs >= 160 &&
      normAfterNext !== "" &&
      !PURE_STARTERS.has(normAfterNext) &&
      !GAP_STARTERS.has(normAfterNext) &&
      !PHRASE_CONTINUERS.has(normAfterNext) &&
      !DETERMINERS.has(normAfterNext);

    const isRatePhrase = normNext === "a" && TIME_UNITS.has(normAfterNext);
    const isDeterminerModifierPair =
      DETERMINERS.has(normPrev) &&
      !nextIsPureStarter &&
      !nextIsGapStarter &&
      !nextIsSubjectYou &&
      !PHRASE_CONTINUERS.has(normNext) &&
      silenceGapMs < 180;

    let cost = 0;

    // 1. Acoustic pause reward (bigger silence gap = much better split boundary)
    if (silenceGapMs >= 320) {
      cost -= Math.min(340, silenceGapMs * 0.65);
    } else if (silenceGapMs >= 160) {
      cost -= silenceGapMs * 0.48;
    } else if (silenceGapMs >= 60) {
      cost -= silenceGapMs * 0.2;
    } else {
      // Negative or zero silence gap (fast continuous speech)
      cost += 95;
    }

    // 2. Syntactic clause starter reward at `next`
    if (nextIsNominative || nextIsSubjectYou) {
      if (onsetDeltaMs >= 150) {
        cost -= 240;
      }
    } else if (nextIsPureStarter) {
      if (onsetDeltaMs >= 160) {
        cost -= 220;
      }
    } else if (nextIsGapStarter) {
      if (silenceGapMs >= 140 && onsetDeltaMs >= 340) {
        cost -= 140;
      }
    } else if (
      (normNext === "my" || normNext === "your") &&
      silenceGapMs >= 160 &&
      onsetDeltaMs >= 380
    ) {
      cost -= 150;
    } else if (
      (normNext === "my" || normNext === "your") &&
      silenceGapMs < 130 &&
      onsetDeltaMs < 300
    ) {
      cost += 240;
    }

    // 3. Syntactic constituent penalties (never split inside tight grammatical phrases)
    if (ALWAYS_HANGING_WORDS.has(normCurr) || isNothingBut) {
      cost += 2400;
    } else if (isDeterminerModifierPair) {
      cost += 520;
    } else if (
      SOFT_HANGING_WORDS.has(normCurr) &&
      !nextIsPureStarter &&
      !nextIsSubjectYou &&
      !(nextIsGapStarter && silenceGapMs >= 160)
    ) {
      cost += 460;
    }

    if (
      (PHRASE_CONTINUERS.has(normNext) || isRatePhrase) &&
      !nextIsPureStarter &&
      onsetDeltaMs < 850
    ) {
      cost += 220;
    }

    boundaryCost[j] = cost;
  }

  for (let i = 0; i < n; i++) {
    if (dpCost[i] === Infinity) continue;
    const firstNorm = normWord(tokens[i].text);
    const maxJ = Math.min(n - 1, i + MAX_WORDS_PER_CUE - 1);

    for (let j = i; j <= maxJ; j++) {
      const wordCount = j - i + 1;
      const durationMs = tokens[j].endMs - tokens[i].startMs;
      const nextToken = j + 1 < n ? tokens[j + 1] : null;
      const onsetDeltaAfter = nextToken ? nextToken.startMs - tokens[j].startMs : 2000;

      // Span length & duration cost (sweet spot: 4..10 words, ~1.3s..3.6s)
      let spanCost = 115; // base cost per cue so we split when boundaryCost <= -115
      if (wordCount <= 2 && onsetDeltaAfter < 1100) {
        spanCost += (3 - wordCount) * 320;
      } else if (wordCount === 3 && onsetDeltaAfter < 650) {
        spanCost += 80;
      } else if (wordCount >= 4 && wordCount <= 10) {
        spanCost -= 15;
      } else if (wordCount > 11) {
        spanCost += (wordCount - 11) * (wordCount - 11) * 28;
      }

      if (durationMs > 4200) {
        spanCost += ((durationMs - 4200) / 250) * 30;
      } else if (durationMs < 900 && onsetDeltaAfter < 900) {
        spanCost += 140;
      }

      // Conditional clause protection ("when X, that's Y" / "if X, you Y")
      let conditionalPenalty = 0;
      if (
        (firstNorm === "when" || firstNorm === "if") &&
        wordCount <= 6 &&
        nextToken
      ) {
        const nextNorm = normWord(nextToken.text);
        if (nextNorm === "that's" || nextNorm === "it's") {
          conditionalPenalty = 320;
        }
      }

      // Short subject protection: avoid splitting a short subject (<= 5 words) right before its finite verb/copula
      let shortSubjectVerbPenalty = 0;
      if (wordCount <= 5 && nextToken) {
        const nextNorm = normWord(nextToken.text);
        if (PHRASE_CONTINUERS.has(nextNorm)) {
          shortSubjectVerbPenalty = 320;
        }
      }

      const total =
        dpCost[i] + spanCost + boundaryCost[j] + conditionalPenalty + shortSubjectVerbPenalty;
      if (total < dpCost[j + 1]) {
        dpCost[j + 1] = total;
        dpPrev[j + 1] = i;
      }
    }
  }

  // Backtrack optimal boundaries
  const spans: Array<[number, number]> = [];
  let currEnd = n;
  while (currEnd > 0) {
    const start = dpPrev[currEnd];
    spans.push([start, currEnd - 1]);
    currEnd = start;
  }
  spans.reverse();

  const rawCues: Array<{ startMs: number; endMs: number; sourceText: string; wordCount: number }> =
    [];
  for (let s = 0; s < spans.length; s++) {
    const [startIdx, endIdx] = spans[s];
    const slice = tokens.slice(startIdx, endIdx + 1);
    const text = joinTokens(slice);
    if (!text) continue;
    const startMs = slice[0].startMs;
    const lastToken = slice[slice.length - 1];
    const nextStartMs = endIdx + 1 < n ? tokens[endIdx + 1].startMs : undefined;
    const naturalEnd = Math.max(startMs + 450, lastToken.endMs + 250);
    const endMs =
      typeof nextStartMs === "number" ? Math.min(nextStartMs, naturalEnd) : naturalEnd;

    rawCues.push({
      startMs,
      endMs,
      sourceText: text,
      wordCount: slice.length,
    });
  }

  // Merge 1-2 word orphan fragments into their nearest neighbor when gap is small
  const cues: Cue[] = [];
  for (let i = 0; i < rawCues.length; i++) {
    const curr = rawCues[i];
    if (curr.wordCount <= 2 && curr.sourceText.length <= 10) {
      const prev = cues[cues.length - 1];
      const next = rawCues[i + 1];
      const gapPrev = prev ? curr.startMs - prev.endMs : Infinity;
      const gapNext = next ? next.startMs - curr.endMs : Infinity;
      if (next && gapNext <= 900 && gapNext <= gapPrev) {
        next.startMs = curr.startMs;
        next.sourceText = `${curr.sourceText} ${next.sourceText}`;
        next.wordCount += curr.wordCount;
        continue;
      }
      if (prev && gapPrev <= 750) {
        prev.endMs = curr.endMs;
        prev.sourceText = `${prev.sourceText} ${curr.sourceText}`;
        continue;
      }
    }
    cues.push({
      index: cues.length,
      startMs: curr.startMs,
      endMs: curr.endMs,
      sourceText: curr.sourceText,
    });
  }

  return cues;
}

function buildCuesFromAsr(events: Json3Event[]): Cue[] {
  const tokens: TimedToken[] = [];

  for (const ev of events) {
    if (typeof ev.tStartMs !== "number" || !Array.isArray(ev.segs)) continue;
    const baseStart = ev.tStartMs;

    for (const seg of ev.segs) {
      if (!seg.utf8) continue;
      const cleaned = seg.utf8.replace(/\n/g, " ").trim();
      if (!cleaned || /^\[.*\]$/i.test(cleaned)) continue;
      const startMs = baseStart + (typeof seg.tOffsetMs === "number" ? seg.tOffsetMs : 0);
      const syllables = countSyllables(cleaned);
      const estDur = Math.min(520, Math.max(120, syllables * 115));
      tokens.push({
        text: cleaned,
        startMs,
        endMs: startMs + estDur,
        syllables,
      });
    }
  }

  if (tokens.length === 0) return [];

  let punctuatedCount = 0;
  for (let i = 0; i < Math.min(tokens.length, 150); i++) {
    if (STRONG_PUNCT_REGEX.test(tokens[i].text)) {
      punctuatedCount++;
    }
  }
  const hasAutoPunctuation = punctuatedCount >= 2;

  if (!hasAutoPunctuation) {
    return segmentUnpunctuatedTokensDP(tokens);
  }

  // Punctuated ASR track: segment primarily by punctuation and clause boundaries
  const cues: Cue[] = [];
  let buffer: TimedToken[] = [];

  const flushBuffer = (nextStartMs?: number) => {
    if (buffer.length === 0) return;
    const text = joinTokens(buffer);
    if (text) {
      const startMs = buffer[0].startMs;
      const lastToken = buffer[buffer.length - 1];
      const naturalEnd = Math.max(startMs + 450, lastToken.endMs + 250);
      const endMs =
        typeof nextStartMs === "number" ? Math.min(nextStartMs, naturalEnd) : naturalEnd;
      cues.push({
        index: cues.length,
        startMs,
        endMs,
        sourceText: text,
      });
    }
    buffer = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    buffer.push(token);

    const nextToken = tokens[i + 1];
    if (!nextToken) {
      flushBuffer();
      break;
    }

    const onsetDeltaMs = nextToken.startMs - token.startMs;
    const durationMs = token.endMs - buffer[0].startMs;
    const currentText = joinTokens(buffer);
    const isCjkText = hasCjk(currentText);

    const charLimit = isCjkText ? 38 : 98;
    const softCharLimit = isCjkText ? 22 : 54;
    const maxTokens = isCjkText ? 24 : 20;
    const softTokens = isCjkText ? 11 : 10;

    const hitStrongPunct = isSentenceEnd(token.text);
    const hitClausePunct = isClauseEnd(token.text);
    const normCurr = normWord(token.text);
    const isStrictHanging = !isCjkText && ALWAYS_HANGING_WORDS.has(normCurr);

    if (onsetDeltaMs >= 1500 && buffer.length >= 3) {
      flushBuffer(nextToken.startMs);
      continue;
    }

    if (hitStrongPunct) {
      flushBuffer(nextToken.startMs);
      continue;
    }

    if (isStrictHanging && buffer.length < maxTokens + 3) {
      continue;
    }

    const hitClauseBreak =
      hitClausePunct &&
      (buffer.length >= softTokens || currentText.length >= softCharLimit || durationMs >= 3800);
    const hitHardCap =
      buffer.length >= maxTokens || currentText.length >= charLimit || durationMs >= 7500;

    if (hitClauseBreak || hitHardCap) {
      flushBuffer(nextToken.startMs);
    }
  }

  flushBuffer();

  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endMs > cues[i + 1].startMs) {
      cues[i].endMs = cues[i + 1].startMs;
    }
  }

  return cues;
}

function buildCuesFromManual(events: Json3Event[]): Cue[] {
  const rawCues: Array<{ startMs: number; endMs: number; text: string }> = [];

  for (const ev of events) {
    if (typeof ev.tStartMs !== "number" || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!rawText) continue;

    const startMs = ev.tStartMs;
    const durationMs =
      typeof ev.dDurationMs === "number" && ev.dDurationMs > 0 ? ev.dDurationMs : 2500;
    const endMs = startMs + durationMs;

    const prev = rawCues[rawCues.length - 1];
    if (prev && prev.text === rawText && Math.abs(prev.startMs - startMs) < 200) {
      prev.endMs = Math.max(prev.endMs, endMs);
      continue;
    }

    rawCues.push({ startMs, endMs, text: rawText });
  }

  if (rawCues.length === 0) return [];

  for (let i = 0; i < rawCues.length - 1; i++) {
    if (rawCues[i].endMs > rawCues[i + 1].startMs) {
      rawCues[i].endMs = rawCues[i + 1].startMs;
    }
  }

  const merged: Cue[] = [];
  for (let i = 0; i < rawCues.length; i++) {
    const curr = rawCues[i];
    const prev = merged[merged.length - 1];

    if (prev) {
      const gapMs = curr.startMs - prev.endMs;
      const combinedDuration = curr.endMs - prev.startMs;
      const isCjkText = hasCjk(prev.sourceText) || hasCjk(curr.text);
      const maxMergedLen = isCjkText ? 34 : 80;
      const sep = isCjkText ? "" : " ";
      const combinedText = `${prev.sourceText}${sep}${curr.text}`;

      const prevEndsSentence = isSentenceEnd(prev.sourceText);
      const looksLikeContinuation =
        !prevEndsSentence &&
        gapMs >= 0 &&
        gapMs <= 150 &&
        combinedDuration <= 6000 &&
        combinedText.length <= maxMergedLen;

      if (looksLikeContinuation) {
        prev.endMs = curr.endMs;
        prev.sourceText = combinedText;
        continue;
      }
    }

    merged.push({
      index: merged.length,
      startMs: curr.startMs,
      endMs: curr.endMs,
      sourceText: curr.text,
    });
  }

  return merged;
}

export function parseJson3ToCues(payload: Json3Payload, trackKind?: string): Cue[] {
  const events = payload?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const isAsr = detectAsrTrack(events, trackKind);
  return isAsr ? buildCuesFromAsr(events) : buildCuesFromManual(events);
}

export function findActiveCueIndex(cues: Cue[], timeMs: number): number {
  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const cue = cues[mid];
    if (timeMs < cue.startMs) {
      high = mid - 1;
    } else if (timeMs > cue.endMs) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

export function findCurrentOrNextCueIndex(cues: Cue[], timeMs: number): number {
  if (cues.length === 0) return -1;
  let low = 0;
  let high = cues.length - 1;
  let result = cues.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].endMs >= timeMs) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}
