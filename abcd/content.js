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
  const QUESTION_STORAGE_KEY = "kkutuCrosswordQuestions";
  const BRIDGE_MEANS_EVENT = "__KKUTU_CW_MEANS__";
  const BRIDGE_TURN_END_EVENT = "__KKUTU_CW_TURN_END__";
  const BRIDGE_SCRIPT = "page-bridge.js";

  if (window[GLOBAL]?.cleanup) {
    window[GLOBAL].cleanup();
  }

  const state = {
    selectedBarId: null,
    selectedRound: null,
    observedRound: null,
    pendingSubmission: null,
    questionMap: new Map(),
    candidateMap: new Map(),
    candidatePanel: null,
    candidateTimer: null,
    sessionId: makeSessionId(),
    meansSignature: null,
    apiKeyNoticeShown: false,
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

  // KKuTu's crossword clue text contains internal dictionary sense markers
  // such as ＂1＂, ［1］ and （1）. The official client turns those markers
  // into visible numbering in processWord(), so reading textContent directly
  // can produce strings like "11주해..." where the first "1" is a display
  // marker. Parse the original KKuTu format instead of stripping arbitrary
  // digits from the definition.
  function normalizeCrosswordMean(value) {
    const raw = String(value ?? "");
    if (!raw) return "";

    if (raw.indexOf("＂") === -1) {
      return cleanText(raw);
    }

    const means = raw
      .split(/＂[0-9]+＂/)
      .slice(1)
      .map((m1) => {
        if (m1.indexOf("［") === -1) {
          return [[m1]];
        }

        return m1
          .split(/［[0-9]+］/)
          .slice(1)
          .map((m2) => m2.split(/（[0-9]+）/).slice(1));
      });

    const pieces = [];

    for (const m1 of means) {
      for (const m2 of m1) {
        for (const m3 of m2) {
          const text = cleanText(m3);
          if (text) pieces.push(text);
        }
      }
    }

    return pieces.join(" ");
  }

  function cleanSearchText(value) {
    return normalizeCrosswordMean(value)
      .replace(/[0-9０-９]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function makeSessionId() {
    return `cw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function showCandidatePanel(entry, candidates, needsApiKey = false, errorMessage = "") {
    if (state.destroyed || !entry) return;

    let panel = state.candidatePanel;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "__kkutuRecorderCandidates";
      Object.assign(panel.style, {
        position: "fixed",
        left: "18px",
        bottom: "18px",
        zIndex: "2147483647",
        width: "320px",
        maxWidth: "calc(100vw - 36px)",
        padding: "12px",
        border: "1px solid rgba(0,0,0,.12)",
        borderRadius: "10px",
        background: "rgba(20,20,20,.94)",
        color: "#fff",
        fontSize: "12px",
        lineHeight: "1.45",
        boxShadow: "0 6px 18px rgba(0,0,0,.28)",
        pointerEvents: "auto"
      });
      (document.body || document.documentElement).appendChild(panel);
      state.candidatePanel = panel;
    }

    const rows = Array.isArray(candidates)
      ? candidates.slice(0, 8)
      : [];

    const candidateHtml = rows.length
      ? rows.map((candidate, index) => `
          <div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.09);">
            <strong style="font-size:14px;">${index + 1}. ${escapeForHtml(candidate.word)}</strong>
            <div style="opacity:.75;margin-top:2px;">${escapeForHtml(candidate.definition || "")}</div>
          </div>
        `).join("")
      : errorMessage
        ? `<div style="margin-top:6px;color:#ff9f9f;">검색 오류: ${escapeForHtml(errorMessage)}</div>`
        : needsApiKey
          ? "<div style=\"margin-top:6px;opacity:.8;\">표준국어대사전 API 키를 팝업에서 설정하세요.</div>"
          : "<div style=\"margin-top:6px;opacity:.8;\">검색 결과가 없습니다.</div>";

    panel.innerHTML = `
      <div style="font-weight:700;font-size:13px;">사전 정답 후보</div>
      <div style="margin-top:4px;opacity:.75;">${escapeForHtml(entry.question)}</div>
      ${candidateHtml}
    `;
  }

  function hideCandidatePanel() {
    if (state.candidatePanel) {
      state.candidatePanel.remove();
      state.candidatePanel = null;
    }
  }

  function escapeForHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function requestCandidates(entry) {
    if (!entry || !isExtensionAlive()) return;

    clearTimeout(state.candidateTimer);
    showCandidatePanel(entry, [], false);

    state.candidateTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "kkutuSearchCandidates",
        sessionId: entry.sessionId,
        roundIndex: entry.roundIndex,
        posKey: entry.posKey,
        question: entry.question,
        length: entry.length
      }, (result) => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message || "확장 프로그램 메시지 오류";
          console.warn("[KKuTu 기록기] 사전 검색 실패:", message);
          showCandidatePanel(entry, [], false, message);
          return;
        }

        if (!result?.ok && result?.needsApiKey) {
          showCandidatePanel(entry, [], true);
          return;
        }

        if (!result?.ok) {
          const message = result?.error || "알 수 없는 오류";
          console.warn("[KKuTu 기록기] 사전 검색 실패:", message);
          showCandidatePanel(entry, [], false, message);
          return;
        }

        state.candidateMap.set(
          `${entry.roundIndex0}|${entry.posKey}`,
          result.candidates || []
        );

        showCandidatePanel(entry, result.candidates || []);
      });
    }, 80);
  }

  function showSaveNotice(message) {
    if (state.destroyed) return;

    let toast = document.getElementById("__kkutuRecorderToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__kkutuRecorderToast";
      Object.assign(toast.style, {
        position: "fixed",
        top: "28px",
        left: "50%",
        transform: "translate(-50%, -14px) scale(.96)",
        zIndex: "2147483647",
        minWidth: "300px",
        maxWidth: "min(720px, calc(100vw - 32px))",
        padding: "18px 24px",
        border: "2px solid rgba(255,255,255,.18)",
        borderRadius: "14px",
        background: "rgba(16,16,20,.96)",
        color: "#fff",
        fontSize: "18px",
        fontWeight: "700",
        lineHeight: "1.5",
        textAlign: "center",
        boxShadow: "0 10px 30px rgba(0,0,0,.38)",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity .18s ease, transform .18s ease",
        whiteSpace: "pre-line",
        backdropFilter: "blur(8px)"
      });
      (document.body || document.documentElement).appendChild(toast);
    }

    toast.textContent = message;
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%, 0) scale(1)";

    clearTimeout(toast.__kkutuTimer);
    toast.__kkutuTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -14px) scale(.96)";
    }, 2400);
  }

  function textFromHtml(value) {
    const holder = document.createElement("div");
    holder.innerHTML = String(value ?? "");
    return cleanText(holder.textContent || holder.innerHTML || "");
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

    clearTimeout(state.candidateTimer);
    state.candidateTimer = setTimeout(() => {
      const currentRound = readCurrentRound();
      const snapshot = getSnapshot();

      if (!currentRound || currentRound.index !== state.selectedRound || !snapshot) {
        hideCandidatePanel();
        return;
      }

      const posKey = snapshot.barId.slice(3).replace(/-/g, ",");
      const storedEntry = state.questionMap.get(
        `${currentRound.index}|${posKey}`
      );

      const entry = storedEntry || {
        sessionId: state.sessionId || makeSessionId(),
        roundIndex: currentRound.index + 1,
        roundIndex0: currentRound.index,
        posKey,
        x: Number(snapshot.barId.split("-")[1]),
        y: Number(snapshot.barId.split("-")[2]),
        dir: Number(snapshot.barId.split("-")[3]),
        type: snapshot.type,
        theme: null,
        question: cleanSearchText(snapshot.question),
        length: snapshot.length,
        collectedAt: new Date().toISOString()
      };

      if (entry.question) {
        requestCandidates(entry);
      } else {
        showCandidatePanel(entry, [], false, "문제 내용을 읽지 못했습니다.");
      }
    }, 0);
  }

  function clearSelection() {
    state.selectedBarId = null;
    state.selectedRound = null;
    state.pendingSubmission = null;
    clearTimeout(state.candidateTimer);
    hideCandidatePanel();
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

  function recordKey(record) {
    if (
      record?.sessionId &&
      record?.roundIndex &&
      record?.posKey &&
      record?.answer
    ) {
      return [
        record.sessionId,
        record.roundIndex,
        record.posKey,
        record.answer
      ].join("|");
    }

    return [
      record?.type || "",
      record?.question || "",
      record?.answer || ""
    ].join("|");
  }

  function hasStoredDuplicate(records, record) {
    const key = recordKey(record);
    return records.some((item) => recordKey(item) === key);
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

  function enqueueQuestionWrites(recordsToSave) {
    if (!Array.isArray(recordsToSave) || recordsToSave.length === 0) {
      return Promise.resolve();
    }

    state.writeChain = state.writeChain
      .then(async () => {
        const loaded = await chromeGet(QUESTION_STORAGE_KEY);
        const records = Array.isArray(loaded) ? loaded : [];
        const existing = new Set(
          records.map((item) =>
            [
              item?.sessionId || "",
              item?.roundIndex ?? "",
              item?.posKey || ""
            ].join("|")
          )
        );

        let changed = false;

        for (const record of recordsToSave) {
          const key = [
            record?.sessionId || "",
            record?.roundIndex ?? "",
            record?.posKey || ""
          ].join("|");

          if (!record?.sessionId || !record?.posKey || existing.has(key)) {
            continue;
          }

          records.push(record);
          existing.add(key);
          changed = true;
        }

        if (changed) {
          await chromeSet(QUESTION_STORAGE_KEY, records);
          showSaveNotice(`문제 ${recordsToSave.length}개 저장됨`);
        }
      })
      .catch((error) => {
        console.warn("[KKuTu 기록기] 문제 저장 실패:", error.message);
      });

    return state.writeChain;
  }

  function ingestQuestionBank(means, boards) {
    if (!Array.isArray(means)) return;

    let signature;
    try {
      signature = JSON.stringify({ means, boards });
    } catch (error) {
      console.warn("[KKuTu 기록기] 문제 데이터 직렬화 실패:", error);
      return;
    }

    if (!state.sessionId) {
      state.sessionId = makeSessionId();
    }

    if (signature !== state.meansSignature) {
      state.meansSignature = signature;
      state.sessionId = makeSessionId();
      state.questionMap.clear();
    }

    const questionRecords = [];

    means.forEach((roundData, roundIndex) => {
      if (!roundData || typeof roundData !== "object") return;

      Object.entries(roundData).forEach(([posKey, item]) => {
        if (!item || typeof item !== "object") return;

        const question = normalizeCrosswordMean(item.mean);
        if (!question) return;

        const x = Number(item.x);
        const y = Number(item.y);
        const dir = Number(item.dir);
        const length = Number(item.len);

        const normalizedPosKey = [
          Number.isFinite(x) ? x : item.x,
          Number.isFinite(y) ? y : item.y,
          Number.isFinite(dir) ? dir : item.dir
        ].join(",");

        const entry = {
          sessionId: state.sessionId,
          roundIndex: roundIndex + 1,
          roundIndex0: roundIndex,
          posKey: normalizedPosKey,
          x: Number.isFinite(x) ? x : item.x,
          y: Number.isFinite(y) ? y : item.y,
          dir: Number.isFinite(dir) ? dir : item.dir,
          type: cleanText(item.type),
          theme: cleanText(item.theme),
          question,
          length: Number.isFinite(length) ? length : null,
          collectedAt: new Date().toISOString()
        };

        state.questionMap.set(
          `${roundIndex}|${normalizedPosKey}`,
          entry
        );
        questionRecords.push(entry);
      });
    });

    enqueueQuestionWrites(questionRecords);
    console.log(
      "[KKuTu 기록기] 전체 문제 자동 수집:",
      questionRecords.length,
      "개"
    );
  }

  function getPlayerInfo(playerId) {
    const id = playerId == null ? "" : String(playerId);
    const user = id
      ? document.getElementById("game-user-" + id)
      : null;
    const nameElement = user?.querySelector(".game-user-name");

    return {
      playerId: id || null,
      playerName: cleanText(nameElement?.textContent || "") || id || "알 수 없음"
    };
  }

  function getSelfPlayerInfo() {
    const nameElement = document.querySelector(".game-user-my-name");
    const user = nameElement?.closest(".game-user");
    const playerId = user?.id?.startsWith("game-user-")
      ? user.id.slice("game-user-".length)
      : null;

    return {
      playerId,
      playerName: cleanText(nameElement?.textContent || "") || "나"
    };
  }

  function saveTurnEnd(detail) {
    if (!detail || typeof detail !== "object") return;

    if (!state.sessionId) state.sessionId = makeSessionId();

    const playerId = detail.id ?? detail.target;
    const data = detail.data || {};
    const pos = Array.isArray(data.pos) ? data.pos : null;
    const answer = normalizeAnswer(data.value);

    if (!pos || pos.length < 4 || !answer) return;

    const roundIndex0 = Number(pos[0]);
    if (!Number.isInteger(roundIndex0)) return;

    const posKey = [pos[1], pos[2], pos[3]].join(",");
    const question = state.questionMap.get(
      `${roundIndex0}|${posKey}`
    );

    const player = getPlayerInfo(playerId);
    const self = getSelfPlayerInfo();
    const isSelf =
      Boolean(player.playerId) &&
      Boolean(self.playerId) &&
      player.playerId === self.playerId;

    const record = {
      sessionId: state.sessionId || makeSessionId(),
      source: isSelf ? "self" : "other",
      playerId: player.playerId,
      playerName: player.playerName,
      roundIndex: roundIndex0 + 1,
      pos: pos.slice(0, 4),
      posKey,
      type: question?.type || null,
      theme: question?.theme || null,
      question: question?.question || null,
      length: question?.length ?? answer.length,
      answer,
      score: Number.isFinite(Number(data.score)) ? Number(data.score) : null,
      savedAt: new Date().toISOString()
    };

    console.log("[KKuTu 기록기] 정답 감지:", record);
    enqueueWrite(record);
  }

  function onBridgeMeans(event) {
    if (state.destroyed) return;

    try {
      const payload =
        typeof event.detail === "string"
          ? JSON.parse(event.detail)
          : event.detail;
      ingestQuestionBank(payload?.means, payload?.boards);
    } catch (error) {
      console.warn("[KKuTu 기록기] 문제 데이터 수신 실패:", error);
    }
  }

  function onBridgeTurnEnd(event) {
    if (state.destroyed) return;

    try {
      const payload =
        typeof event.detail === "string"
          ? JSON.parse(event.detail)
          : event.detail;
      saveTurnEnd(payload);
    } catch (error) {
      console.warn("[KKuTu 기록기] 정답 데이터 수신 실패:", error);
    }
  }

  function injectPageBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(BRIDGE_SCRIPT);
    script.async = false;

    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => {
      console.warn(
        "[KKuTu 기록기] 페이지 브리지 로드 실패. " +
        "기본 사용자 입력 기록 기능은 계속 동작합니다."
      );
      script.remove();
    }, { once: true });

    (document.head || document.documentElement).appendChild(script);
  }

  function enqueueWrite(record) {
    state.writeChain = state.writeChain
      .then(async () => {
        const loaded = await chromeGet(STORAGE_KEY);
        const records = Array.isArray(loaded) ? loaded : [];

        if (hasStoredDuplicate(records, record)) return;

        records.push(record);
        await chromeSet(STORAGE_KEY, records);
        showSaveNotice(
          record.source === "other"
            ? `정답 저장됨 · ${record.playerName || "다른 플레이어"}: ${record.answer}`
            : `정답 저장됨: ${record.answer}`
        );
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

    const self = getSelfPlayerInfo();
    const barParts = String(pending.barId || "").slice(3).split("-");
    const posKey = barParts.length === 3 ? barParts.join(",") : null;

    const record = {
      sessionId: state.sessionId || makeSessionId(),
      source: "self",
      playerId: self.playerId,
      playerName: self.playerName,
      roundIndex: pending.roundIndex + 1,
      pos: barParts.length === 3 ? barParts : null,
      posKey,
      type: pending.type,
      question: pending.question,
      answer,
      length: pending.length,
      score: null,
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
    window.removeEventListener(BRIDGE_MEANS_EVENT, onBridgeMeans);
    window.removeEventListener(BRIDGE_TURN_END_EVENT, onBridgeTurnEnd);

    const toast = document.getElementById("__kkutuRecorderToast");
    if (toast) {
      clearTimeout(toast.__kkutuTimer);
      toast.remove();
    }

    clearTimeout(state.candidateTimer);
    hideCandidatePanel();

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
  window.addEventListener(BRIDGE_MEANS_EVENT, onBridgeMeans);
  window.addEventListener(BRIDGE_TURN_END_EVENT, onBridgeTurnEnd);

  injectPageBridge();

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