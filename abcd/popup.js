"use strict";

const STORAGE_KEY = "kkutuCrosswordRecords";
const QUESTION_STORAGE_KEY = "kkutuCrosswordQuestions";

let allRecords = [];

const recordCountElement = document.getElementById("recordCount");
const questionCountElement = document.getElementById("questionCount");
const recordListElement = document.getElementById("recordList");
const searchInputElement = document.getElementById("searchInput");

const exportJsonButton = document.getElementById("exportJsonButton");
const exportCsvButton = document.getElementById("exportCsvButton");
const refreshButton = document.getElementById("refreshButton");
const clearButton = document.getElementById("clearButton");

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

clearButton.addEventListener(
  "click",
  clearRecords
);

loadRecords();