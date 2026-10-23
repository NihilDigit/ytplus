import { describe, expect, test } from "bun:test";
import {
  findActiveCueIndex,
  findCurrentOrNextCueIndex,
  parseJson3ToCues,
  type Json3Payload,
} from "../src/subtitle/cue-builder";
import {
  buildUserPrompt,
  extractContentFromResponseText,
  normalizeBaseUrl,
  parseTranslatedLines,
} from "../src/subtitle/llm-client";

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
