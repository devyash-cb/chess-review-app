/**
 * board.js
 * Analysis UI with decoupled UIEngine, debounced fast-forward, 
 * secure sequence limits, and non-destructive branch navigation.
 */

import { Chess } from './chess.js';
import { getGameFromDB, saveAnalyzedGame } from './analysis.js';
import { initComments, generateComment } from './comments.js';
import { analyzeCustomMove, initEngineForGame, extendSequence, safeMove, getEngineInfo } from './engine.js';
import {
  createBoardGrid,
  renderPieces,
  drawArrow,
  clearArrow,
  applyHighlights,
  clearHighlights,
  updateEvalBar,
  setSequenceButtonText
} from './uiengine.js';

const CLASS_NAMES = { 1: "brilliant", 2: "great", 3: "best", 4: "excellent", 5: "good", 6: "book", 7: "inaccuracy", 8: "mistake", 9: "miss", 0: "blunder" };
const CLASS_IDS = { brilliant: 1, great: 2, best: 3, excellent: 4, good: 5, book: 6, inaccuracy: 7, mistake: 8, miss: 9, blunder: 0 };
const BAD_CLASSES = ["great", "brilliant", "inaccuracy", "mistake", "miss", "blunder"];

let gameData = null;
let appSettings = JSON.parse(localStorage.getItem("chessReviewSettings") || "{}");
let pieceSetDB = null;

let currentPly = 0;
let chessDisplay = new Chess();
let reviewColor = 'w';

let seqMode = false;
let isAutoplayingSeq = false;
let seqMoves = [];
let seqPly = 0;
let simChess = new Chess();

let isBranchMode = false;
let branchMoves = [];
let branchPly = 0; // Pointer variable ensures < and > are non-destructive
let selectedSquare = null;

let isMuted = false;
let isFastForwarding = false;
let currentUtterance = null;

const boardEl = document.getElementById("chessboard");
const pieceLayer = document.getElementById("piece-layer");
const badgeLayer = document.getElementById("badge-layer");
const boardClickArea = document.getElementById("boardClickArea");
const sliderEl = document.getElementById("moveSlider");
const coachText = document.getElementById("coachText");
const coachEvalBadge = document.getElementById("coachEvalBadge");
const evalFill = document.getElementById("evalFill");
const btnSeq = document.getElementById("btnSeq");

