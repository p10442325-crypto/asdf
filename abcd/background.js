const API_KEY_STORAGE_KEY = "kkutuStdDictApiKey";
const CANDIDATE_STORAGE_KEY = "kkutuCrosswordCandidates";

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAnswer(value) {
  return cleanText(value)
    .normalize("NFC")
    .replace(/\s+/g, "");
}

function koreanLength(value) {
  return [...String(value ?? "")]
    .filter((char) => /[가-힣]/.test(char))
    .length;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractQueries(question) {
  const cleaned = cleanText(question)
    .replace(/★+/g, " ")
    .replace(/[0-9０-９]+/g, " ")
    .replace(/[“”"'‘’()[\]{}<>]/g, " ")
    .replace(/[.,!?;:/·=~]/g, " ")
    .replace(/[-‐‑‒–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  const runs = cleaned
    .match(/[가-힣]+/g)
    ?.filter((v) => v.length >= 2) || [];

  const phrases = [];

  // Keep word boundaries. For example:
  // "관공서·회사·군대 등에서" -> "관공서 회사 군대 등에서"
  // instead of the broken "관공서회사군대".
  for (let size = 5; size >= 2; size--) {
    for (let i = 0; i + size <= runs.length; i++) {
      const phrase = runs.slice(i, i + size).join(" ");
      if (phrase.length >= 6) {
        phrases.push(phrase);
      }
      if (phrases.length >= 8) break;
    }
    if (phrases.length >= 8) break;
  }

  // The full normalized clue is useful because an exact dictionary
  // definition can be found in one request.
  const whole = cleaned.length <= 120 ? [cleaned] : [];

  return unique([
    ...whole,
    ...phrases.sort((a, b) => b.length - a.length)
  ]).slice(0, 8);
}

async function apiSearch(apiKey, query, length) {
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    req_type: "json",
    advanced: "y",
    target: "8",
    method: "include",
    start: "1",
    num: "100"
  });

  if (Number.isInteger(length) && length > 0) {
    params.set("letter_s", String(length));
    params.set("letter_e", String(length));
  }

  const response = await fetch(
    "https://stdict.korean.go.kr/api/search.do?" + params.toString()
  );

  if (!response.ok) {
    throw new Error("표준국어대사전 API HTTP " + response.status);
  }

  const data = await response.json();

  if (data?.error) {
    throw new Error(
      data.error.message || ("표준국어대사전 API 오류 " + data.error.error_code)
    );
  }

  const items = Array.isArray(data?.channel?.item)
    ? data.channel.item
    : data?.channel?.item
      ? [data.channel.item]
      : [];

  const results = [];

  for (const item of items) {
    const senses = Array.isArray(item?.sense)
      ? item.sense
      : item?.sense
        ? [item.sense]
        : [];

    if (senses.length === 0) {
      const word = cleanText(item?.word);
      if (word) {
        results.push({
          word,
          definition: "",
          pos: cleanText(item?.pos),
          type: cleanText(item?.type),
          link: item?.link || null
        });
      }
      continue;
    }

    for (const sense of senses) {
      const word = cleanText(item?.word);
      const definition = cleanText(sense?.definition);

      if (!word || !definition) continue;

      results.push({
        word,
        definition,
        pos: cleanText(sense?.pos || item?.pos),
        type: cleanText(sense?.type || item?.type),
        link: sense?.link || item?.link || null,
        senseOrder: sense?.sense_order ?? null
      });
    }
  }

  return results;
}

function normalizeMatchText(value) {
  return cleanText(value)
    .normalize("NFC")
    .replace(/★+/g, "★")
    .replace(/[0-9０-９]+/g, " ")
    .replace(/[^가-힣★]/g, "")
    .trim();
}

function parseKkutuMeanVariants(rawMean, fallbackQuestion = "") {
  const raw = String(rawMean ?? "");

  if (!raw || raw.indexOf("＂") === -1) {
    const fallback = normalizeMatchText(
      cleanText(fallbackQuestion).replace(/★+/g, "★")
    );
    return fallback ? [fallback] : [];
  }

  const variants = [];
  const groups = raw
    .split(/＂[0-9]+＂/)
    .slice(1);

  for (const group of groups) {
    if (group.indexOf("［") === -1) {
      const text = normalizeMatchText(group);
      if (text) variants.push(text);
      continue;
    }

    const parts = group
      .split(/［[0-9]+］/)
      .slice(1);

    for (const part of parts) {
      const senses = part.split(/（[0-9]+）/).slice(1);
      for (const sense of senses) {
        const text = normalizeMatchText(sense);
        if (text) variants.push(text);
      }
    }
  }

  return unique(variants);
}

function maskCandidateDefinition(definition, word) {
  const definitionText = normalizeMatchText(definition);
  const wordText = String(word ?? "")
    .normalize("NFC")
    .replace(/[^가-힣]/g, "");

  if (!definitionText || !wordText) {
    return definitionText;
  }

  if (!definitionText.includes(wordText)) {
    return definitionText;
  }

  return definitionText.replace(wordText, "★");
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) {
    return a === b ? 1 : 0;
  }

  const counts = new Map();

  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }

  let overlap = 0;

  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = counts.get(gram) || 0;

    if (count > 0) {
      overlap++;
      counts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (a.length + b.length - 2);
}

function clueTokens(variants) {
  const set = new Set();

  for (const variant of variants) {
    const tokens = String(variant)
      .replace(/★/g, " ")
      .match(/[가-힣]{2,}/g) || [];

    for (const token of tokens) {
      set.add(token);
    }
  }

  return [...set].sort((a, b) => b.length - a.length);
}

function scoreCandidate(candidate, question, length, rawMean) {
  const answer = normalizeAnswer(candidate.word);
  if (!answer) return -Infinity;

  const answerSyllables = koreanLength(answer);
  const variants = parseKkutuMeanVariants(rawMean, question);
  const tokens = clueTokens(variants);

  let score = 0;

  // KKuTu replaces the answer occurrence in the dictionary definition with
  // a single ★. Recreate that transformation and compare it directly to
  // the original clue. This is the strongest signal available to us.
  const maskedDefinition = maskCandidateDefinition(
    candidate.definition,
    candidate.word
  );

  let bestSimilarity = 0;

  for (const clue of variants) {
    if (!clue || !maskedDefinition) continue;

    if (maskedDefinition === clue) {
      score = Math.max(score, 2000);
      bestSimilarity = 1;
      continue;
    }

    if (maskedDefinition.includes(clue)) {
      score = Math.max(score, 1300);
    } else if (clue.includes(maskedDefinition)) {
      score = Math.max(score, 1050);
    }

    bestSimilarity = Math.max(
      bestSimilarity,
      diceSimilarity(maskedDefinition, clue)
    );
  }

  score += Math.round(bestSimilarity * 500);

  if (Number.isInteger(length) && answerSyllables === length) {
    score += 100;
  }

  for (const token of tokens.slice(0, 8)) {
    if (candidate.definition.includes(token)) {
      score += Math.min(token.length * 8, 40);
    }
  }

  if (candidate.pos) score += 2;

  return score;
}

function requestCacheKey(question, length, rawMean) {
  return [
    cleanText(question).normalize("NFC").toLowerCase(),
    String(rawMean ?? "").normalize("NFC"),
    Number.isInteger(length) ? length : ""
  ].join("|");
}

async function loadCachedCandidates(question, length, rawMean) {
  const loaded = await chrome.storage.local.get({
    [CANDIDATE_STORAGE_KEY]: []
  });

  const records = Array.isArray(loaded[CANDIDATE_STORAGE_KEY])
    ? loaded[CANDIDATE_STORAGE_KEY]
    : [];

  const key = requestCacheKey(question, length, rawMean);
  const hit = records.find(
    (record) => record?.requestKey === key
  );

  return hit?.candidates || null;
}

async function searchCandidates({ question, length, rawMean }) {
  const cached = await loadCachedCandidates(question, length, rawMean);
  if (Array.isArray(cached)) {
    return {
      ok: true,
      needsApiKey: false,
      candidates: cached.slice(0, 3),
      cached: true
    };
  }

  const stored = await chrome.storage.local.get({
    [API_KEY_STORAGE_KEY]: ""
  });
  const apiKey = cleanText(stored[API_KEY_STORAGE_KEY]);

  if (!apiKey) {
    return {
      ok: false,
      needsApiKey: true,
      candidates: []
    };
  }

  const queries = extractQueries(question);
  const map = new Map();

  function mergeCandidates(items) {
    for (const candidate of items) {
      const key = normalizeAnswer(candidate.word);
      const score = scoreCandidate(candidate, question, length, rawMean);

      if (!key || !Number.isFinite(score)) continue;

      const previous = map.get(key);
      if (!previous || score > previous.score) {
        map.set(key, {
          ...candidate,
          score
        });
      }
    }
  }

  // Two fast searches in parallel:
  // 1) the full normalized clue, where an exact definition can match;
  // 2) a meaningful multi-word phrase, where the API's include search is
  // less likely to be overwhelmed by punctuation or clue length.
  const firstQueries = queries.slice(0, 2);

  const firstResults = await Promise.all(
    firstQueries.map(async (query) => apiSearch(apiKey, query, length))
  );

  firstResults.forEach(mergeCandidates);

  function getBestScore() {
    let best = -Infinity;
    for (const candidate of map.values()) {
      if (candidate.score > best) best = candidate.score;
    }
    return best;
  }

  // Do not stop merely because three weak candidates happened to arrive.
  // Only skip further requests when the first pass already contains a
  // strong definition-level match.
  if (getBestScore() < 1000 && queries.length > 2) {
    try {
      const extraItems = await apiSearch(apiKey, queries[2], length);
      mergeCandidates(extraItems);
    } catch (error) {
      console.warn("[KKuTu 기록기] 보조 사전 검색 실패:", error.message);
    }
  }

  const candidates = [...map.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        koreanLength(a.word) - koreanLength(b.word)
    )
    .slice(0, 3);

  return {
    ok: true,
    needsApiKey: false,
    candidates,
    cached: false
  };
}

function candidateKey(record) {

  return [
    record?.sessionId || "",
    record?.roundIndex ?? "",
    record?.posKey || ""
  ].join("|");
}

async function saveCandidates(request, result) {
  const loaded = await chrome.storage.local.get({
    [CANDIDATE_STORAGE_KEY]: []
  });
  const records = Array.isArray(loaded[CANDIDATE_STORAGE_KEY])
    ? loaded[CANDIDATE_STORAGE_KEY]
    : [];

  const key = candidateKey(request);
  const item = {
    ...request,
    requestKey: requestCacheKey(request.question, request.length, request.rawMean),
    candidates: result.candidates,
    updatedAt: new Date().toISOString()
  };

  const index = records.findIndex((record) => candidateKey(record) === key);

  if (index >= 0) records[index] = item;
  else records.push(item);

  await chrome.storage.local.set({
    [CANDIDATE_STORAGE_KEY]: records
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "kkutuSearchCandidates") {
    searchCandidates(message)
      .then(async (result) => {
        if (result.ok && message.sessionId && message.posKey) {
          await saveCandidates(message, result);
        }
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          needsApiKey: false,
          candidates: [],
          error: error.message
        });
      });

    return true;
  }

  if (message?.type === "kkutuGetCandidateKeyStatus") {
    chrome.storage.local.get(
      { [API_KEY_STORAGE_KEY]: "" },
      (result) => {
        sendResponse({
          configured: Boolean(cleanText(result[API_KEY_STORAGE_KEY]))
        });
      }
    );
    return true;
  }
});