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
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  const whole = cleaned.length <= 80 ? [cleaned] : [];
  const tokens = cleaned
    .split(" ")
    .map((v) => v.replace(/[^가-힣]/g, ""))
    .filter((v) => v.length >= 2)
    .sort((a, b) => b.length - a.length);

  return unique([...whole, ...tokens.slice(0, 3)]).slice(0, 4);
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

  return items.map((item) => {
    const sense = Array.isArray(item?.sense)
      ? item.sense[0]
      : item?.sense || {};

    return {
      word: cleanText(item?.word),
      definition: cleanText(sense?.definition),
      pos: cleanText(sense?.pos || item?.pos),
      type: cleanText(sense?.type || item?.type),
      link: sense?.link || item?.link || null
    };
  }).filter((item) => item.word);
}

function scoreCandidate(candidate, question, length) {
  const answer = normalizeAnswer(candidate.word);
  const clue = cleanText(question).replace(/★+/g, " ");
  if (!answer) return -Infinity;

  let score = 0;

  const answerSyllables = koreanLength(answer);
  if (Number.isInteger(length) && answerSyllables === length) score += 80;

  const tokens = clue
    .split(" ")
    .map((v) => v.replace(/[^가-힣]/g, ""))
    .filter((v) => v.length >= 2);

  for (const token of tokens) {
    if (candidate.definition.includes(token)) {
      score += Math.min(token.length * 5, 25);
    }
  }

  if (candidate.pos) score += 1;
  return score;
}

function requestCacheKey(question, length) {
  return [
    cleanText(question).normalize("NFC").toLowerCase(),
    Number.isInteger(length) ? length : ""
  ].join("|");
}

async function loadCachedCandidates(question, length) {
  const loaded = await chrome.storage.local.get({
    [CANDIDATE_STORAGE_KEY]: []
  });

  const records = Array.isArray(loaded[CANDIDATE_STORAGE_KEY])
    ? loaded[CANDIDATE_STORAGE_KEY]
    : [];

  const key = requestCacheKey(question, length);
  const hit = records.find(
    (record) => record?.requestKey === key
  );

  return hit?.candidates || null;
}

async function searchCandidates({ question, length }) {
  const cached = await loadCachedCandidates(question, length);
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
      const score = scoreCandidate(candidate, question, length);
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

  // Fast path: one request using the full clue.
  if (queries.length > 0) {
    const items = await apiSearch(apiKey, queries[0], length);
    mergeCandidates(items);
  }

  // Only use fallback queries when the first request did not produce enough
  // candidates. This is what keeps normal lookups close to one API request.
  for (let i = 1; i < queries.length && map.size < 3; i++) {
    try {
      const items = await apiSearch(apiKey, queries[i], length);
      mergeCandidates(items);
    } catch (error) {
      console.warn("[KKuTu 기록기] 보조 사전 검색 실패:", error.message);
    }
  }

  const candidates = [...map.values()]
    .sort((a, b) => b.score - a.score || a.word.length - b.word.length)
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
    requestKey: requestCacheKey(request.question, request.length),
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