document.addEventListener("DOMContentLoaded", async () => {
  applySettings();
  syncSettingsToModal();

  try { if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) window.Capacitor.Plugins.App.addListener('backButton', () => document.getElementById("backBtn").click()); } catch(e) {}
  try { const resPieces = await fetch('pieces.json'); if (resPieces.ok) pieceSetDB = await resPieces.json(); } catch(e) {}

  document.getElementById("muteBtn").onclick = () => {
    isMuted = !isMuted;
    appSettings.ttsVoiceEnabled = !isMuted;
    localStorage.setItem("chessReviewSettings", JSON.stringify(appSettings));
    document.getElementById("muteIcon").src = isMuted ? "pieces/mute.png" : "pieces/unmute.png";
    if (isMuted && window.speechSynthesis) window.speechSynthesis.cancel();
  };

  const params = new URLSearchParams(location.search);
  const gameId = params.get("gameId");
  document.getElementById("backBtn").href = `analysis.html?gameId=${gameId}`;

  if (!gameId) return alert("No game ID provided.");

  gameData = await getGameFromDB(gameId);
  if (!gameData || !gameData.moves) return alert("Could not load game data.");

  let perspective = appSettings.reviewPerspective || "auto";
  if (perspective === "auto") {
    const user = (appSettings.username || "").toLowerCase().trim();
    reviewColor = (user && user === (gameData.black || "").toLowerCase().trim()) ? 'b' : 'w';
  } else {
    reviewColor = perspective;
  }

  createBoardGrid(boardEl, boardClickArea, evalFill, reviewColor);
  buildMoveSlider();
  initEngineForGame(gameData);

  const infoBtn = document.querySelector('button[onclick*="infoModal"]');
  if (infoBtn) {
      infoBtn.innerHTML = 'ℹ️';
      infoBtn.style.fontSize = '18px';
  }
  const modalBox = document.querySelector('#infoModal .modal-box');
  if (modalBox) {
      const engInfo = getEngineInfo();
      const infoP = modalBox.querySelector('p');
      if (infoP) {
          infoP.innerHTML = `<br><strong>Engine Details</strong><br>Target Depth: ${engInfo.targetDepth}<br>Allocated Threads:${engInfo.threads}<br><br><strong>Pro Tips:</strong><br>• Hold down < or > for 0.7s to quickly fast forward through moves.<br>• Play pieces directly on the board to branch out and test custom lines.<br>• Engine follow-ups are safely capped at 20 plies.`;
          infoP.style.textAlign = 'left';
          infoP.style.color = '#d6cee0';
      }
  }

  try {
    const msData = JSON.parse(localStorage.getItem("moveshow"));
    if (msData && typeof msData.ply === 'number') currentPly = msData.ply;
    localStorage.removeItem("moveshow");
  } catch (e) {}

  await initComments();
  document.getElementById("loadingOverlay").style.display = "none";

  snapToState();

  setupLongPress("btnPrevMove", handlePrev);
  setupLongPress("btnNextMove", handleNext);

  boardClickArea.addEventListener('click', handleBoardClick);
  document.getElementById("btnHint").onclick = showHint;
  document.getElementById("btnSeq").onclick = handleSequenceAction;
  document.getElementById("btnFF").onclick = toggleFastForward;

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.id === 'settingsModal') window.saveAndCloseSettings();
        else overlay.classList.add('hidden');
      }
    });
  });
});

function applySettings() {
  document.documentElement.style.setProperty('--sq-light', appSettings.wHexCode || '#ebecd0');
  document.documentElement.style.setProperty('--sq-dark', appSettings.bHexCode || '#739552');
  document.documentElement.style.setProperty('--move-duration', `${appSettings.moveSpeed || 0.4}s`);
  isMuted = !appSettings.ttsVoiceEnabled;
  document.getElementById("muteIcon").src = isMuted ? "pieces/mute.png" : "pieces/unmute.png";
}

let settingsSnapshot = "";
window.openSettings = function() {
  settingsSnapshot = JSON.stringify(appSettings);
  document.getElementById('settingsModal').classList.remove('hidden');
};

function syncSettingsToModal() {
  if (!document.getElementById("cfgMoveSpeed")) return;
  document.getElementById("cfgPerspective").value = appSettings.reviewPerspective || "auto";
  document.getElementById("cfgMoveSpeed").value = appSettings.moveSpeed || 0.4;
  document.getElementById("valMoveSpeed").textContent = (appSettings.moveSpeed || 0.4) + "s";
  document.getElementById("cfgReadingTime").value = appSettings.readingDuration || 3;
  document.getElementById("valReadingTime").textContent = (appSettings.readingDuration || 3) + "s";
  document.getElementById("cfgSeqSpeed").value = appSettings.seqSpeed || 2;
  document.getElementById("valSeqSpeed").textContent = (appSettings.seqSpeed || 2) + "s";
  document.getElementById("cfgFFSpeed").value = appSettings.ffSpeed || 0.2;
  document.getElementById("valFFSpeed").textContent = (appSettings.ffSpeed || 0.2) + "s";
  document.getElementById("cfgAutoSeq").checked = appSettings.autoPlaySeq !== false;

  ["cfgMoveSpeed", "cfgReadingTime", "cfgSeqSpeed", "cfgFFSpeed"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", (e) => document.getElementById(id.replace("cfg", "val")).textContent = e.target.value + "s");
  });
}

