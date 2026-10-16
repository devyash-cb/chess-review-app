/**
 * engine.js
 * Priority Queue Manager with Hybrid Evaluation Math (Win% + CP Loss),
 * strict 20-move follow-up capping, and Game-ID filtered cache management.
 */

import { Chess } from './chess.js';
import { openDB, saveAnalyzedGame } from './analysis.js';

let sfWorker = null;
let threads = 1;
let targetDepth = 12;

function sysLog(step, details = {}) {
  try {
    let logs = JSON.parse(localStorage.getItem("chessEngineLogs") || "[]");
    logs.push({ time: new Date().toLocaleTimeString(), step, ...details });
    if (logs.length > 150) logs.shift();
    localStorage.setItem("chessEngineLogs", JSON.stringify(logs));
  } catch(e) {}
}

if (typeof SharedArrayBuffer !== 'undefined' && typeof window !== 'undefined' && window.crossOriginIsolated) {
  threads = navigator.hardwareConcurrency || 2;
}

if (threads >= 8) targetDepth = 20;
else if (threads >= 4) targetDepth = 16;
else targetDepth = 12;

let gameDataRef = null;
let taskQueue = [];
let isWorkerBusy = false;
let currentTaskAborter = null;

export function getEngineInfo() {
  return { threads, targetDepth };
}

function initWorker() {
  if (sfWorker) return;
  try {
    sfWorker = new Worker('stockfish/stockfish-19-lite-single.js');
    sfWorker.postMessage("uci");
    sfWorker.postMessage(`setoption name Threads value ${threads}`);
    sfWorker.postMessage("isready");
  } catch(e) {}
}

function winPercent(cp) {
  return 100 / (1 + Math.exp(-0.00368208 * cp * 100));
}

export function safeMove(chessObj, moveStr) {
  if (!moveStr) return null;
  let clean = moveStr.trim();
  try { const m = chessObj.move(clean); if (m) return m; } catch(e){}
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(clean)) {
    const from = clean.substring(0, 2);
    const to = clean.substring(2, 4);
    const promotion = clean.length === 5 ? clean[4].toLowerCase() : undefined;
    try { const m = chessObj.move({ from, to, promotion }); if (m) return m; } catch(e){}
  }
  return null;
}

export async function initEngineForGame(gameData) {
  gameDataRef = gameData;
  initWorker();

  // ONLY clear branch caches from OTHER games to preserve current session reloads
  Object.keys(sessionStorage).forEach(k => {
    if (k.startsWith("branch_") && !k.startsWith(`branch_${gameData.id}_`)) {
      sessionStorage.removeItem(k);
    }
  });

  const tChess = new Chess();
  for (let m of gameData.moves) {
    if (m.followup1) {
      tChess.load(m.fenAfter);
      const pvMoves = m.followup1.split(" ");
      let validMoves = [];
      for (let pvMove of pvMoves) {
        if (!safeMove(tChess, pvMove)) break;
        validMoves.push(pvMove);
        if (validMoves.length >= 20) break; 
        try {
          sessionStorage.setItem(`branch_${gameData.id}_${tChess.fen()}`, JSON.stringify({ 
            eval: m.eval, classification: 'best', best1: pvMove
          }));
        } catch(e) { break; }
      }
      m.followup1 = validMoves.join(" ");
    }

    const cls = m.classification;
    if ([0, 1, 2, 7, 8, 9, "blunder", "miss", "mistake", "inaccuracy", "great", "brilliant"].includes(cls)) {
      taskQueue.push({ type: 'IDLE', move: m, priority: 2 });
    }
  }

  processQueue();
}

async function processQueue() {
  if (isWorkerBusy || taskQueue.length === 0) return;
  taskQueue.sort((a, b) => a.priority - b.priority);
  const task = taskQueue.shift();

  isWorkerBusy = true;
  let aborted = false;

  currentTaskAborter = () => {
    aborted = true;
    sfWorker.postMessage("stop");
    if (task.priority === 2) {
      const existing = taskQueue.find(t => t.move === task.move);
      if (!existing) taskQueue.unshift(task);
    }
  };

  try {
    if (task.type === 'IDLE') await runIdleTask(task, () => aborted);
    else if (task.type === 'EVAL') await runEvalTask(task, () => aborted);
  } catch (err) {} finally {
    isWorkerBusy = false;
    currentTaskAborter = null;
    processQueue();
  }
}

