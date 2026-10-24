import { describe, expect, test } from "bun:test";
import {
  alignLyricsToAsrEvents,
  computeCuesFingerprint,
  findActiveCueIndex,
  findCurrentOrNextCueIndex,
  parseJson3ToCues,
  type Json3Payload,
} from "../src/subtitle/cue-builder";
import {
  buildSystemPrompt,
  buildUserPrompt,
  extractContentFromResponseText,
  normalizeBaseUrl,
  parseTranslatedLines,
} from "../src/subtitle/llm-client";
import {
  extractGeniusLyricsFromHtml,
  shouldAttemptLyricsLookup,
} from "../src/subtitle/lyrics";

describe("ASR json3 cue builder (fansub timeline normalization)", () => {
  test("merges rolling ASR word-offset events into complete natural sentences", () => {
    const sampleAsrPayload: Json3Payload = {
      events: [
        { tStartMs: 0, dDurationMs: 592160 },
        {
          tStartMs: 360,
          dDurationMs: 4480,
          wWinId: 1,
          segs: [
            { utf8: "Hello" },
            { utf8: " everyone", tOffsetMs: 400 },
            { utf8: " and", tOffsetMs: 1040 },
            { utf8: " welcome", tOffsetMs: 1480 },
            { utf8: " back", tOffsetMs: 1760 },
            { utf8: " to", tOffsetMs: 2040 },
            { utf8: " a", tOffsetMs: 2400 },
          ],
        },
        {
          tStartMs: 3030,
          dDurationMs: 1810,
          wWinId: 1,
          aAppend: 1,
          segs: [{ utf8: "\n" }],
        },
        {
          tStartMs: 3040,
          dDurationMs: 5400,
          wWinId: 1,
          segs: [
            { utf8: "coffee" },
            { utf8: " with", tOffsetMs: 400 },
            { utf8: " Chloe.", tOffsetMs: 560 },
            { utf8: " Today", tOffsetMs: 1120 },
            { utf8: " we're", tOffsetMs: 1480 },
            { utf8: " going", tOffsetMs: 1600 },
            { utf8: " to", tOffsetMs: 1720 },
            { utf8: " explore", tOffsetMs: 2000 },
            { utf8: " Celtic", tOffsetMs: 2400 },
            { utf8: " languages.", tOffsetMs: 2800 },
          ],
        },
      ],
    };

    const cues = parseJson3ToCues(sampleAsrPayload, "asr");
    expect(cues.length).toBe(2);
    expect(cues[0].sourceText).toBe("Hello everyone and welcome back to a coffee with Chloe.");
    expect(cues[0].startMs).toBe(360);
    expect(cues[0].endMs).toBeLessThanOrEqual(cues[1].startMs);
    expect(cues[1].sourceText).toBe("Today we're going to explore Celtic languages.");
  });

  test("binary search finds active and next cue accurately", () => {
    const cues = [
      { index: 0, startMs: 500, endMs: 2500, sourceText: "First sentence." },
      { index: 1, startMs: 2800, endMs: 5000, sourceText: "Second sentence." },
      { index: 2, startMs: 5200, endMs: 8000, sourceText: "Third sentence." },
    ];

    expect(findActiveCueIndex(cues, 200)).toBe(-1);
    expect(findActiveCueIndex(cues, 1500)).toBe(0);
    expect(findActiveCueIndex(cues, 2650)).toBe(-1);
    expect(findActiveCueIndex(cues, 3000)).toBe(1);

    expect(findCurrentOrNextCueIndex(cues, 0)).toBe(0);
    expect(findCurrentOrNextCueIndex(cues, 2650)).toBe(1);
    expect(findCurrentOrNextCueIndex(cues, 5500)).toBe(2);
  });

  test("segments unpunctuated fast rap ASR by syllable-compensated cadence and syntax", () => {
    const unpunctuatedRap: Json3Payload = {
      events: [
        {
          tStartMs: 9840,
          dDurationMs: 4200,
          wWinId: 1,
          segs: [
            { utf8: "Mr" },
            { utf8: " Motor", tOffsetMs: 320 },
            { utf8: " City", tOffsetMs: 600 },
            { utf8: " meets", tOffsetMs: 880 },
            { utf8: " a", tOffsetMs: 1040 },
            { utf8: " medicine", tOffsetMs: 1240 },
            { utf8: " red", tOffsetMs: 1760 },
            { utf8: " my", tOffsetMs: 2160 },
            { utf8: " lines", tOffsetMs: 2320 },
            { utf8: " are", tOffsetMs: 2600 },
            { utf8: " a", tOffsetMs: 2760 },
            { utf8: " production", tOffsetMs: 3000 },
            { utf8: " your", tOffsetMs: 3560 },
            { utf8: " lines", tOffsetMs: 3720 },
            { utf8: " are", tOffsetMs: 3960 },
            { utf8: " bre", tOffsetMs: 4200 },
          ],
        },
      ],
    };

    const cues = parseJson3ToCues(unpunctuatedRap, "asr");
    expect(cues.map((c) => c.sourceText)).toEqual([
      "Mr Motor City meets a medicine red",
      "my lines are a production",
      "your lines are bre",
    ]);
  });

  test("splits long compound punctuated sentences into balanced breath-group cues without 1-word orphan tails", () => {
    const fernExcerpt: Json3Payload = {
      events: [
        {
          tStartMs: 248560,
          dDurationMs: 6900,
          wWinId: 1,
          segs: [
            { utf8: "So" },
            { utf8: " instead,", tOffsetMs: 240 },
            { utf8: " Qing", tOffsetMs: 800 },
            { utf8: " rulers", tOffsetMs: 1120 },
            { utf8: " tried", tOffsetMs: 1520 },
            { utf8: " to", tOffsetMs: 1760 },
            { utf8: " get", tOffsetMs: 1920 },
            { utf8: " a", tOffsetMs: 2080 },
            { utf8: " monopoly", tOffsetMs: 2240 },
            { utf8: " on", tOffsetMs: 2720 },
            { utf8: " tobacco", tOffsetMs: 2960 },
            { utf8: " so", tOffsetMs: 3600 },
            { utf8: " that", tOffsetMs: 3800 },
            { utf8: " only", tOffsetMs: 4040 },
            { utf8: " they", tOffsetMs: 4320 },
            { utf8: " could", tOffsetMs: 4560 },
            { utf8: " use", tOffsetMs: 4760 },
            { utf8: " it", tOffsetMs: 4960 },
            { utf8: " for", tOffsetMs: 5160 },
            { utf8: " diplomatic", tOffsetMs: 5400 },
            { utf8: " purposes.", tOffsetMs: 5920 },
          ],
        },
        {
          tStartMs: 256000,
          dDurationMs: 2000,
          wWinId: 1,
          segs: [
            { utf8: ">> [music]", isSpeakerChange: 1 },
          ],
        },
        {
          tStartMs: 270000,
          dDurationMs: 3500,
          wWinId: 1,
          segs: [
            { utf8: ">> This", isSpeakerChange: 1 },
            { utf8: " changed", tOffsetMs: 300 },
            { utf8: " everything.", tOffsetMs: 700 },
          ],
        },
      ],
    };

    const cues = parseJson3ToCues(fernExcerpt, "asr");
    expect(cues.map((c) => c.sourceText)).toEqual([
      "So instead, Qing rulers tried to get a monopoly on tobacco",
      "so that only they could use it for diplomatic purposes.",
      "This changed everything.",
    ]);
    // Every cue must have comfortable reading duration (>= 1200ms) and no "[music]" or ">>" leak
    for (const c of cues) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(1200);
      expect(c.sourceText).not.toContain("[music]");
      expect(c.sourceText).not.toContain(">>");
    }
    expect(computeCuesFingerprint(cues)).toStartWith("v2_c3_");
  });

  test("re-segments transcript-wrapped manual tracks (Chubbyemu style) and repairs hanging words (Kurzgesagt style)", () => {
    const chubbyManual: Json3Payload = {
      events: [
        {
          tStartMs: 6640,
          dDurationMs: 4320,
          segs: [
            {
              utf8: "One week earlier, she was having a headache. It \nwas right around her eyes and nose. And it would  ",
            },
          ],
        },
        {
          tStartMs: 10960,
          dDurationMs: 4720,
          segs: [
            {
              utf8: "radiate to her forehead. This continuous, \nbilateral pain would somewhat alleviate  ",
            },
          ],
        },
        {
          tStartMs: 15680,
          dDurationMs: 5040,
          segs: [
            {
              utf8: "with ibuprofen. It never really went away, and, once the medicine wore off, the pain returned.",
            },
          ],
        },
      ],
    };

    const cues = parseJson3ToCues(chubbyManual, "");
    expect(cues[0].sourceText).toBe("One week earlier, she was having a headache.");
    expect(cues[1].sourceText).toBe("It was right around her eyes and nose.");
    expect(cues[2].sourceText).toBe("And it would radiate to her forehead.");
    expect(cues[3].sourceText).toBe(
      "This continuous, bilateral pain would somewhat alleviate with ibuprofen.",
    );

    const sysPrompt = buildSystemPrompt("简体中文");
    expect(sysPrompt).toContain("气口对齐与跨句重组");

    // Kurzgesagt-style clause-timed manual track: repairs trailing hanging words ("– the" | "loss")
    const kzManual: Json3Payload = {
      events: [
        {
          tStartMs: 1120,
          dDurationMs: 3920,
          segs: [{ utf8: "Hey wake up, AI is rotting your brain!" }],
        },
        {
          tStartMs: 5040,
          dDurationMs: 4720,
          segs: [
            {
              utf8: "That's not an empty hook, but a real thing called cognitive atrophy – the",
            },
          ],
        },
        {
          tStartMs: 9760,
          dDurationMs: 5760,
          segs: [
            {
              utf8: "loss of core skills like problem solving, critical thinking and even creativity.",
            },
          ],
        },
      ],
    };

    const kzCues = parseJson3ToCues(kzManual, "");
    expect(kzCues.map((c) => c.sourceText)).toEqual([
      "Hey wake up, AI is rotting your brain!",
      "That's not an empty hook, but a real thing called cognitive atrophy –",
      "the loss of core skills like problem solving, critical thinking and even creativity.",
    ]);
    expect(kzCues[1].endMs).toBeLessThanOrEqual(kzCues[2].startMs);

    // Fingerprint must distinguish equal-length text changes
    const fp1 = computeCuesFingerprint([
      { index: 0, startMs: 0, endMs: 1000, sourceText: "cat" },
    ]);
    const fp2 = computeCuesFingerprint([
      { index: 0, startMs: 0, endMs: 1000, sourceText: "dog" },
    ]);
    expect(fp1).not.toBe(fp2);
  });

  test("3-tier waterfall: aligns external lyrics onto corrupted ASR timestamps (ERB case)", () => {
    const sampleGeniusHtml = `
      <div data-lyrics-container="true">
        [Intro]<br/>EPIC RAP BATTLES!<br/>
        [Verse 1]<br/>
        Mr. Motor City meets the menace in red<br/>
        My lines are a production, your lines are bread!<br/>
        Disassembling timepieces is how I got my start<br/>
        Now watch me tear your ideology apart!<br/>
        You scream unite the workers! Free the class slaves!<br/>
        Lose your chains, trade &#x27;em in for mass graves!<br/>
        Mao and Stalin, wow! Appalling mounds of body bags<br/>
        When a world leader likes you, that&#x27;s a red flag!
      </div>
    `;
    const extracted = extractGeniusLyricsFromHtml(sampleGeniusHtml);
    expect(extracted).toContain("Mao and Stalin, wow! Appalling mounds of body bags");
    expect(extracted).not.toContain("[Verse 1]");

    const corruptedErbAsr: Json3Payload = {
      events: [
        {
          tStartMs: 8840,
          dDurationMs: 5200,
          wWinId: 1,
          segs: [
            { utf8: "of" },
            { utf8: " Mr", tOffsetMs: 1000 },
            { utf8: " Motor", tOffsetMs: 1320 },
            { utf8: " City", tOffsetMs: 1600 },
            { utf8: " meets", tOffsetMs: 1879 },
            { utf8: " a", tOffsetMs: 2040 },
            { utf8: " medicine", tOffsetMs: 2240 },
            { utf8: " red", tOffsetMs: 2759 },
            { utf8: " my", tOffsetMs: 3160 },
          ],
        },
        {
          tStartMs: 12160,
          dDurationMs: 4560,
          wWinId: 1,
          segs: [
            { utf8: "lines" },
            { utf8: " are", tOffsetMs: 280 },
            { utf8: " a", tOffsetMs: 439 },
            { utf8: " production", tOffsetMs: 680 },
            { utf8: " your", tOffsetMs: 1240 },
            { utf8: " lines", tOffsetMs: 1399 },
            { utf8: " are", tOffsetMs: 1639 },
          ],
        },
        {
          tStartMs: 14040,
          dDurationMs: 4920,
          wWinId: 1,
          segs: [
            { utf8: "bre" },
            { utf8: " this", tOffsetMs: 440 },
            { utf8: " is", tOffsetMs: 559 },
            { utf8: " time", tOffsetMs: 1120 },
            { utf8: " pieces", tOffsetMs: 1400 },
            { utf8: " as", tOffsetMs: 1839 },
            { utf8: " how", tOffsetMs: 1999 },
            { utf8: " I", tOffsetMs: 2120 },
            { utf8: " got", tOffsetMs: 2280 },
            { utf8: " my", tOffsetMs: 2480 },
          ],
        },
        {
          tStartMs: 16720,
          dDurationMs: 4319,
          wWinId: 1,
          segs: [
            { utf8: "start" },
            { utf8: " now", tOffsetMs: 360 },
            { utf8: " watch", tOffsetMs: 639 },
            { utf8: " me", tOffsetMs: 920 },
            { utf8: " tear", tOffsetMs: 1120 },
            { utf8: " your", tOffsetMs: 1319 },
            { utf8: " ideology", tOffsetMs: 1559 },
          ],
        },
        {
          tStartMs: 18960,
          dDurationMs: 4280,
          wWinId: 1,
          segs: [
            { utf8: "apart" },
            { utf8: " you", tOffsetMs: 399 },
            { utf8: " scream", tOffsetMs: 560 },
            { utf8: " unite", tOffsetMs: 920 },
            { utf8: " the", tOffsetMs: 1239 },
            { utf8: " workers", tOffsetMs: 1360 },
            { utf8: " free", tOffsetMs: 1800 },
            { utf8: " the", tOffsetMs: 2160 },
            { utf8: " class", tOffsetMs: 2280 },
            { utf8: " play", tOffsetMs: 2480 },
          ],
        },
        {
          tStartMs: 22360,
          dDurationMs: 4360,
          wWinId: 1,
          segs: [
            { utf8: "lose" },
            { utf8: " your", tOffsetMs: 320 },
            { utf8: " chain", tOffsetMs: 480 },
            { utf8: " trade", tOffsetMs: 1000 },
            { utf8: " them", tOffsetMs: 1320 },
            { utf8: " in", tOffsetMs: 1400 },
            { utf8: " for", tOffsetMs: 1560 },
            { utf8: " Mass", tOffsetMs: 1800 },
            { utf8: " wow", tOffsetMs: 2800 },
            { utf8: " a", tOffsetMs: 3440 },
            { utf8: " fallen", tOffsetMs: 3600 },
            { utf8: " M", tOffsetMs: 4000 },
            { utf8: " body", tOffsetMs: 4120 },
            { utf8: " B", tOffsetMs: 4200 },
          ],
        },
        {
          tStartMs: 26720,
          dDurationMs: 3500,
          wWinId: 1,
          segs: [
            { utf8: "when" },
            { utf8: " a", tOffsetMs: 200 },
            { utf8: " world", tOffsetMs: 320 },
            { utf8: " leader", tOffsetMs: 680 },
            { utf8: " likes", tOffsetMs: 1000 },
            { utf8: " you", tOffsetMs: 1360 },
            { utf8: " that's", tOffsetMs: 1640 },
            { utf8: " R", tOffsetMs: 2000 },
            { utf8: " flag", tOffsetMs: 2120 },
          ],
        },
      ],
    };

    expect(
      shouldAttemptLyricsLookup(
        { baseUrl: "", name: "English (auto)", vssId: "a.en", languageCode: "en", kind: "asr" },
        { videoId: "QjqjoehA7kM", title: "Henry Ford vs Karl Marx", author: "ERB", description: "" },
        corruptedErbAsr,
      ),
    ).toBe(true);

    const aligned = alignLyricsToAsrEvents(extracted, corruptedErbAsr.events!);
    expect(aligned).not.toBeNull();
    expect(aligned!.map((c) => c.sourceText)).toEqual([
      "Mr. Motor City meets the menace in red",
      "My lines are a production, your lines are bread!",
      "Disassembling timepieces is how I got my start",
      "Now watch me tear your ideology apart!",
      "You scream unite the workers! Free the class slaves!",
      "Lose your chains, trade 'em in for mass graves!",
      "Mao and Stalin, wow! Appalling mounds of body bags",
      "When a world leader likes you, that's a red flag!",
    ]);
    for (let i = 0; i < aligned!.length - 1; i++) {
      expect(aligned![i].endMs).toBeLessThanOrEqual(aligned![i + 1].startMs);
    }
  });
});

