(() => {
  "use strict";

  /**
   * KKuTu Crossword Recorder - rewritten from scratch
   *
   * 핵심 동작만 유지:
   * 1) 현재 문제(type/question)와 현재 선택된 단어(cw-bar)를 찾는다.
   * 2) 단어의 실제 칸 구성(cellKey)과 글자를 읽는다.
   * 3) "사용자 입력/변화가 발생한 뒤 → 모든 칸이 채워짐" 전이만 정답으로 확정한다.
   * 4) chrome.storage.local에 중복 없이 저장한다.
   *
   * 의도적으로 제거한 것:
   * - 보드 전체 signature 기반 라운드 판정
   * - pending 저장 단계
   * - bar id를 세션 식별자로 사용하는 로직
   * - 과도한 디버그 API
   *
   * 중요:
   * 완성 상태로 처음 발견된 단어는 저장하지 않는다.
   * 게임이 이전 정답을 잠깐 화면에 남겨 두는 경우를 안전하게 무시하기 위한 것이다.
   */

  const GLOBAL = "__KKUTU_CROSSWORD_RECORDER_V2__";
  const STORAGE_KEY = "kkutuCrosswordRecords";
  const SCAN_INTERVAL = 400;

  if (window[GLOBAL]?.cleanup) {
    window[GLOBAL].cleanup();
  }

  const state = {
    session: null,
    writeChain: Promise.resolve(),
    observer: null,
    intervalId: null,
    scanQueued: false,
    destroyed: false
  };

  const LETTER_RE = /[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z]/;

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isExtensionAlive() {
    return Boolean(
      typeof chrome !== "undefined" &&
      chrome.runtime?.id &&
      chrome.storage?.local
    );
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;

    // offsetParent가 null이어도 fixed/sticky 계열은 화면에 보일 수 있다.
    if (element.offsetParent === null && style.position !== "fixed") {
      return false;
    }

    return true;
  }

  function findVisible(selector) {
    return [...document.querySelectorAll(selector)].find(isVisible) || null;
  }

  function readQuestion() {
    const head = findVisible(".cw-q-head");
    const body = findVisible(".cw-q-body");

    if (!head || !body) return null;

    const type = cleanText(head.textContent);
    const question = cleanText(body.textContent);
    if (!type || !question) return null;

    return { type, question };
  }

  function readCellLetter(cell) {
    const text = cleanText(cell?.textContent);
    if (!text) return "";

    // 셀 번호/장식문자는 버리고 실제 글자만 합친다.
    const letters = [...text].filter((char) => LETTER_RE.test(char));
    return letters.join("");
  }

  function readWord(bar) {
    if (!bar?.isConnected) return null;

    const cells = [...bar.querySelectorAll(".cw-cell")];
    if (cells.length === 0) return null;

    const letters = cells.map(readCellLetter);
    const cellIds = cells.map((cell) => cell.id || "");

    // bar id는 게임 내부에서 재사용될 수 있으므로 식별자로 쓰지 않는다.
    const cellKey = cellIds.join(",");
    const answer = letters.join("");
    const isComplete = letters.every((letter) => letter.length > 0);

    return {
      bar,
      cellKey,
      letters,
      answer,
      length: letters.length,
      isComplete
    };
  }

  function getActiveBar() {
    return findVisible(".cw-bar.cw-my-open");
  }

  function getSnapshot() {
    const question = readQuestion();
    const bar = getActiveBar();
    const word = readWord(bar);

    if (!question || !word) return null;

    return {
      ...question,
      ...word,
      key: `${question.type}|${question.question}|${word.cellKey}`
    };
  }

  function resetSession(snapshot) {
    state.session = {
      key: snapshot.key,
      type: snapshot.type,
      question: snapshot.question,
      cellKey: snapshot.cellKey,
      bar: snapshot.bar,
      length: snapshot.length,

      // 처음 상태를 기억해 두고, 실제 변화가 생겼는지 판단한다.
      initialAnswer: snapshot.answer,
      lastAnswer: snapshot.answer,

      // true가 된 뒤 complete 상태가 되면 기록한다.
      armed: !snapshot.isComplete,
      committed: false
    };
  }

  function sessionStillPointsTo(snapshot) {
    const session = state.session;
    if (!session) return false;

    if (session.key !== snapshot.key) return false;
    if (!session.bar?.isConnected) return false;

    const current = readWord(session.bar);
    if (!current || current.cellKey !== session.cellKey) return false;

    return true;
  }

  function syncSession(snapshot) {
    if (!snapshot) return;

    if (!state.session || !sessionStillPointsTo(snapshot)) {
      resetSession(snapshot);
      return;
    }

    const session = state.session;

    // 단어가 비워졌다면 새 입력 사이클이 시작된 것으로 본다.
    if (!snapshot.isComplete) {
      session.armed = true;
      session.committed = false;
    }

    // 전체 문자열이 실제로 바뀌어도 사용자가 새 입력을 한 것으로 본다.
    if (snapshot.answer !== session.lastAnswer) {
      session.armed = true;
      session.committed = false;
    }

    session.lastAnswer = snapshot.answer;
    session.bar = snapshot.bar;
    session.length = snapshot.length;
  }

  function markUserInput() {
    const snapshot = getSnapshot();
    if (!snapshot || !state.session) return;
    if (state.session.key !== snapshot.key) return;

    state.session.armed = true;
    state.session.committed = false;
  }

  function normalizeAnswer(answer) {
    return cleanText(answer).replace(/\s+/g, "");
  }

  function hasStoredDuplicate(records, record) {
    return records.some(
      (item) =>
        item?.type === record.type &&
        item?.question === record.question &&
        item?.answer === record.answer
    );
  }

  function chromeGet(key) {
    return new Promise((resolve, reject) => {
      if (!isExtensionAlive()) {
        reject(new Error("Extension context is unavailable"));
        return;
      }

      chrome.storage.local.get({ [key]: [] }, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result[key]);
      });
    });
  }

  function chromeSet(key, value) {
    return new Promise((resolve, reject) => {
      if (!isExtensionAlive()) {
        reject(new Error("Extension context is unavailable"));
        return;
      }

      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function enqueueWrite(record) {
    state.writeChain = state.writeChain
      .then(async () => {
        const loaded = await chromeGet(STORAGE_KEY);
        const records = Array.isArray(loaded) ? loaded : [];

        if (hasStoredDuplicate(records, record)) return;

        records.push(record);
        await chromeSet(STORAGE_KEY, records);
      })
      .catch((error) => {
        console.warn("[KKuTu 기록기] 저장 실패:", error.message);
      });

    return state.writeChain;
  }

  function commit(snapshot) {
    const session = state.session;
    if (!session) return;
    if (session.committed) return;
    if (!session.armed) return;
    if (!snapshot.isComplete) return;

    const answer = normalizeAnswer(snapshot.answer);
    if (!answer) return;

    // 현재 DOM이 세션의 물리적 칸과 동일한지 마지막으로 확인한다.
    if (snapshot.cellKey !== session.cellKey) return;

    session.committed = true;
    session.armed = false;

    const record = {
      type: session.type,
      question: session.question,
      answer,
      length: session.length,
      savedAt: new Date().toISOString()
    };

    console.log("[KKuTu 기록기] 정답 저장:", record);
    enqueueWrite(record);
  }

  function scan() {
    if (state.destroyed) return;

    try {
      const snapshot = getSnapshot();
      if (!snapshot) return;

      // 문제 + 물리적 칸 구성이 바뀌었을 때만 새 세션을 만든다.
      syncSession(snapshot);

      // 세션이 방금 생성되었거나 갱신된 뒤 완성 전이를 검사한다.
      commit(snapshot);
    } catch (error) {
      console.error("[KKuTu 기록기] 검사 오류:", error);
    }
  }

  function queueScan() {
    if (state.destroyed || state.scanQueued) return;

    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scan();
    });
  }

  function onKeyDown(event) {
    if (state.destroyed) return;

    const key = String(event.key || "");
    const isLetter = /[A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/.test(key);
    const isEditingKey = key === "Backspace" || key === "Delete";

    if (!isLetter && !isEditingKey) return;

    // 첫 입력보다 먼저 세션을 잡아 두면, 아주 빠른 입력으로
    // "처음부터 완성된 단어"만 관찰되는 경우도 놓치지 않는다.
    if (!state.session) {
      scan();
    }

    markUserInput();
    queueScan();
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;

    state.observer?.disconnect();
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
    }

    document.removeEventListener("keydown", onKeyDown, true);

    if (window[GLOBAL]) {
      delete window[GLOBAL];
    }
  }

  state.observer = new MutationObserver(queueScan);
  state.observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "id"]
  });

  document.addEventListener("keydown", onKeyDown, true);
  state.intervalId = window.setInterval(scan, SCAN_INTERVAL);

  window[GLOBAL] = {
    cleanup,
    getState: () => ({
      session: state.session
        ? {
            key: state.session.key,
            question: state.session.question,
            answer: state.session.lastAnswer,
            armed: state.session.armed,
            committed: state.session.committed
          }
        : null
    })
  };

  console.log("[KKuTu 기록기] 새 기록기 시작");
  scan();
})();