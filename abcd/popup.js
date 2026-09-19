"use strict";

const STORAGE_KEY = "kkutuCrosswordRecords";
const QUESTION_STORAGE_KEY = "kkutuCrosswordQuestions";
const API_KEY_STORAGE_KEY = "kkutuStdDictApiKey";

let allRecords = [];

const recordCountElement = document.getElementById("recordCount");
const questionCountElement = document.getElementById("questionCount");
const recordListElement = document.getElementById("recordList");
const searchInputElement = document.getElementById("searchInput");

const exportJsonButton = document.getElementById("exportJsonButton");
const exportCsvButton = document.getElementById("exportCsvButton");
const refreshButton = document.getElementById("refreshButton");
const clearButton = document.getElementById("clearButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiStatus = document.getElementById("apiStatus");

/*
 * 저장 데이터 읽기
 */
function loadRecords() {
  chrome.storage.local.get(
    {
      [STORAGE_KEY]: []
    },
    (result) => {
      allRecords = Array.isArray(result[STORAGE_KEY])
        ? result[STORAGE_KEY]
        : [];

      renderRecords();
    }
  );
}

function loadApiKey() {
  chrome.storage.local.get(
    { [API_KEY_STORAGE_KEY]: "" },
    (result) => {
      apiKeyInput.value = result[API_KEY_STORAGE_KEY] || "";
      apiStatus.textContent = apiKeyInput.value
        ? "API 키가 설정되어 있습니다."
        : "API 키를 입력하면 문제별 정답 후보를 검색합니다.";
    }
  );
}

function saveApiKey() {
  const key = apiKeyInput.value.trim();

  chrome.storage.local.set(
    { [API_KEY_STORAGE_KEY]: key },
    () => {
      apiStatus.textContent = key
        ? "API 키를 저장했습니다."
        : "API 키가 비어 있습니다.";
    }
  );
}

function clearApiKey() {
  chrome.storage.local.set(
    { [API_KEY_STORAGE_KEY]: "" },
    () => {
      apiKeyInput.value = "";
      apiStatus.textContent = "API 키를 삭제했습니다.";
    }
  );
}

/*
 * HTML 삽입용 이스케이프
 */
function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*
 * 검색어에 맞는 기록만 반환
 */
function getFilteredRecords() {
  const keyword = searchInputElement.value
    .trim()
    .toLowerCase();

  if (!keyword) {
    return allRecords;
  }

  return allRecords.filter((record) => {
    const text = [
      record.type,
      record.question,
      record.answer
    ]
      .join(" ")
      .toLowerCase();

    return text.includes(keyword);
  });
}

/*
 * 목록 렌더링
 */
function renderRecords() {
  const records = getFilteredRecords();

  recordCountElement.textContent = allRecords.length;

  if (records.length === 0) {
    recordListElement.innerHTML = `
      <div class="empty">
        저장된 문제가 없습니다.
      </div>
    `;
    return;
  }

  /*
   * 최신 기록이 위로 오도록 표시
   */
  const sortedRecords = [...records].reverse();

  recordListElement.innerHTML = sortedRecords
    .map((record) => {
      return `
        <div class="record">
          <div class="record-type">
            ${escapeHtml(record.type || "")}
          </div>

          <div class="record-question">
            ${escapeHtml(record.question || "")}
          </div>

          <div class="record-answer">
            정답: ${escapeHtml(record.answer || "")}
          </div>
        </div>
      `;
    })
    .join("");
}

/*
 * 파일 다운로드
 */
function downloadFile(filename, content, mimeType) {
  const blob = new Blob(
    [content],
    {
      type: mimeType
    }
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

/*
 * JSON 내보내기
 */
function exportJson() {
  const content = JSON.stringify(
    allRecords,
    null,
    2
  );

  downloadFile(
    "kkutu-crossword-records.json",
    content,
    "application/json;charset=utf-8"
  );
}

/*
 * CSV 셀 처리
 */
function csvEscape(value) {
  const text = String(value || "")
    .replaceAll('"', '""');

  return `"${text}"`;
}

/*
 * CSV 내보내기
 */
function exportCsv() {
  const header = [
    "유형",
    "문제",
    "정답",
    "단어ID",
    "글자수",
    "저장시간"
  ];

  const rows = allRecords.map((record) => {
    return [
      record.type,
      record.question,
      record.answer,
      record.barId,
      record.length,
      record.savedAt
    ];
  });

  const csv = [
    header,
    ...rows
  ]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");

  /*
   * 한글이 Excel에서 깨지는 것을 줄이기 위한 BOM
   */
  const content = "\uFEFF" + csv;

  downloadFile(
    "kkutu-crossword-records.csv",
    content,
    "text/csv;charset=utf-8"
  );
}

/*
 * 전체 삭제
 */
function clearRecords() {
  const confirmed = confirm(
    "저장된 문제를 모두 삭제할까요?"
  );

  if (!confirmed) {
    return;
  }

  chrome.storage.local.set(
    {
      [STORAGE_KEY]: []
    },
    () => {
      allRecords = [];
      renderRecords();
    }
  );
}

searchInputElement.addEventListener(
  "input",
  renderRecords
);

exportJsonButton.addEventListener(
  "click",
  exportJson
);

exportCsvButton.addEventListener(
  "click",
  exportCsv
);

refreshButton.addEventListener(
  "click",
  loadRecords
);

saveApiKeyButton.addEventListener(
  "click",
  saveApiKey
);

clearApiKeyButton.addEventListener(
  "click",
  clearApiKey
);

clearButton.addEventListener(
  "click",
  clearRecords
);

loadApiKey();
loadRecords();