describe("OpenAI-compatible LLM prompt & response parsing", () => {
  test("normalizes Base URL variations", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1",
    );
  });

  test("includes video metadata and preceding context in user prompt", () => {
    const prompt = buildUserPrompt(
      [
        { index: 10, startMs: 1000, endMs: 2000, sourceText: "Let's begin." },
        { index: 11, startMs: 2100, endMs: 3500, sourceText: "First topic is Breton." },
      ],
      [
        {
          index: 9,
          startMs: 0,
          endMs: 900,
          sourceText: "Welcome back.",
          targetText: "欢迎回来。",
        },
      ],
      {
        videoId: "abc",
        title: "Kick off with Celtic Languages",
        author: "Chloe Arlyne",
        description: "An introduction to Insular Celtic languages.",
        keywords: ["Celtic", "Linguistics"],
      },
    );

    expect(prompt).toContain("Kick off with Celtic Languages");
    expect(prompt).toContain("Chloe Arlyne");
    expect(prompt).toContain("[9] Welcome back. => 欢迎回来。");
    expect(prompt).toContain("[10] Let's begin.");
    expect(prompt).toContain("[11] First topic is Breton.");
  });

  test("extracts SSE streamed lines and parses [index] slots", () => {
    const sseRaw = [
      'data: {"choices":[{"delta":{"content":"[0] 大家好，欢迎回到"}}]}',
      'data: {"choices":[{"delta":{"content":" Chloe 的咖啡时间。\\n[1] 今天我们将探索凯尔特语族。\\n"}}]}',
      "data: [DONE]",
    ].join("\n");

    const { fullContent, isSse } = extractContentFromResponseText(sseRaw);
    expect(isSse).toBe(true);
    const map = parseTranslatedLines(fullContent, new Set([0, 1]));
    expect(map.get(0)).toBe("大家好，欢迎回到 Chloe 的咖啡时间。");
    expect(map.get(1)).toBe("今天我们将探索凯尔特语族。");
  });
});
