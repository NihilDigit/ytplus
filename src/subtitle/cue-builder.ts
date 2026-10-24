import type { Cue } from "../types";

export interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
  acAsrConf?: number;
  isSpeakerChange?: number;
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
  eventEndMs: number;
  syllables: number;
  isSpeakerChange?: boolean;
}

const STRICT_ABBREV_REGEX =
  /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|v|etc|e\.g|i\.e|Fig|No|Vol|Capt|Gen|Gov|Sen|Rep|Rev|Hon|Pres|Bros)\.$/i;
const CORP_OR_COUNTRY_ABBREV_REGEX =
  /^(?:Inc|Ltd|Co|Corp|Ph\.D|M\.D|B\.A|M\.A|U\.S|U\.K|E\.U|U\.N)\.$/i;
const SINGLE_INITIAL_REGEX = /^[A-Z]\.$/;
const STRONG_PUNCT_REGEX = /[.?!。？！…]+["')\]）】》”’]*$/;
const CLAUSE_PUNCT_REGEX = /[,;:—–，；：、]+["')\]）】》”’]*$/;
const CJK_CHAR_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const NON_SPEECH_TAG_REGEX =
  /\[(?:music|applause|laughter|laughing|cheering|sighs|sighing|gasps|groans|coughs|♪|[^\]]*(?:music|applause|laughter|cheering|sound|sfx|noise|audio)[^\]]*)\]|\((?:music|applause|laughter|laughing|cheering|sighs|gasps|♪)\)|♪+/gi;

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

const CLAUSE_STARTER_CONJUNCTIONS = new Set([
  "because",
  "although",
  "though",
  "unless",
  "while",
  "whereas",
  "since",
  "until",
  "till",
  "whether",
  "which",
  "where",
  "when",
  "whenever",
  "wherever",
  "but",
  "yet",
  "so",
  "if",
]);

const PREP_BREAK_STARTERS = new Set([
  "into",
  "from",
  "through",
  "between",
  "without",
  "against",
  "under",
  "over",
  "during",
  "including",
  "compared",
  "according",
  "despite",
  "towards",
  "toward",
  "within",
  "throughout",
  "across",
  "among",
  "beyond",
  "before",
  "after",
]);

const INTRO_ADVERBS = new Set([
  "now",
  "however",
  "instead",
  "meanwhile",
  "therefore",
  "thus",
  "furthermore",
  "moreover",
  "nevertheless",
  "nonetheless",
  "otherwise",
  "today",
  "yesterday",
  "finally",
  "eventually",
  "fortunately",
  "unfortunately",
  "surprisingly",
  "interestingly",
  "basically",
  "essentially",
  "overall",
  "first",
  "second",
  "third",
  "next",
  "then",
  "so",
  "well",
  "plus",
  "also",
]);

function hasCjk(text: string): boolean {
  return CJK_CHAR_REGEX.test(text);
}