window.saveAndCloseSettings = function() {
  appSettings.reviewPerspective = document.getElementById("cfgPerspective").value;
  appSettings.moveSpeed = parseFloat(document.getElementById("cfgMoveSpeed").value);
  appSettings.readingDuration = parseInt(document.getElementById("cfgReadingTime").value);
  appSettings.seqSpeed = parseInt(document.getElementById("cfgSeqSpeed").value);
  appSettings.ffSpeed = parseFloat(document.getElementById("cfgFFSpeed").value);
  appSettings.autoPlaySeq = document.getElementById("cfgAutoSeq").checked;

  const newStr = JSON.stringify(appSettings);
  localStorage.setItem("chessReviewSettings", newStr);
  document.getElementById('settingsModal').classList.add('hidden');

  if (settingsSnapshot !== newStr) window.location.reload();
};

function setupLongPress(btnId, actionFn) {
  const btn = document.getElementById(btnId);
  let timer, interval;
  
  const start = (e) => {
    if (e.cancelable) e.preventDefault();
    actionFn(); 
    timer = setTimeout(() => { 
        if (!seqMode) interval = setInterval(actionFn, 150); 
    }, 700);
  };
  const stop = (e) => { 
    if (e && e.cancelable) e.preventDefault();
    clearTimeout(timer); clearInterval(interval); 
  };
  
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, {passive: false});
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('touchend', stop);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
}

function getIconHTML(cls) {
  if (!cls || cls === 'unknown' || cls === 'hint') return "";
  const style = appSettings.iconStyle || 'svg';
  if (style === 'legacy') {
    const id = CLASS_IDS[cls] !== undefined ? CLASS_IDS[cls] : 5;
    return `<img src="pieces/mc/${id}.png" style="width:100%; height:100%; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.5));">`;
  } else {
    const ICONS = {
      brilliant: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#1cb0a6"/><path d="M7 6h2l-1 8H6zM15 6h2l-1 8h-2zM7 16h2v2H7zM15 16h2v2h-2z" fill="#fff"/></svg>`,
      great: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#3b82f6"/><path d="M11 6h2l-1 8h-2zM11 16h2v2h-2z" fill="#fff"/></svg>`,
      best: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#84cc16"/><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="#fff"/></svg>`,
      excellent: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#84cc16"/><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" fill="#fff"/></svg>`,
      good: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#65a30d"/><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" fill="#fff"/></svg>`,
      book: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#b4855d"/><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14H6V7h6v10zm7 0h-6V7h6v10z" fill="#fff"/></svg>`,
      inaccuracy: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#eab308"/><path d="M10 6A2 2 0 1 1 12 8v4h-2V8a2 2 0 1 1 2-2h-2zm2 10h-2v2h2v-2zM15 6h2l-1 8h-2zM15 16h2v2h-2z" fill="#fff"/></svg>`,
      mistake: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#f97316"/><path d="M12 6a3 3 0 0 0-3 3h2a1 1 0 1 1 2 0c0 2-3 2-3 5h2c0-2 3-2 3-5a3 3 0 0 0-3-3zm-1 9h2v2h-2v-2z" fill="#fff"/></svg>`,
      miss: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#ec4899"/><path d="M5 11h14v2H5z" fill="#fff"/></svg>`,
      blunder: `<svg viewBox="0 0 24 24" style="width:100%;height:100%;"><rect width="24" height="24" rx="12" fill="#ef4444"/><path d="M8 6a2 2 0 0 0-2 2h2a0 0 0 0 1 0 0c0 2-2 2-2 4h2c0-1 2-1 2-4a2 2 0 0 0-2-2zm-1 9h2v2H7v-2zm9-9a2 2 0 0 0-2 2h2a0 0 0 0 1 0 0c0 2-2 2-2 4h2c0-1 2-1 2-4a2 2 0 0 0-2-2zm-1 9h2v2h-2v-2z" fill="#fff"/></svg>`
    };
    return ICONS[cls] || ICONS.good;
  }
}

