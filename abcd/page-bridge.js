(() => {
  "use strict";

  const GLOBAL = "__KKUTU_CW_PAGE_BRIDGE_V1__";
  const MEANS_EVENT = "__KKUTU_CW_MEANS__";
  const TURN_END_EVENT = "__KKUTU_CW_TURN_END__";
  const POLL_MS = 100;

  if (window[GLOBAL]?.cleanup) {
    window[GLOBAL].cleanup();
  }

  let stopped = false;
  let timer = null;
  let originalStart = null;
  let originalEnd = null;
  let wrappedStart = null;
  let wrappedEnd = null;

  function emit(name, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent(name, {
          detail: JSON.stringify(payload)
        })
      );
    } catch (error) {
      console.warn("[KKuTu 기록기 브리지] 이벤트 전송 실패:", error);
    }
  }

  function tryHook() {
    if (stopped) return;

    const lib = window.$lib;
    const crossword = lib?.Crossword;

    if (!crossword) return;

    if (
      typeof crossword.turnStart === "function" &&
      !crossword.turnStart.__KKUTU_RECORDER_WRAPPED__
    ) {
      const original = crossword.turnStart;

      function wrappedTurnStart(data, spec) {
        const result = original.apply(this, arguments);

        try {
          emit(MEANS_EVENT, {
            means: data?.means || null
          });
        } catch (error) {
          console.warn("[KKuTu 기록기 브리지] 문제 전송 실패:", error);
        }

        return result;
      }

      wrappedTurnStart.__KKUTU_RECORDER_WRAPPED__ = true;
      crossword.turnStart = wrappedTurnStart;
      wrappedStart = wrappedTurnStart;
      originalStart = original;

      // If the recorder was installed after the current round started,
      // forward the already-present crossword data immediately.
      try {
        const existingMeans = window.$data?._means;
        if (existingMeans) {
          emit(MEANS_EVENT, { means: existingMeans });
        }
      } catch (error) {
        console.warn("[KKuTu 기록기 브리지] 현재 문제 전송 실패:", error);
      }
    }

    if (
      typeof crossword.turnEnd === "function" &&
      !crossword.turnEnd.__KKUTU_RECORDER_WRAPPED__
    ) {
      const original = crossword.turnEnd;

      function wrappedTurnEnd(id, data) {
        const result = original.apply(this, arguments);

        try {
          if (data && Array.isArray(data.pos) && data.value != null) {
            emit(TURN_END_EVENT, {
              id: id ?? data.target ?? null,
              data: {
                pos: data.pos,
                value: data.value,
                score: data.score ?? null,
                target: data.target ?? null
              }
            });
          }
        } catch (error) {
          console.warn("[KKuTu 기록기 브리지] 정답 전송 실패:", error);
        }

        return result;
      }

      wrappedTurnEnd.__KKUTU_RECORDER_WRAPPED__ = true;
      crossword.turnEnd = wrappedTurnEnd;
      wrappedEnd = wrappedTurnEnd;
      originalEnd = original;
    }
  }

  timer = window.setInterval(tryHook, POLL_MS);
  tryHook();

  window[GLOBAL] = {
    cleanup() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
      }

      try {
        const crossword = window.$lib?.Crossword;
        if (crossword?.turnStart === wrappedStart && originalStart) {
          crossword.turnStart = originalStart;
        }
        if (crossword?.turnEnd === wrappedEnd && originalEnd) {
          crossword.turnEnd = originalEnd;
        }
      } catch (_) {
        // The page may already be tearing down.
      }

      delete window[GLOBAL];
    }
  };
})();