function stripTrailingClosers(word: string): string {
  return word.replace(/["')\]）】》”’]+$/g, "");
}

function isSentenceEnd(
  text: string,
  prevText?: string,
  nextText?: string,
  onsetDeltaToNextMs?: number,
): boolean {
  const trimmed = text.trim();
  if (!STRONG_PUNCT_REGEX.test(trimmed)) return false;

  const core = stripTrailingClosers(trimmed);
  if (/[?!。？！…]$/.test(core)) {
    return true;
  }

  // Must end with '.'
  const lastWord = core.split(/\s+/).pop() || core;
  if (STRICT_ABBREV_REGEX.test(lastWord)) {
    return typeof onsetDeltaToNextMs === "number" && onsetDeltaToNextMs >= 1500;
  }

  if (SINGLE_INITIAL_REGEX.test(lastWord)) {
    // e.g. "James B. Duke" -> not a sentence end unless followed by a huge pause
    return typeof onsetDeltaToNextMs === "number" && onsetDeltaToNextMs >= 1400;
  }

  if (CORP_OR_COUNTRY_ABBREV_REGEX.test(lastWord)) {
    if (!nextText) return true;
    const nextClean = nextText.replace(/^["'(（【《“‘]+/, "");
    if (/^[a-z]/.test(nextClean)) return false;
    return true;
  }

  // If the next word starts with a lowercase letter and there is no meaningful pause,
  // treat as an inline abbreviation/decimal rather than a full sentence stop.
  if (nextText) {
    const nextClean = nextText.replace(/^["'(（【《“‘]+/, "");
    if (
      /^[a-z]/.test(nextClean) &&
      (typeof onsetDeltaToNextMs !== "number" || onsetDeltaToNextMs < 400)
    ) {
      return false;
    }
  }

  void prevText;
  return true;
}

function isClauseEnd(text: string): boolean {
  return CLAUSE_PUNCT_REGEX.test(text.trim());
}

function cleanSegmentText(
  rawUtf8: string,
  segSpeakerFlag?: number,
): { text: string; hasSpeakerChange: boolean } {
  const normalized = rawUtf8.replace(/[\r\n\u00a0]+/g, " ");
  const hasSpeakerChange =
    segSpeakerFlag === 1 || /(?:^|\s)>>+\s*/.test(normalized);
  const withoutTags = normalized
    .replace(NON_SPEECH_TAG_REGEX, " ")
    .replace(/(?:^|\s)>>+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!withoutTags || /^\[.*\]$/i.test(withoutTags)) {
    return { text: "", hasSpeakerChange };
  }
  return { text: withoutTags, hasSpeakerChange };
}

function normWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, "");
}

function countSyllables(word: string): number {
  const cleanPunct = word.replace(/[^a-zA-Z0-9']/g, "");
  if (/^\d+$/.test(cleanPunct)) {
    return Math.max(2, cleanPunct.length);
  }
  // Initialisms/acronyms like CNTC, STMA, USA, FBI are spoken letter-by-letter
  const upperMatches = cleanPunct.match(/[A-Z]/g);
  if (upperMatches && upperMatches.length >= 2 && cleanPunct === cleanPunct.toUpperCase()) {
    return Math.min(8, upperMatches.length);
  }
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
  const mergedCues: Cue[] = [];
  for (let i = 0; i < rawCues.length; i++) {
    const curr = rawCues[i];
    if (curr.wordCount <= 2 && curr.sourceText.length <= 10) {
      const prev = mergedCues[mergedCues.length - 1];
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
    mergedCues.push({
      index: mergedCues.length,
      startMs: curr.startMs,
      endMs: curr.endMs,
      sourceText: curr.sourceText,
    });
  }

  return normalizeCueTimings(mergedCues);
}

/**
 * Normalizes cue display durations and bridges short inter-cue breath gaps so subtitles
 * stay comfortably readable on screen instead of flashing and disappearing prematurely.
 */
function normalizeCueTimings(
  cues: Cue[],
  eventEndBounds?: number[],
): Cue[] {
  if (cues.length === 0) return [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const nextCue = i + 1 < cues.length ? cues[i + 1] : null;
    const isCjk = hasCjk(cue.sourceText);

    // Minimum comfortable reading duration based on character count (~18 chars/sec EN, ~9 chars/sec CJK)
    const minReadingDurationMs = Math.min(
      4200,
      Math.max(1250, Math.round(cue.sourceText.length * (isCjk ? 105 : 52))),
    );
    const minDesiredEndMs = cue.startMs + minReadingDurationMs;

    // Post-speech hold: allow at least 650ms after estimated phonetic end, bounded by eventEndMs
    const rawSpeechEndMs = cue.endMs;
    const eventBound = eventEndBounds?.[i];
    const maxHoldCapMs =
      typeof eventBound === "number" && eventBound > rawSpeechEndMs
        ? Math.min(eventBound, rawSpeechEndMs + 2200)
        : rawSpeechEndMs + 1600;

    let targetEndMs = Math.min(
      maxHoldCapMs,
      Math.max(minDesiredEndMs, rawSpeechEndMs + 650),
    );

    if (nextCue) {
      if (nextCue.startMs < cue.startMs) {
        nextCue.startMs = cue.startMs;
      }
      // Never overlap the next cue
      targetEndMs = Math.min(nextCue.startMs, targetEndMs);

      // Smooth gap bridging: if the remaining silence before the next cue is a short breath pause
      // (<= 1100ms), extend current cue seamlessly to nextCue.startMs to eliminate flicker.
      const remainingGapMs = nextCue.startMs - targetEndMs;
      if (remainingGapMs > 0 && remainingGapMs <= 1100) {
        targetEndMs = nextCue.startMs;
      }

      cue.endMs = Math.min(
        nextCue.startMs,
        Math.max(cue.startMs, targetEndMs),
      );
    } else {
      cue.endMs = Math.max(cue.startMs + 200, targetEndMs);
    }

    cue.index = i;
  }

  return cues;
}

/**
 * Balanced Intra-Sentence Dynamic Programming (Optimal Clause Partitioning).
 * Splits a single long punctuated sentence into balanced, syntactically natural breath-group cues
 * without ever leaving 1-2 word orphan tails ("it.", "way.", "purposes.", "in 2024.").
 */
function splitSentenceIntoBreathGroupsDP(
  sentTokens: TimedToken[],
): TimedToken[][] {
  const m = sentTokens.length;
  if (m === 0) return [];

  const fullText = joinTokens(sentTokens);
  const isCjk = hasCjk(fullText);
  const totalChars = fullText.length;
  const totalDurationMs =
    sentTokens[m - 1].endMs - sentTokens[0].startMs;

  const hasInternalComma = sentTokens
    .slice(1, Math.max(1, m - 2))
    .some((t) => isClauseEnd(t.text));

  const singleCueCharCap = isCjk
    ? 32
    : hasInternalComma
      ? 74
      : 90;
  const singleCueWordCap = isCjk ? 20 : hasInternalComma ? 14 : 16;

  if (
    m <= singleCueWordCap &&
    totalChars <= singleCueCharCap &&
    totalDurationMs <= 5000
  ) {
    return [sentTokens];
  }

  const idealParts = Math.max(
    2,
    Math.round(totalChars / (isCjk ? 22 : 54)),
  );
  const targetChars = totalChars / idealParts;
  const maxWordsPerPart = isCjk ? 22 : 17;
  const maxCharsPerPart = isCjk ? 38 : 88;

  // Precompute internal boundary transition score after sentTokens[b] (0 <= b < m - 1)
  const splitTransitionCost = new Float64Array(m);
  splitTransitionCost[m - 1] = 0;

  for (let b = 0; b < m - 1; b++) {
    const prev = b > 0 ? sentTokens[b - 1] : null;
    const curr = sentTokens[b];
    const next = sentTokens[b + 1];
    const afterNext = b + 2 < m ? sentTokens[b + 2] : null;

    const normPrev = prev ? normWord(prev.text) : "";
    const normCurr = normWord(curr.text);
    const normNext = normWord(next.text);
    const normAfterNext = afterNext ? normWord(afterNext.text) : "";

    const onsetDeltaMs = next.startMs - curr.startMs;
    const silenceGapMs = onsetDeltaMs - curr.syllables * 110;

    let cost = 0;

    // 1. Strict syntactic constituent protection (never split inside tight grammatical pairs)
    const isCompoundConnector =
      (normCurr === "so" && normNext === "that") ||
      (normCurr === "and" &&
        (normNext === "then" ||
          normNext === "so" ||
          normNext === "yet" ||
          normNext === "also" ||
          normNext === "still")) ||
      (normPrev === "and" &&
        (normCurr === "then" ||
          normCurr === "so" ||
          normCurr === "yet" ||
          normCurr === "also" ||
          normCurr === "still")) ||
      (normCurr === "more" && normNext === "than") ||
      (normCurr === "less" && normNext === "than") ||
      (normCurr === "rather" && normNext === "than") ||
      (normCurr === "other" && normNext === "than") ||
      (normCurr === "up" && normNext === "to") ||
      (normCurr === "such" && normNext === "as") ||
      (normCurr === "as" && normNext === "well") ||
      (normCurr === "in" && normNext === "order") ||
      (normCurr === "even" && (normNext === "though" || normNext === "if"));

    const isTightDetNoun =
      DETERMINERS.has(normCurr) && !isClauseEnd(curr.text);
    const isTightModifierNoun =
      DETERMINERS.has(normPrev) &&
      !isClauseEnd(curr.text) &&
      !CLAUSE_STARTER_CONJUNCTIONS.has(normNext) &&
      !PREP_BREAK_STARTERS.has(normNext) &&
      !PHRASE_CONTINUERS.has(normNext);

    if (
      (!isCjk && ALWAYS_HANGING_WORDS.has(normCurr) && !isClauseEnd(curr.text)) ||
      isCompoundConnector ||
      isTightDetNoun
    ) {
      cost += 3600;
    } else if (
      !isCjk &&
      SOFT_HANGING_WORDS.has(normCurr) &&
      !isClauseEnd(curr.text)
    ) {
      cost += 1600;
    } else if (!isCjk && isTightModifierNoun) {
      cost += 650;
    }

    // Avoid splitting right before a short auxiliary/copula attached to a short subject
    if (
      !isCjk &&
      b <= 3 &&
      (normNext === "is" ||
        normNext === "are" ||
        normNext === "was" ||
        normNext === "were" ||
        normNext === "has" ||
        normNext === "have" ||
        normNext === "had" ||
        normNext === "will" ||
        normNext === "would" ||
        normNext === "can" ||
        normNext === "could") &&
      !isClauseEnd(curr.text)
    ) {
      cost += 750;
    }

    // 2. Clause punctuation & syntactic break rewards
    if (isClauseEnd(curr.text)) {
      // Avoid splitting right after a 1-word introductory adverb like "Now," or "Instead,"
      if (b === 0 || (b === 1 && INTRO_ADVERBS.has(normCurr))) {
        cost += 220;
      } else {
        cost -= 320;
      }
    } else if (CLAUSE_STARTER_CONJUNCTIONS.has(normNext)) {
      cost -= 230;
    } else if (normNext === "and" || normNext === "or") {
      // Reward splitting before "and"/"or" especially when followed by a verb/clause or determiner phrase
      const tailWords = m - 1 - b;
      const looksLikeClauseCoord =
        NOMINATIVE_STARTERS.has(normAfterNext) ||
        PHRASE_CONTINUERS.has(normAfterNext) ||
        DETERMINERS.has(normAfterNext) ||
        normAfterNext === "it" ||
        normAfterNext === "they" ||
        normAfterNext === "this" ||
        normAfterNext === "that" ||
        normAfterNext === "then" ||
        normAfterNext === "just" ||
        normAfterNext === "also" ||
        normAfterNext === "even" ||
        normAfterNext === "once" ||
        normAfterNext === "when" ||
        normAfterNext === "if";
      cost -= looksLikeClauseCoord ? 210 : tailWords >= 4 ? 115 : 30;
    } else if (
      PREP_BREAK_STARTERS.has(normNext) ||
      (normNext === "to" && normAfterNext !== "" && !DETERMINERS.has(normAfterNext))
    ) {
      cost -= 110;
    }

    // 3. Acoustic pause bonus
    if (silenceGapMs >= 80) {
      cost -= Math.min(180, silenceGapMs * 0.45);
    }

    splitTransitionCost[b] = cost;
  }

  const dpCost = new Float64Array(m + 1).fill(Infinity);
  const dpPrev = new Int32Array(m + 1).fill(0);
  dpCost[0] = 0;

  for (let a = 0; a < m; a++) {
    if (dpCost[a] === Infinity) continue;
    const maxB = Math.min(m - 1, a + maxWordsPerPart + 3);

    for (let b = a; b <= maxB; b++) {
      const slice = sentTokens.slice(a, b + 1);
      const wordCount = b - a + 1;
      const subText = joinTokens(slice);
      const charLen = subText.length;
      const durMs = sentTokens[b].endMs - sentTokens[a].startMs;

      let segCost = 155; // base cost per sub-cue

      // Strictly forbid 1-2 word or tiny orphan fragments
      if (wordCount <= 2 || charLen < (isCjk ? 5 : 13)) {
        segCost += 4800 + (3 - Math.min(3, wordCount)) * 1500;
      } else if (wordCount === 3 && charLen < (isCjk ? 8 : 18)) {
        segCost += 420;
      }

      // Balance penalty around targetChars
      const charDiff = charLen - targetChars;
      segCost += (charDiff / 7.5) * (charDiff / 7.5) * 16;

      if (charLen > maxCharsPerPart) {
        const excess = charLen - maxCharsPerPart;
        segCost += 600 + excess * excess * 12;
      }
      if (wordCount > maxWordsPerPart) {
        const excessW = wordCount - maxWordsPerPart;
        segCost += 450 + excessW * excessW * 90;
      }
      if (durMs > 5400) {
        segCost += ((durMs - 5400) / 200) * 45;
      }

      const total = dpCost[a] + segCost + splitTransitionCost[b];
      if (total < dpCost[b + 1]) {
        dpCost[b + 1] = total;
        dpPrev[b + 1] = a;
      }
    }
  }

  const parts: TimedToken[][] = [];
  let curr = m;
  while (curr > 0) {
    const start = dpPrev[curr];
    parts.push(sentTokens.slice(start, curr));
    curr = start;
  }
  parts.reverse();
  return parts;
}

function segmentPunctuatedTokens(tokens: TimedToken[]): Cue[] {
  if (tokens.length === 0) return [];

  // Stage 1: Partition token stream into complete natural sentences / utterances
  const sentences: TimedToken[][] = [];
  let currentSentence: TimedToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    currentSentence.push(token);

    const prevToken = i > 0 ? tokens[i - 1] : undefined;
    const nextToken = i + 1 < tokens.length ? tokens[i + 1] : undefined;
    if (!nextToken) {
      sentences.push(currentSentence);
      currentSentence = [];
      break;
    }

    const onsetDeltaMs = nextToken.startMs - token.startMs;
    const silenceGapMs = onsetDeltaMs - token.syllables * 115;
    const normCurr = normWord(token.text);

    // 1. Long acoustic silence break, compensated for multi-syllable words/acronyms (like CNTC/STMA)
    const minSilenceForBreak =
      currentSentence.length <= 2 && !STRONG_PUNCT_REGEX.test(token.text)
        ? 1700
        : 1150;
    if (silenceGapMs >= minSilenceForBreak && !ALWAYS_HANGING_WORDS.has(normCurr)) {
      sentences.push(currentSentence);
      currentSentence = [];
      continue;
    }

    // 2. Sentence-ending punctuation (. ? ! 。 ？ ！ …) with abbreviation/initial disambiguation
    if (
      isSentenceEnd(
        token.text,
        prevToken?.text,
        nextToken.text,
        onsetDeltaMs,
      )
    ) {
      sentences.push(currentSentence);
      currentSentence = [];
      continue;
    }

    // 3. Genuine speaker change marker (>> followed by capitalized utterance or pause, not mid-sentence ">> [music] >> and")
    if (
      nextToken.isSpeakerChange &&
      !ALWAYS_HANGING_WORDS.has(normCurr) &&
      !SOFT_HANGING_WORDS.has(normCurr) &&
      (onsetDeltaMs >= 550 || /^[A-Z"“'‘]/.test(nextToken.text))
    ) {
      sentences.push(currentSentence);
      currentSentence = [];
      continue;
    }
  }

  if (currentSentence.length > 0) {
    sentences.push(currentSentence);
  }

  // Stage 2: Split long/compound sentences into balanced breath-group cues via DP
  const rawSlices: TimedToken[][] = [];
  for (const sent of sentences) {
    const subParts = splitSentenceIntoBreathGroupsDP(sent);
    for (const part of subParts) {
      if (part.length > 0) {
        rawSlices.push(part);
      }
    }
  }

  // Stage 3: Merge any ultra-short (< 700ms window) 1-2 word micro-utterance (e.g. "Good evening.")
  // into the immediately following slice when they are spoken back-to-back without pause.
  const mergedSlices: TimedToken[][] = [];
  for (let i = 0; i < rawSlices.length; i++) {
    const slice = rawSlices[i];
    const nextSlice = i + 1 < rawSlices.length ? rawSlices[i + 1] : null;
    if (
      nextSlice &&
      slice.length <= 2 &&
      nextSlice[0].startMs - slice[0].startMs < 700
    ) {
      const combined = [...slice, ...nextSlice];
      if (joinTokens(combined).length <= 84) {
        rawSlices[i + 1] = combined;
        continue;
      }
    }
    mergedSlices.push(slice);
  }

  // Stage 4: Assemble cues and normalize display durations + breath-gap bridging
  const cues: Cue[] = [];
  const eventEndBounds: number[] = [];

  for (let i = 0; i < mergedSlices.length; i++) {
    const slice = mergedSlices[i];
    const text = joinTokens(slice);
    if (!text) continue;
    const lastToken = slice[slice.length - 1];
    cues.push({
      index: cues.length,
      startMs: slice[0].startMs,
      endMs: lastToken.endMs,
      sourceText: text,
    });
    eventEndBounds.push(lastToken.eventEndMs);
  }

  return normalizeCueTimings(cues, eventEndBounds);
}

function extractTokensFromAsrEvents(events: Json3Event[]): TimedToken[] {
  const tokens: TimedToken[] = [];
  let carrySpeakerChange = false;

  for (const ev of events) {
    if (typeof ev.tStartMs !== "number" || !Array.isArray(ev.segs)) continue;
    if (ev.aAppend === 1 && ev.segs.length === 1 && ev.segs[0].utf8 === "\n") {
      continue;
    }

    const baseStart = ev.tStartMs;
    const evDuration =
      typeof ev.dDurationMs === "number" && ev.dDurationMs > 0
        ? ev.dDurationMs
        : 3200;
    const eventEndMs = baseStart + evDuration;

    for (let sIdx = 0; sIdx < ev.segs.length; sIdx++) {
      const seg = ev.segs[sIdx];
      if (!seg.utf8) continue;

      const { text: cleaned, hasSpeakerChange } = cleanSegmentText(
        seg.utf8,
        seg.isSpeakerChange,
      );
      if (!cleaned) {
        if (hasSpeakerChange) {
          carrySpeakerChange = true;
        }
        continue;
      }

      const segStartMs =
        baseStart + (typeof seg.tOffsetMs === "number" ? seg.tOffsetMs : 0);

      // Find next segment onset in the same event (or next event start) to bound multi-word segment interpolation
      let nextSegStartMs = eventEndMs;
      for (let k = sIdx + 1; k < ev.segs.length; k++) {
        if (typeof ev.segs[k].tOffsetMs === "number") {
          nextSegStartMs = baseStart + ev.segs[k].tOffsetMs!;
          break;
        }
      }

      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length === 1) {
        const word = words[0];
        const syllables = countSyllables(word);
        const estDur = Math.min(540, Math.max(130, syllables * 115));
        tokens.push({
          text: word,
          startMs: segStartMs,
          endMs: segStartMs + estDur,
          eventEndMs,
          syllables,
          isSpeakerChange: hasSpeakerChange || carrySpeakerChange,
        });
        carrySpeakerChange = false;
      } else {
        // Multi-word segment: distribute onset times proportionally by syllable count,
        // strictly bounded by nextSegStartMs when nextSegStartMs > segStartMs.
        const wordSyllables = words.map((w) => countSyllables(w));
        const totalSyllables = wordSyllables.reduce((a, b) => a + b, 0) || 1;
        const availableWindowMs =
          nextSegStartMs > segStartMs
            ? nextSegStartMs - segStartMs
            : totalSyllables * 150;
        const spanMs = Math.min(
          availableWindowMs,
          Math.max(words.length * 40, totalSyllables * 150),
        );
        let cursorMs = segStartMs;
        for (let wIdx = 0; wIdx < words.length; wIdx++) {
          const w = words[wIdx];
          const syl = wordSyllables[wIdx];
          const rawDur = Math.round((spanMs * syl) / totalSyllables);
          const maxAllowedEnd =
            nextSegStartMs > segStartMs ? nextSegStartMs : segStartMs + spanMs;
          const nextCursor =
            wIdx === words.length - 1
              ? Math.min(maxAllowedEnd, cursorMs + Math.max(1, rawDur))
              : Math.min(maxAllowedEnd, cursorMs + Math.max(1, rawDur));
          const phoneticDur = Math.max(80, Math.min(540, rawDur || 120));
          tokens.push({
            text: w,
            startMs: cursorMs,
            endMs: Math.min(maxAllowedEnd, cursorMs + phoneticDur),
            eventEndMs,
            syllables: syl,
            isSpeakerChange:
              wIdx === 0 ? hasSpeakerChange || carrySpeakerChange : false,
          });
          cursorMs = nextCursor;
        }
        carrySpeakerChange = false;
      }
    }
  }

  return tokens;
}

export function hasAsrAutoPunctuation(events: Json3Event[]): boolean {
  const tokens = extractTokensFromAsrEvents(events);
  if (tokens.length === 0) return false;
  const sampleLimit = Math.min(tokens.length, 160);
  let punctuatedCount = 0;
  for (let i = 0; i < sampleLimit; i++) {
    const prev = i > 0 ? tokens[i - 1].text : undefined;
    const next = i + 1 < tokens.length ? tokens[i + 1].text : undefined;
    const delta =
      i + 1 < tokens.length ? tokens[i + 1].startMs - tokens[i].startMs : 2000;
    if (isSentenceEnd(tokens[i].text, prev, next, delta)) {
      punctuatedCount++;
    }
  }
  return punctuatedCount >= 2;
}

function phoneticSkeleton(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!w) return "";
  return w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/sh/g, "s")
    .replace(/ch/g, "c")
    .replace(/th/g, "t")
    .replace(/[aeiouy]+/g, "a");
}

function phoneticWordSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (
    na.length >= 3 &&
    nb.length >= 3 &&
    (na.startsWith(nb) || nb.startsWith(na))
  ) {
    return 0.82;
  }
  const pa = phoneticSkeleton(na);
  const pb = phoneticSkeleton(nb);
  if (pa === pb && pa.length >= 2) return 0.78;

  const maxLen = Math.max(na.length, nb.length);
  const minLen = Math.min(na.length, nb.length);
  if (maxLen === 0) return 0;
  let same = 0;
  for (let i = 0; i < minLen; i++) {
    if (na[i] === nb[i]) same++;
  }
  if (same / maxLen >= 0.6) return 0.55;
  return -0.25;
}

/**
 * Aligns external ground-truth lyrics lines onto the word-level timestamps of an ASR Json3 payload
 * using phonetic Needleman-Wunsch dynamic programming + anchor timestamp interpolation.
 * Returns null if the lyrics do not phonetically match the ASR stream above the safety threshold.
 */
export function alignLyricsToAsrEvents(
  rawLyrics: string,
  events: Json3Event[],
): Cue[] | null {
  const asrTokens = extractTokensFromAsrEvents(events);
  if (asrTokens.length < 10) return null;

  const lines = rawLyrics
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(
      (l) =>
        Boolean(l) &&
        !/^\[.*\]$/.test(l) &&
        !/^\d+\s*Contributors/i.test(l) &&
        !/Lyrics$/i.test(l),
    );

  if (lines.length < 4) return null;

  interface LyricWordToken {
    word: string;
    lineIdx: number;
  }

  const lyricWords: LyricWordToken[] = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const words = lines[lineIdx].split(/\s+/).filter(Boolean);
    for (const w of words) {
      lyricWords.push({ word: w, lineIdx });
    }
  }

  const M = lyricWords.length;
  const N = asrTokens.length;
  if (M < 10 || M > 4500 || N > 6000) return null;

  const stride = N + 1;
  const dp = new Float32Array((M + 1) * stride).fill(-1e9);
  const back = new Uint8Array((M + 1) * stride); // 1=match, 2=skipLyric, 3=skipAsr
  dp[0] = 0;

  for (let i = 1; i <= M; i++) {
    dp[i * stride] = dp[(i - 1) * stride] - 0.05;
    back[i * stride] = 2;
  }
  for (let j = 1; j <= N; j++) {
    dp[j] = dp[j - 1] - 0.15;
    back[j] = 3;
  }

  for (let i = 1; i <= M; i++) {
    const lw = lyricWords[i - 1].word;
    const row = i * stride;
    const prevRow = (i - 1) * stride;
    for (let j = 1; j <= N; j++) {
      const sim = phoneticWordSimilarity(lw, asrTokens[j - 1].text);
      const cMatch = dp[prevRow + (j - 1)] + sim;
      const cSkipL = dp[prevRow + j] - (j === N ? 0.05 : 0.18);
      const cSkipA = dp[row + (j - 1)] - 0.18;

      if (cMatch >= cSkipL && cMatch >= cSkipA) {
        dp[row + j] = cMatch;
        back[row + j] = 1;
      } else if (cSkipL >= cSkipA) {
        dp[row + j] = cSkipL;
        back[row + j] = 2;
      } else {
        dp[row + j] = cSkipA;
        back[row + j] = 3;
      }
    }
  }

  const anchors: Array<[number, number]> = [];
  let ci = M;
  let cj = N;
  while (ci > 0 || cj > 0) {
    const b = back[ci * stride + cj];
    if (b === 1) {
      if (phoneticWordSimilarity(lyricWords[ci - 1].word, asrTokens[cj - 1].text) >= 0.5) {
        anchors.push([ci - 1, cj - 1]);
      }
      ci--;
      cj--;
    } else if (b === 2) {
      ci--;
    } else {
      cj--;
    }
  }
  anchors.reverse();

  // Quality gate: verify that the lyrics genuinely align with the audio stream
  const minDim = Math.min(M, N);
  if (anchors.length < 12 || anchors.length / minDim < 0.28) {
    return null;
  }

  const wordStartMs = new Float64Array(M).fill(-1);
  const wordEndMs = new Float64Array(M).fill(-1);
  const wordEventEndMs = new Float64Array(M).fill(-1);

  for (const [li, aj] of anchors) {
    wordStartMs[li] = asrTokens[aj].startMs;
    wordEndMs[li] = asrTokens[aj].endMs;
    wordEventEndMs[li] = asrTokens[aj].eventEndMs;
  }

  // Interpolate timestamps for words between consecutive anchors
  for (let a = 0; a < anchors.length - 1; a++) {
    const [li1, aj1] = anchors[a];
    const [li2, aj2] = anchors[a + 1];
    if (li2 - li1 <= 1) continue;
    const t1 = asrTokens[aj1].endMs;
    const t2 = Math.max(t1 + 40, asrTokens[aj2].startMs);
    const span = t2 - t1;
    const count = li2 - li1 - 1;
    const evEnd = asrTokens[aj2].eventEndMs;
    for (let k = 1; k <= count; k++) {
      const li = li1 + k;
      const ratioStart = (k - 1) / count;
      const ratioEnd = k / count;
      wordStartMs[li] = Math.round(t1 + span * ratioStart);
      wordEndMs[li] = Math.round(t1 + span * ratioEnd);
      wordEventEndMs[li] = evEnd;
    }
  }

  // Extrapolate leading/trailing words within the first and last anchored lines
  const [firstAnchorLi, firstAnchorAj] = anchors[0];
  const firstAnchoredLine = lyricWords[firstAnchorLi].lineIdx;
  let leadCount = 0;
  for (let li = firstAnchorLi - 1; li >= 0 && lyricWords[li].lineIdx === firstAnchoredLine; li--) {
    leadCount++;
    const estStart = Math.max(
      asrTokens[0].startMs,
      asrTokens[firstAnchorAj].startMs - leadCount * 220,
    );
    wordStartMs[li] = estStart;
    wordEndMs[li] = estStart + 200;
    wordEventEndMs[li] = asrTokens[firstAnchorAj].eventEndMs;
  }

  const [lastAnchorLi, lastAnchorAj] = anchors[anchors.length - 1];
  const lastAnchoredLine = lyricWords[lastAnchorLi].lineIdx;
  let trailCount = 0;
  for (let li = lastAnchorLi + 1; li < M && lyricWords[li].lineIdx === lastAnchoredLine; li++) {
    trailCount++;
    const estStart = asrTokens[lastAnchorAj].endMs + (trailCount - 1) * 220;
    wordStartMs[li] = estStart;
    wordEndMs[li] = estStart + 220;
    wordEventEndMs[li] = asrTokens[lastAnchorAj].eventEndMs;
  }

  // Find first and last lyric lines that have reliable anchor support (>= 2 anchors, or >= 50% words anchored)
  const anchorsPerLine = new Int32Array(lines.length);
  const wordsPerLine = new Int32Array(lines.length);
  for (let k = 0; k < M; k++) {
    wordsPerLine[lyricWords[k].lineIdx]++;
  }
  for (const [li] of anchors) {
    anchorsPerLine[lyricWords[li].lineIdx]++;
  }

  let startLine = 0;
  while (
    startLine < lines.length &&
    anchorsPerLine[startLine] < Math.min(2, wordsPerLine[startLine])
  ) {
    startLine++;
  }
  let endLine = lines.length - 1;
  while (
    endLine >= startLine &&
    anchorsPerLine[endLine] < Math.min(2, wordsPerLine[endLine])
  ) {
    endLine--;
  }

  if (startLine > endLine) return null;

  const rawCues: Cue[] = [];
  const eventEndBounds: number[] = [];

  for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
    let lineStart = -1;
    let lineEnd = -1;
    let lineEvEnd = -1;
    for (let k = 0; k < M; k++) {
      if (lyricWords[k].lineIdx === lineIdx && wordStartMs[k] >= 0) {
        if (lineStart < 0) lineStart = wordStartMs[k];
        lineEnd = Math.max(lineEnd, wordEndMs[k]);
        lineEvEnd = Math.max(lineEvEnd, wordEventEndMs[k]);
      }
    }
    if (lineStart < 0) continue;

    rawCues.push({
      index: rawCues.length,
      startMs: lineStart,
      endMs: Math.max(lineStart + 400, lineEnd),
      sourceText: lines[lineIdx],
    });
    eventEndBounds.push(lineEvEnd > 0 ? lineEvEnd : lineEnd + 1200);
  }

  if (rawCues.length === 0) return null;
  return normalizeCueTimings(rawCues, eventEndBounds);
}

function buildCuesFromAsr(events: Json3Event[]): Cue[] {
  const tokens = extractTokensFromAsrEvents(events);
  if (tokens.length === 0) return [];

  if (!hasAsrAutoPunctuation(events)) {
    return segmentUnpunctuatedTokensDP(tokens);
  }

  return segmentPunctuatedTokens(tokens);
}

function buildCuesFromManual(events: Json3Event[]): Cue[] {
  const rawCues: Array<{ startMs: number; endMs: number; text: string }> = [];

  for (const ev of events) {
    if (typeof ev.tStartMs !== "number" || !Array.isArray(ev.segs)) continue;
    const joinedRaw = ev.segs.map((s) => s.utf8 || "").join("");
    const { text: rawText } = cleanSegmentText(joinedRaw);

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

  // Detect whether this manual track is a raw fixed-width transcript dump (like Chubbyemu .en,
  // where many events contain mid-event sentence stops ". [A-Z]" and cut off mid-sentence)
  // vs a human-timed clause track (like Kurzgesagt .en).
  let midSentenceEventCount = 0;
  let hangingEndEventCount = 0;
  for (const rc of rawCues) {
    const words = rc.text.split(/\s+/).filter(Boolean);
    let hasMidStop = false;
    for (let wIdx = 0; wIdx < words.length - 1; wIdx++) {
      if (
        isSentenceEnd(
          words[wIdx],
          wIdx > 0 ? words[wIdx - 1] : undefined,
          words[wIdx + 1],
          600,
        )
      ) {
        hasMidStop = true;
        break;
      }
    }
    if (hasMidStop) {
      midSentenceEventCount++;
    }
    const lastNorm = normWord(words[words.length - 1] || "");
    if (ALWAYS_HANGING_WORDS.has(lastNorm)) {
      hangingEndEventCount++;
    }
  }

  const midSentenceRatio = midSentenceEventCount / rawCues.length;
  const hangingRatio = hangingEndEventCount / rawCues.length;

  // If the manual track frequently mashes multiple sentences inside single events and wraps mid-phrase,
  // convert to syllable-weighted timed tokens and run our two-stage sentence + balanced breath-group DP.
  if (
    (midSentenceEventCount >= 2 && midSentenceRatio >= 0.15) ||
    (hangingEndEventCount >= 3 && hangingRatio >= 0.18)
  ) {
    const tokens: TimedToken[] = [];
    for (const rc of rawCues) {
      const words = rc.text.split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      const weights = words.map((w) => {
        const syl = countSyllables(w);
        const punctBonus = STRONG_PUNCT_REGEX.test(w)
          ? 2.2
          : CLAUSE_PUNCT_REGEX.test(w)
            ? 1.2
            : 0;
        return syl + punctBonus;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
      const eventSpanMs = Math.max(words.length * 120, rc.endMs - rc.startMs);
      let cursorMs = rc.startMs;

      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        const w = words[wIdx];
        const syl = countSyllables(w);
        const shareMs = Math.max(
          90,
          Math.round((eventSpanMs * weights[wIdx]) / totalWeight),
        );
        const wordEndMs =
          wIdx === words.length - 1
            ? rc.endMs
            : Math.min(rc.endMs, cursorMs + shareMs);
        tokens.push({
          text: w,
          startMs: cursorMs,
          endMs: Math.min(wordEndMs, cursorMs + Math.max(140, syl * 125)),
          eventEndMs: rc.endMs,
          syllables: syl,
        });
        cursorMs = wordEndMs;
      }
    }
    return segmentPunctuatedTokens(tokens);
  }

  // Human-timed clause track (e.g. Kurzgesagt): preserve human event timing,
  // but repair any trailing hanging function word ("– the" | "loss", "time and" | "effort")
  // across contiguous events so clauses stay syntactically clean.
  for (let i = 0; i < rawCues.length - 1; i++) {
    const curr = rawCues[i];
    const next = rawCues[i + 1];
    if (next.startMs - curr.endMs > 300) continue;

    const currWords = curr.text.split(/\s+/);
    if (currWords.length < 4) continue;
    const lastWord = currWords[currWords.length - 1];
    const lastNorm = normWord(lastWord);

    if (
      ALWAYS_HANGING_WORDS.has(lastNorm) &&
      !STRONG_PUNCT_REGEX.test(lastWord) &&
      !CLAUSE_PUNCT_REGEX.test(lastWord)
    ) {
      currWords.pop();
      curr.text = currWords.join(" ");
      next.text = `${lastWord} ${next.text}`;
      const shiftMs = Math.min(180, Math.floor((curr.endMs - curr.startMs) * 0.1));
      curr.endMs -= shiftMs;
      next.startMs -= shiftMs;
    }
  }

  const cues: Cue[] = rawCues.map((rc, idx) => ({
    index: idx,
    startMs: rc.startMs,
    endMs: rc.endMs,
    sourceText: rc.text,
  }));

  return cues;
}

/**
 * Computes a fast deterministic fingerprint of the normalized cue timeline
 * so any segmentation or timestamp change automatically invalidates stale cached translations.
 */
export function computeCuesFingerprint(cues: Cue[]): string {
  let hash = 2166136261;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    hash ^= c.startMs;
    hash = Math.imul(hash, 16777619);
    hash ^= c.endMs;
    hash = Math.imul(hash, 16777619);
    for (let k = 0; k < c.sourceText.length; k++) {
      hash ^= c.sourceText.charCodeAt(k);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `v2_c${cues.length}_${(hash >>> 0).toString(36)}`;
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