async function handleBoardClick(e) {
  if (isFastForwarding) return;

  const rect = boardEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;

  const fileIdx = Math.floor((x / rect.width) * 8);
  const rankIdx = Math.floor((y / rect.height) * 8);
  const file = reviewColor === 'w' ? String.fromCharCode(97 + fileIdx) : String.fromCharCode(104 - fileIdx);
  const rank = reviewColor === 'w' ? 8 - rankIdx : rankIdx + 1;
  const sq = file + rank;

  document.querySelectorAll(".legal-dot").forEach(d => d.style.display = "none");

  let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  if (seqMode && seqPly > 0) {
    simChess.load(currentPly > 0 ? gameData.moves[currentPly-1].fenAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    for (let i = 0; i < seqPly; i++) safeMove(simChess, seqMoves[i]);
    fen = simChess.fen();
  } else if (isBranchMode && branchPly > 0) {
    fen = branchMoves[branchPly-1].fenAfter;
  } else if (currentPly > 0) {
    fen = gameData.moves[currentPly-1].fenAfter;
  }

  let tChess = new Chess(fen);

  if (selectedSquare) {
    const moves = tChess.moves({ square: selectedSquare, verbose: true });
    const match = moves.find(m => m.to === sq);
    if (match) {
      selectedSquare = null;
      await executeUserMove(match);
      return;
    }
  }

  const piece = tChess.get(sq);
  if (piece && piece.color === tChess.turn()) {
    selectedSquare = sq;
    const legalMoves = tChess.moves({ square: sq, verbose: true });
    legalMoves.forEach(m => {
      const dot = document.getElementById(`dot-${m.to}`);
      if (dot) dot.style.display = "block";
    });
  } else {
    selectedSquare = null;
  }
}

async function executeUserMove(moveObj) {
  const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || '');

  // 1. Sequence Mode Execution
  if (seqMode) {
    if (seqPly < seqMoves.length && playedUci === seqMoves[seqPly]) {
      seqPly++;
      snapToState();
      if (seqPly >= seqMoves.length) {
          if (seqMoves.length >= 20) return coachText.textContent = "Engine sequence limit (20 moves) reached.";
          requestSequenceExtension();
      }
      return;
    } else {
      isBranchMode = true;
      branchMoves = [];

      let tempFen = currentPly > 0 ? gameData.moves[currentPly-1].fenAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      let tempC = new Chess(tempFen);

      for (let i = 0; i < seqPly; i++) {
        let fb = tempC.fen();
        let m = safeMove(tempC, seqMoves[i]);
        if (m) {
          branchMoves.push({
            ply: currentPly + i + 1,
            color: m.color, san: m.san, from: m.from, to: m.to,
            fenBefore: fb, fenAfter: tempC.fen(),
            classification: 'best', eval: null
          });
        }
      }
      branchPly = seqPly;

      seqMode = false;
      isAutoplayingSeq = false;
      btnSeq.classList.remove("active-state");
      coachText.textContent = "Analyzing custom variation...";
    }
  }

  // 2. Mainline
  if (!isBranchMode && currentPly < gameData.moves.length) {
    const actualNext = gameData.moves[currentPly];
    if (actualNext.san === moveObj.san || (actualNext.uci && actualNext.uci === playedUci)) {
      handleNext();
      return;
    }

    const targetMove = gameData.moves[currentPly];
    if (targetMove && targetMove.best1 === playedUci) {
      seqMode = true;
      btnSeq.classList.add("active-state");
      let sequenceStr = targetMove.followup1 || targetMove.best1;
      seqMoves = sequenceStr.trim().split(/\s+/).filter(Boolean);
      if (!seqMoves.includes(targetMove.best1)) seqMoves.unshift(targetMove.best1);
      seqPly = 1;
      snapToState();
      return;
    }
  }

  // 3. Custom Branch
  if (isBranchMode && branchPly < branchMoves.length) {
      branchMoves = branchMoves.slice(0, branchPly);
  }

  let tempFen = (isBranchMode && branchPly > 0) 
      ? branchMoves[branchPly - 1].fenAfter 
      : (currentPly > 0 ? gameData.moves[currentPly-1].fenAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
      
  let tChess = new Chess(tempFen);
  const moveRes = tChess.move({ from: moveObj.from, to: moveObj.to, promotion: 'q' });

  isBranchMode = true;
  const newBranchMove = {
    ply: currentPly + branchPly + 1,
    color: moveRes.color,
    san: moveRes.san,
    from: moveRes.from,
    to: moveRes.to,
    fenBefore: tempFen,
    fenAfter: tChess.fen(),
    classification: 'loading',
    eval: null
  };

  branchMoves.push(newBranchMove);
  branchPly++;
  snapToState();

  try {
    const cached = sessionStorage.getItem(`branch_${gameData.id}_${newBranchMove.fenAfter}`);
    if (cached) {
      const cData = JSON.parse(cached);
      if (cData.best1) drawArrow(cData.best1, reviewColor);
    }

    const res = await analyzeCustomMove(newBranchMove, gameData, currentPly, branchMoves, branchPly, (prog) => {
      drawArrow(prog.bestMove, reviewColor);
    });

    newBranchMove.classification = res.classification;
    newBranchMove.eval = res.eval;

    if (isBranchMode && branchMoves[branchPly - 1] === newBranchMove) {
      snapToState();
      if (res.best1) drawArrow(res.best1, reviewColor);
    }
  } catch (err) {}
}

function snapToState() {
  clearHighlights(badgeLayer);
  clearArrow();
  selectedSquare = null;

  if (seqMode) {
    const targetMove = currentPly < gameData.moves.length ? gameData.moves[currentPly] : gameData.moves[currentPly - 1];
    simChess.load(currentPly > 0 ? gameData.moves[currentPly-1].fenAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    for (let i = 0; i < seqPly; i++) safeMove(simChess, seqMoves[i]);
    renderPieces(pieceLayer, simChess.fen(), reviewColor, pieceSetDB, appSettings.activePieceSet);

    if (seqPly > 0) {
      const history = simChess.history({verbose: true});
      const last = history[history.length - 1];
      applyHighlights(badgeLayer, last.from, last.to, "best", reviewColor, getIconHTML);
    }
    
    setSequenceButtonText('Sequence', false);
    updateSequenceChat();
    updateEvalBar(evalFill, coachEvalBadge, targetMove.best1Eval !== undefined ? targetMove.best1Eval : targetMove.eval, reviewColor);

  } else if (isBranchMode && branchPly > 0) {
    const bMove = branchMoves[branchPly - 1];
    renderPieces(pieceLayer, bMove.fenAfter, reviewColor, pieceSetDB, appSettings.activePieceSet);

    let displayCls = typeof bMove.classification === "number" ? CLASS_NAMES[bMove.classification] : (bMove.classification || "unknown");
    applyHighlights(badgeLayer, bMove.from, bMove.to, displayCls, reviewColor, getIconHTML);
    document.querySelectorAll('.move-ply.active').forEach(el => el.classList.remove('active'));

    setSequenceButtonText('Sequence', false);
    
    if (bMove.classification === 'loading') {
      coachText.textContent = "Analyzing custom variation...";
      coachEvalBadge.textContent = "---";
    } else {
      updateGameChat(bMove, displayCls);
      updateEvalBar(evalFill, coachEvalBadge, bMove.eval, reviewColor);
    }

  } else {
    let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    let lastMove = null;

    if (currentPly > 0) {
      lastMove = gameData.moves[currentPly - 1];
      fen = lastMove.fenAfter;
    }

    renderPieces(pieceLayer, fen, reviewColor, pieceSetDB, appSettings.activePieceSet);
    updateSliderHighlight();

    if (lastMove) {
      let clsName = typeof lastMove.classification === "number" || !isNaN(lastMove.classification)
                    ? CLASS_NAMES[parseInt(lastMove.classification)]
                    : (lastMove.classification || "unknown");

      let fromSq = lastMove.from;
      let toSq = lastMove.to;

      if (!fromSq || !toSq) {
        if (lastMove.uci && lastMove.uci.length >= 4) {
          fromSq = lastMove.uci.substring(0, 2);
          toSq = lastMove.uci.substring(2, 4);
        } else if (lastMove.fenBefore && lastMove.san) {
          try {
            const tempChess = new Chess(lastMove.fenBefore);
            const m = tempChess.move(lastMove.san);
            if (m) { fromSq = m.from; toSq = m.to; }
          } catch(e) {}
        }
      }

      applyHighlights(badgeLayer, fromSq, toSq, clsName, reviewColor, getIconHTML);
      updateGameChat(lastMove, clsName);
      updateEvalBar(evalFill, coachEvalBadge, lastMove.eval, reviewColor);
      setSequenceButtonText(clsName, true);

      const currentNextMove = gameData.moves[currentPly];
      if (currentNextMove && currentNextMove.best1) drawArrow(currentNextMove.best1, reviewColor);
    } else {
      setSequenceButtonText('Sequence', false);
      coachText.textContent = "Let's review the game.";
      coachEvalBadge.textContent = "0.00";
      updateEvalBar(evalFill, coachEvalBadge, 0.15, reviewColor);
      if (gameData.moves[0] && gameData.moves[0].best1) drawArrow(gameData.moves[0].best1, reviewColor);
    }
  }
}

function handleNext() {
  if (isFastForwarding) stopFastForward();
  if (seqMode) {
    isAutoplayingSeq = false;
    if (seqPly < seqMoves.length) {
      seqPly++;
      snapToState();
    } else {
      if (seqMoves.length >= 20) return; 
      requestSequenceExtension();
    }
  } else if (isBranchMode) {
    if (branchPly < branchMoves.length) {
        branchPly++;
        snapToState();
    }
  } else {
    if (currentPly < gameData.moves.length) { currentPly++; snapToState(); }
  }
}

function handlePrev() {
  if (isFastForwarding) stopFastForward();
  if (seqMode) {
    isAutoplayingSeq = false;
    seqPly--;
    if (seqPly <= 0) exitSeqMode(); else snapToState();
  } else if (isBranchMode) {
    branchPly--;
    if (branchPly <= 0) { 
        isBranchMode = false; 
        branchMoves = []; 
        snapToState(); 
    } else { 
        snapToState(); 
    }
  } else {
    if (currentPly > 0) { currentPly--; snapToState(); }
  }
}

async function requestSequenceExtension() {
  coachText.textContent = "Extending sequence analysis...";
  const targetMove = gameData.moves[currentPly];

  simChess.load(currentPly > 0 ? gameData.moves[currentPly-1].fenAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  for (let i = 0; i < seqMoves.length; i++) safeMove(simChess, seqMoves[i]);

  try {
    const res = await extendSequence(simChess.fen(), targetMove.eval || 0.15, (prog) => {
      drawArrow(prog.bestMove, reviewColor);
      coachText.innerHTML = `Calculating extension...<br>PV: ${prog.pv}`;
    });

    clearArrow();
    if (res.best1 && seqMode) {
      if (res.followup1) {
        const newMoves = res.followup1.split(" ");
        newMoves.forEach(nm => {
          if (!seqMoves.includes(nm) && seqMoves.length < 20) seqMoves.push(nm);
        });
        targetMove.followup1 = seqMoves.slice(1).join(" ");
        saveAnalyzedGame(gameData);
      } else {
        if (seqMoves.length < 20) seqMoves.push(res.best1);
      }
      
      if (seqPly < seqMoves.length) {
          seqPly++;
          snapToState();
      } else {
          coachText.textContent = "Engine sequence limit (20 moves) reached.";
      }
    } else if (seqMode) {
      coachText.textContent = "End of sequence reached.";
    }
  } catch (err) {}
}

function handleSequenceAction() {
  if (isFastForwarding) stopFastForward();
  if (isBranchMode || seqMode) {
      coachText.textContent = "Only available in main line moves.";
      return;
  }
  if (currentPly >= gameData.moves.length) return coachText.textContent = "Game over. No sequence available.";

  let targetMove = gameData.moves[currentPly];
  
  const clsName = typeof targetMove.classification === "number" || !isNaN(targetMove.classification) 
                    ? CLASS_NAMES[parseInt(targetMove.classification)] 
                    : (targetMove.classification || "unknown");

  if (clsName === 'book') {
      coachText.textContent = "This is a theoretical book move analyzed by grandmasters. There is no absolute engine sequence required here!";
      return;
  }
  
  if (!targetMove || !targetMove.best1) return coachText.textContent = "No best sequence calculated.";

  seqMode = true;
  btnSeq.classList.add("active-state");

  let sequenceStr = targetMove.followup1 || targetMove.best1;
  seqMoves = sequenceStr.trim().split(/\s+/).filter(Boolean);
  if (!seqMoves.includes(targetMove.best1)) seqMoves.unshift(targetMove.best1);

  seqPly = 1;
  snapToState();
  if (appSettings.autoPlaySeq !== false) startAutoSeq();
}

async function startAutoSeq() {
  isAutoplayingSeq = true;
  while (isAutoplayingSeq && seqMode) {
    let speed = parseFloat(appSettings.seqSpeed) || 2;
    await new Promise(r => setTimeout(r, speed * 1000));
    if (!isAutoplayingSeq || !seqMode) break;

    if (seqPly < seqMoves.length) {
      seqPly++;
      snapToState();
    } else {
      if (seqMoves.length >= 20) break;
      await requestSequenceExtension();
    }
  }
  isAutoplayingSeq = false;
}

function exitSeqMode() {
  seqMode = false;
  isAutoplayingSeq = false;
  btnSeq.classList.remove("active-state");
  snapToState();
}

window.jumpToSeqMove = function(index) {
  if (!seqMode) return;
  isAutoplayingSeq = false;
  seqPly = index + 1;
  snapToState();
};

function updateSequenceChat() {
  let formatStr = "Best sequence:<br>";
  let targetMove = gameData.moves[currentPly];
  let isBlack = targetMove.color === 'b';
  let mNum = Math.ceil(targetMove.ply / 2);

  for (let i = 0; i < seqMoves.length; i++) {
    let prefix = isBlack ? (i === 0 ? `${mNum}... ` : ``) : `${mNum}. `;
    const isActive = (i === seqPly - 1) ? "active-seq" : "";
    formatStr += `${prefix}<span class="seq-move-link ${isActive}" onclick="jumpToSeqMove(${i})">${seqMoves[i]}</span> `;
    isBlack = !isBlack;
    if (!isBlack) mNum++;
  }
  coachText.innerHTML = formatStr;
}

async function toggleFastForward() {
  if (seqMode) exitSeqMode();
  if (isBranchMode) return;
  if (isFastForwarding) { stopFastForward(); return; }
  if (currentPly >= gameData.moves.length) return;

  isFastForwarding = true;
  document.getElementById("btnFF").classList.add("active-state");
  coachText.textContent = "Fast forwarding to your next critical move...";

  const ffSpeedMs = (parseFloat(appSettings.ffSpeed) || 0.2) * 1000;

  while (isFastForwarding && currentPly < gameData.moves.length) {
    const moveData = gameData.moves[currentPly];
    currentPly++;
    snapToState();

    const clsName = typeof moveData.classification === "number" || !isNaN(moveData.classification)
                    ? CLASS_NAMES[parseInt(moveData.classification)]
                    : (moveData.classification || "unknown");

    if (moveData.color === reviewColor && BAD_CLASSES.includes(clsName)) break;
    await new Promise(r => setTimeout(r, ffSpeedMs));
  }
  stopFastForward();
}

function stopFastForward() {
  isFastForwarding = false;
  document.getElementById("btnFF").classList.remove("active-state");
}

function updateGameChat(move, clsName) {
  const moveNum = Math.ceil(move.ply / 2);
  const playerStr = move.color === 'w' ? "White" : "Black";
  let msg = generateComment(moveNum, playerStr, move.san, clsName);
  coachText.textContent = msg;
  speakText(msg);
}

function showHint() {
  if (seqMode || isFastForwarding || isBranchMode) return;
  if (currentPly === 0) return coachText.textContent = "You are at the start of the game.";

  const mistakeMove = gameData.moves[currentPly - 1];
  const bestUci = mistakeMove.best1;
  if (!bestUci) return;

  const from = bestUci.substring(0, 2);
  const to = bestUci.substring(2, 4);
  const promo = bestUci.length === 5 ? bestUci[4] : undefined;

  let bestSan = bestUci;
  const tChess = new Chess(mistakeMove.fenBefore);
  try {
    const m = tChess.move({ from: from, to: to, promotion: promo });
    if (m) bestSan = m.san;
  } catch(e){}

  renderPieces(pieceLayer, tChess.fen(), reviewColor, pieceSetDB, appSettings.activePieceSet);
  clearHighlights(badgeLayer);
  applyHighlights(badgeLayer, from, to, "best", reviewColor, getIconHTML);
  drawArrow(bestUci, reviewColor);

  const msg = `Instead of ${mistakeMove.san}, the best move was ${bestSan}!`;
  coachText.textContent = msg;
  speakText(msg);
}

function speakText(text) {
  if (isMuted || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.rate = appSettings.speechRate || 1.0;
  try { window.speechSynthesis.speak(currentUtterance); } catch(e) {}
}

function buildMoveSlider() {
  let html = "";
  const moves = gameData.moves;
  for (let i = 0; i < moves.length; i += 2) {
    const w = moves[i], b = moves[i+1];
    const moveNum = Math.ceil(w.ply / 2);

    let wCls = typeof w.classification === "number" || !isNaN(w.classification) ? CLASS_NAMES[parseInt(w.classification)] : w.classification;
    let wHTML = `<div class="move-ply" id="sl-${w.ply}" onclick="window.goToSliderMove(${w.ply})">${w.san} <div class="mc-icon">${getIconHTML(wCls)}</div></div>`;

    let bHTML = '';
    if (b) {
      let bCls = typeof b.classification === "number" || !isNaN(b.classification) ? CLASS_NAMES[parseInt(b.classification)] : b.classification;
      bHTML = `<div class="move-ply" id="sl-${b.ply}" onclick="window.goToSliderMove(${b.ply})">${b.san} <div class="mc-icon">${getIconHTML(bCls)}</div></div>`;
    }

    html += `<div class="move-pair"><div class="move-num">${moveNum}.</div>${wHTML}${bHTML}</div>`;
  }
  sliderEl.innerHTML = html;
}

window.goToSliderMove = function(ply) {
  if (seqMode) exitSeqMode();
  if (isFastForwarding) stopFastForward();
  if (isBranchMode) { isBranchMode = false; branchMoves = []; branchPly = 0; }
  currentPly = ply;
  snapToState();
};

function updateSliderHighlight() {
  document.querySelectorAll('.move-ply.active').forEach(el => el.classList.remove('active'));
  if (currentPly > 0 && !seqMode && !isBranchMode) {
    const activeEl = document.getElementById(`sl-${currentPly}`);
    if (activeEl) {
      activeEl.classList.add('active');
      activeEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }
}