function interruptForTask(taskObj) {
  taskQueue.push(taskObj);
  if (isWorkerBusy && currentTaskAborter) {
    currentTaskAborter();
  } else {
    processQueue();
  }
}

export function analyzeCustomMove(branchMove, mainlineData, currentPly, branchMoves, branchPly, onProgress) {
  return new Promise((resolve) => {
    const cacheKey = `branch_${gameDataRef.id}_${branchMove.fenAfter}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) return resolve(JSON.parse(cached));

    let prevE = 0.15;
    if (branchPly > 1) {
        prevE = branchMoves[branchPly - 2].eval;
    } else if (currentPly > 0) {
        prevE = mainlineData.moves[currentPly-1].eval || 0.15;
    }

    interruptForTask({
      type: 'EVAL', priority: 1,
      fenAfter: branchMove.fenAfter,
      fenBefore: branchMove.fenBefore,
      color: branchMove.color,
      prevEval: prevE,
      onProgress, resolve, isBranch: true
    });
  });
}

export function extendSequence(fen, prevEval, onProgress) {
  return new Promise((resolve) => {
    interruptForTask({
      type: 'EVAL', priority: 0,
      fenAfter: fen, fenBefore: fen,
      color: fen.split(' ')[1] === 'w' ? 'b' : 'w',
      prevEval: prevEval,
      onProgress, resolve, isBranch: false
    });
  });
}

function runEvalTask(task, isAborted) {
  return new Promise((resolveInner) => {
    let bestCp = 0;
    let lastPv = "";
    let bestUci = "";
    let showedDepth12 = false;
    let timer12 = null;

    const timeout = setTimeout(() => {
      task.resolve({ eval: task.prevEval, classification: 'good', fenAfter: task.fenAfter, fenBefore: task.fenBefore });
      resolveInner();
    }, 15000);

    sfWorker.onmessage = (e) => {
      const line = String(e.data);

      if (line.startsWith("info depth ")) {
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) {
          const depth = parseInt(depthMatch[1]);
          const pvMatch = line.match(/ pv (.+)/);
          if (pvMatch) {
            lastPv = pvMatch[1];
            bestUci = lastPv.split(" ")[0];

            if (task.onProgress && depth >= 12 && !showedDepth12) {
              showedDepth12 = true;
              task.onProgress({ depth: 12, bestMove: bestUci, pv: lastPv });

              timer12 = setTimeout(() => {
                if (task.onProgress && bestUci) {
                  task.onProgress({ depth: Math.min(20, depth), bestMove: bestUci, pv: lastPv });
                }
              }, 500);
            } else if (task.onProgress && depth >= 16 && showedDepth12) {
              if (timer12) { clearTimeout(timer12); timer12 = null; }
              task.onProgress({ depth: Math.min(20, depth), bestMove: bestUci, pv: lastPv });
            }
          }
          if (line.includes("score cp ")) bestCp = parseInt(line.match(/\bscore cp (-?\d+)/)[1]) / 100;
          if (line.includes("score mate ")) bestCp = parseInt(line.match(/\bscore mate (-?\d+)/)[1]) > 0 ? 100 : -100;
        }
      }

      if (line.startsWith("bestmove")) {
        clearTimeout(timeout);
        if (timer12) clearTimeout(timer12);

        // NORMALIZE EVALUATION TO ABSOLUTE WHITE'S PERSPECTIVE
        const turnInFenAfter = task.fenAfter.split(' ')[1];
        const whiteEval = (turnInFenAfter === 'b') ? -bestCp : bestCp;

        const bWinPct = winPercent(task.prevEval);
        const aWinPct = winPercent(whiteEval);

        const winLoss = task.color === 'w' ? Math.max(0, bWinPct - aWinPct) : Math.max(0, aWinPct - bWinPct);
        const evalLoss = task.color === 'w' ? Math.max(0, task.prevEval - whiteEval) : Math.max(0, whiteEval - task.prevEval);

        let cls = 'good';
        
        // HYBRID MATH: Overrides the Win% curve at extreme evaluations to prevent false Best/Blunder classifications
        if (Math.abs(task.prevEval) > 4 || Math.abs(whiteEval) > 4) {
            if (evalLoss <= 0.2) cls = 'best';
            else if (evalLoss <= 0.5) cls = 'excellent';
            else if (evalLoss <= 1.0) cls = 'good';
            else if (evalLoss <= 1.5) cls = 'inaccuracy';
            else if (evalLoss <= 2.5) cls = 'mistake';
            else cls = 'blunder';
        } else {
            // Standard Win% curve for balanced positions
            if (winLoss < 2) cls = 'excellent';
            else if (winLoss < 5) cls = 'good';
            else if (winLoss < 10) cls = 'inaccuracy';
            else if (winLoss < 20) cls = 'mistake';
            else if (winLoss >= 20 || evalLoss >= 2.0) cls = 'blunder';
            if (winLoss === 0) cls = 'best';
        }

        const cappedPv = lastPv.split(" ").slice(0, 20).join(" ");

        const result = {
          eval: whiteEval,
          classification: cls,
          best1: bestUci,
          followup1: cappedPv,
          winPercent: aWinPct,
          fenBefore: task.fenBefore,
          fenAfter: task.fenAfter
        };

        if (task.isBranch && !isAborted()) {
          try { sessionStorage.setItem(`branch_${gameDataRef.id}_${task.fenAfter}`, JSON.stringify(result)); } catch(err) {}
        }

        task.resolve(result);
        resolveInner();
      }
    };

    sfWorker.postMessage(`position fen ${task.fenAfter}`);
    sfWorker.postMessage(`go depth ${Math.min(20, targetDepth)}`);
  });
}

function runIdleTask(task, isAborted) {
  return new Promise((resolveInner) => {
    let move = task.move;
    let targetFen = move.fenAfter;

    if (move.followup1) {
      const tempChess = new Chess(move.fenAfter);
      const moves = move.followup1.split(" ");
      let valid = [];
      for (let m of moves) {
        if (!safeMove(tempChess, m)) break;
        valid.push(m);
        if (valid.length >= 20) break;
      }
      move.followup1 = valid.join(" ");
      targetFen = tempChess.fen();
    }

    let lastPv = "";
    const timeout = setTimeout(() => resolveInner(), 15000);

    sfWorker.onmessage = async (e) => {
      const line = String(e.data);
      if (line.includes(" pv ")) lastPv = line.match(/ pv (.+)/)[1];

      if (line.startsWith("bestmove")) {
        clearTimeout(timeout);
        if (lastPv && !isAborted()) {
          const tc = new Chess(targetFen);
          const newMoves = lastPv.split(" ");
          let validNew = [];

          for (let nm of newMoves) {
            if (!safeMove(tc, nm)) break;
            validNew.push(nm);
            try { sessionStorage.setItem(`branch_${gameDataRef.id}_${tc.fen()}`, JSON.stringify({ eval: move.eval, classification: 'best' })); } catch(e) {}
          }

          if (validNew.length > 0) {
            const currentChain = move.followup1 ? move.followup1.split(" ") : [];
            const combined = [...currentChain, ...validNew].slice(0, 20); 
            move.followup1 = combined.join(" ");
            move.targetDepth = Math.min(20, targetDepth);
            if (gameDataRef) await saveAnalyzedGame(gameDataRef);
          }
        }
        resolveInner();
      }
    };

    sfWorker.postMessage(`position fen ${targetFen}`);
    sfWorker.postMessage(`go depth ${Math.min(20, targetDepth)}`);
  });
}
