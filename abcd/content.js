(() => {
  "use strict";

  /**
   * KKuTu Crossword Recorder
   *
   * KKuTu's official open-source client uses:
   * - .cw-bar / .cw-cell for the board
   * - #cw-q-input for clue input
   * - .cw-q-head / .cw-q-body for the current clue
   * - .rounds-current for the currently displayed crossword round
   *
   * Important implementation detail:
   * .cw-my-open means "this word was solved by me". It is NOT the
   * currently selected bar. Therefore the recorder tracks selection from
   * the user's actual bar click and verifies the resulting board update.
   *
   * The KKuTu client sends the answer on Enter and only paints letters into
   * .cw-cell after the server accepts the answer. We use that transition:
   *   user selects bar -> user submits answer -> same bar becomes complete
   * and only commit when the completed board word exactly matches the
   * submitted answer. This prevents another player's solve from being
   * attributed to the user after an earlier wrong attempt.
   */

  const GLOBAL = "__KKUTU_CROSSWORD_RECORDER_V3__";
  const STORAGE_KEY = "kkutuCrosswordRecords";
  const SCAN_INTERVAL = 400;
  const QUESTION_INPUT_SELECTOR = "#cw-q-input";

  if (window[GLOBAL]?.cleanup) {
    window[GLOBAL].cleanup();
  }

  const state = {
    selectedBarId: null,
    selectedRound: null,
    observedRound: null,
    pendingSubmission: null,
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

  function normalizeAnswer(answer) {
    return cleanText(answer)
      .normalize("NFC")
      .replace(/\s+/g, "");
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

    // getClientRects() works for fixed/sticky/positioned elements where
    // offsetParent can legitimately be null.
    if (typeof element.getClientRects === "function") {
      if (element.getClientRects().length === 0) return false;
    } else if (element.offsetParent === null && style.position !== "fixed") {
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

  function readCurrentRound() {
    const labels = [...document.querySelectorAll(".rounds label")];
    const current = labels.find(isVisibleAndCurrentRound);
    if (!current) return null;

    return {
      index: labels.indexOf(current),
      text: cleanText(current.textContent)
    };
  }

  function isVisibleAndCurrentRound(element) {
    return isVisible(element) && element.classList.contains("rounds-current");
  }

  function getSelectedBar() {
    if (!state.selectedBarId) return null;

    const bar = document.getElementById(state.selectedBarId);
    if (!bar || !isVisible(bar) || !bar.matches(".cw-bar")) return null;

    return bar;
  }

  function readCellLetter(cell) {
    const text = cleanText(cell?.textContent);
    if (!text) return "";

    const letters = [...text].filter((char) => LETTER_RE.test(char));
    return letters.join("");
  }

  function readWord(bar) {
    if (!bar?.isConnected) return null;

    const cells = [...bar.querySelectorAll(".cw-cell")];
    if (cells.length === 0) return null;

    const letters = cells.map(readCellLetter);
    const cellIds = cells.map((cell) => cell.id || "");
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

  function getSnapshot() {
    const question = readQuestion();
    const round = readCurrentRound();
    const bar = getSelectedBar();
    const word = readWord(bar);

    if (!question || !round || !bar || !word) return null;

    return {
      ...question,
      ...round,
      ...word,
      barId: bar.id,
      key: `${round.index}|${question.type}|${question.question}|${word.cellKey}`
    };
  }

  function selectBar(bar) {
    if (!bar?.isConnected || !bar.matches(".cw-bar")) return;

    const round = readCurrentRound();
    state.selectedBarId = bar.id || null;
    state.selectedRound = round?.index ?? null;
    state.pendingSubmission = null;
    queueScan();
  }

  function clearSelection() {
    state.selectedBarId = null;
    state.selectedRound = null;
    state.pendingSubmission = null;
  }

  function syncObservedRound(round) {
    if (!round) return;

    const marker = `${round.index}|${round.text}`;
    if (state.observedRound !== null && state.observedRound !== marker) {
      // Automatic round transitions do not generate a click event. Detect
      // those transitions here so a pending submission from the previous
      // round can never be applied to the next board.
      //
      // Keep a bar selected when it was just clicked in the new round. This
      // avoids a microtask race where selection happens before the observer
      // notices the round marker change.
      if (state.selectedRound !== round.index) {
        clearSelection();
      }
    }

    state.observedRound = marker;
  }

  function syncPending(snapshot) {
    const pending = state.pendingSubmission;
    if (!pending) return;

    if (
      pending.roundIndex !== snapshot.index ||
      pending.barId !== snapshot.barId ||
      pending.cellKey !== snapshot.cellKey ||
      pending.type !== snapshot.type ||
      pending.question !== snapshot.question
    ) {
      state.pendingSubmission = null;
    }
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
    const pending = state.pendingSubmission;
    if (!pending) return;
    if (!snapshot.isComplete) return;

    syncPending(snapshot);
    if (!state.pendingSubmission) return;

    const answer = normalizeAnswer(snapshot.answer);
    if (!answer || answer !== pending.answer) return;

    const record = {
      type: pending.type,
      question: pending.question,
      answer,
      length: pending.length,
      savedAt: new Date().toISOString()
    };

    // Clear before enqueueing so repeated MutationObserver/interval scans
    // cannot queue the same logical solve twice.
    state.pendingSubmission = null;

    console.log("[KKuTu 기록기] 정답 저장:", record);
    enqueueWrite(record);
  }

  function scan() {
    if (state.destroyed) return;

    try {
      syncObservedRound(readCurrentRound());
      const snapshot = getSnapshot();
      if (!snapshot) return;

      syncPending(snapshot);
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

  function getQuestionInput(target) {
    if (target?.matches?.(QUESTION_INPUT_SELECTOR)) return target;
    if (target?.closest) return target.closest(QUESTION_INPUT_SELECTOR);
    return null;
  }

  function onBarClick(event) {
    if (state.destroyed) return;

    const bar = event.target?.closest?.(".cw-bar");
    if (!bar) return;

    selectBar(bar);
  }

  function onRoundClick(event) {
    if (state.destroyed) return;

    const label = event.target?.closest?.(".rounds label");
    if (!label) return;

    // The client rebuilds the crossword display when a different round is
    // selected. The previous bar id can then refer to a different board.
    clearSelection();
    queueScan();
  }

  function onKeyDown(event) {
    if (state.destroyed) return;

    const input = getQuestionInput(event.target);
    if (!input) return;

    const key = String(event.key || "");
    const keyCode = Number(event.keyCode || event.which || 0);
    const isEnter = key === "Enter" || keyCode === 13;
    if (!isEnter) return;

    const bar = getSelectedBar();
    const question = readQuestion();
    const round = readCurrentRound();

    if (!bar || !question || !round) return;

    const word = readWord(bar);
    if (!word || word.isComplete) return;

    const answer = normalizeAnswer(input.value);
    if (!answer) return;

    state.pendingSubmission = {
      roundIndex: round.index,
      barId: bar.id,
      cellKey: word.cellKey,
      type: question.type,
      question: question.question,
      answer,
      length: word.length,
      submittedAt: Date.now()
    };

    queueScan();
  }

  function onInput(event) {
    if (state.destroyed) return;
    if (!getQuestionInput(event.target)) return;

    // input/composition events are useful for scheduling a later scan, but
    // submission itself is still keyed to Enter to match the KKuTu client.
    queueScan();
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;

    state.observer?.disconnect();
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
    }

    document.removeEventListener("click", onBarClick, true);
    document.removeEventListener("click", onRoundClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onInput, true);

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

  document.addEventListener("click", onBarClick, true);
  document.addEventListener("click", onRoundClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  state.intervalId = window.setInterval(scan, SCAN_INTERVAL);

  window[GLOBAL] = {
    cleanup,
    getState: () => ({
      selectedBarId: state.selectedBarId,
      selectedRound: state.selectedRound,
      observedRound: state.observedRound,
      pendingSubmission: state.pendingSubmission
        ? {
            type: state.pendingSubmission.type,
            question: state.pendingSubmission.question,
            answer: state.pendingSubmission.answer,
            barId: state.pendingSubmission.barId,
            cellKey: state.pendingSubmission.cellKey
          }
        : null
    })
  };

  console.log("[KKuTu 기록기] 수정 기록기 시작");
  scan();
})();