/**
 * uiengine.js
 * Dedicated Board UI, Piece Rendering, SVG Arrow, and Overlay Engine.
 */

import { Chess } from './chess.js';

let arrowLayer = null;

export function getCoords(sq, reviewColor) {
  const xRaw = sq.charCodeAt(0) - 97;
  const yRaw = parseInt(sq[1]) - 1;
  const x = reviewColor === 'w' ? xRaw : 7 - xRaw;
  const y = reviewColor === 'w' ? 7 - yRaw : yRaw;
  return { x, y };
}

export function createBoardGrid(boardEl, boardClickArea, evalFill, reviewColor) {
  boardEl.innerHTML = "";
  const ranks = reviewColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = reviewColor === 'w' ? ['a','b','c','d','e','f','g','h'] : ['h','g','f','e','d','c','b','a'];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const squareId = files[f] + ranks[r];
      const isLight = (f + r) % 2 === 0;

      const sqDiv = document.createElement("div");
      sqDiv.className = `square ${isLight ? 'light' : 'dark'}`;
      sqDiv.id = `sq-${squareId}`;

      const highlightDiv = document.createElement("div");
      highlightDiv.className = "highlight-overlay";
      highlightDiv.id = `hl-${squareId}`;
      sqDiv.appendChild(highlightDiv);

      const dotDiv = document.createElement("div");
      dotDiv.className = "legal-dot";
      dotDiv.id = `dot-${squareId}`;
      dotDiv.style.display = "none";
      sqDiv.appendChild(dotDiv);

      if (f === 0) {
        const cRank = document.createElement("div");
        cRank.className = "coord-rank coord-text";
        cRank.textContent = ranks[r];
        sqDiv.appendChild(cRank);
      }
      if (r === 7) {
        const cFile = document.createElement("div");
        cFile.className = "coord-file coord-text";
        cFile.textContent = files[f];
        sqDiv.appendChild(cFile);
      }
      boardEl.appendChild(sqDiv);
    }
  }

  let existingSvg = document.getElementById("nativeArrowLayer");
  if (existingSvg) existingSvg.remove();

  arrowLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowLayer.id = "nativeArrowLayer";
  arrowLayer.setAttribute("viewBox", "0 0 100 100");
  arrowLayer.setAttribute("preserveAspectRatio", "none");
  arrowLayer.setAttribute("style", "position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 25;");
  boardClickArea.appendChild(arrowLayer);

  evalFill.className = `eval-fill`;
}

export function renderPieces(pieceLayer, fen, reviewColor, pieceSetDB, activePieceSet) {
  try {
    const tempChess = new Chess(fen);
    pieceLayer.innerHTML = "";
    const boardArray = tempChess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (boardArray[r][f]) {
          const sq = String.fromCharCode(97 + f) + (8 - r);
          const p = document.createElement("div");
          p.className = "piece";
          p.dataset.sq = sq;
          
          let pieceKey = boardArray[r][f].color + boardArray[r][f].type;
          let pieceUrl = `pieces/${pieceKey}.png`;
          if (pieceSetDB && pieceSetDB[activePieceSet]) {
            const conf = pieceSetDB[activePieceSet];
            pieceUrl = `${conf.src_path}${conf.pieces[pieceKey]}`;
          }
          p.style.backgroundImage = `url(${pieceUrl})`;

          const coords = getCoords(sq, reviewColor);
          p.style.transform = `translate(${coords.x * 100}\%,${coords.y * 100}%)`;
          pieceLayer.appendChild(p);
        }
      }
    }
  } catch (e) {}
}

export function drawArrow(uciMove, reviewColor) {
  if (!arrowLayer || !uciMove || uciMove.length < 4) return;
  clearArrow();

  const from = uciMove.substring(0, 2);
  const to = uciMove.substring(2, 4);
  const fromCoords = getCoords(from, reviewColor);
  const toCoords = getCoords(to, reviewColor);

  const x1 = (fromCoords.x * 12.5) + 6.25;
  const y1 = (fromCoords.y * 12.5) + 6.25;
  const x2 = (toCoords.x * 12.5) + 6.25;
  const y2 = (toCoords.y * 12.5) + 6.25;

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const arrowHeadLen = 3.8;

  const p1x = x2 - arrowHeadLen * Math.cos(angle - Math.PI / 6);
  const p1y = y2 - arrowHeadLen * Math.sin(angle - Math.PI / 6);
  const p2x = x2 - arrowHeadLen * Math.cos(angle + Math.PI / 6);
  const p2y = y2 - arrowHeadLen * Math.sin(angle + Math.PI / 6);

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", "rgba(59, 130, 246, 0.75)");
  line.setAttribute("stroke-width", "2.0");
  line.setAttribute("stroke-linecap", "round");

  const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  head.setAttribute("points", `${x2},${y2} ${p1x},${p1y} ${p2x},${p2y}`);
  head.setAttribute("fill", "rgba(59, 130, 246, 0.75)");

  arrowLayer.appendChild(line);
  arrowLayer.appendChild(head);
}

export function clearArrow() {
  if (arrowLayer) {
    while (arrowLayer.firstChild) arrowLayer.removeChild(arrowLayer.firstChild);
  }
}

export function applyHighlights(badgeLayer, fromSq, toSq, cls, reviewColor, iconHtmlGetter) {
  if (!fromSq || !toSq) return;
  const hlFrom = document.getElementById(`hl-${fromSq}`);
  const hlTo = document.getElementById(`hl-${toSq}`);
  const classStr = `c-${cls}`;

  if (hlFrom) { hlFrom.style.display = "block"; hlFrom.className = `highlight-overlay ${classStr}`; }
  if (hlTo) { hlTo.style.display = "block"; hlTo.className = `highlight-overlay ${classStr}`; }

  if (cls !== 'unknown') {
    const bdg = document.createElement("div");
    bdg.className = "floating-badge";
    const coords = getCoords(toSq, reviewColor);

    bdg.style.left = `${coords.x * 12.5}%`;
    bdg.style.top = `${coords.y * 12.5}%`;
    bdg.style.transform = `none`;

    if (cls === 'loading') bdg.innerHTML = `<div class="badge-spinner"></div>`;
    else bdg.innerHTML = iconHtmlGetter(cls);

    badgeLayer.appendChild(bdg);
  }
}

export function clearHighlights(badgeLayer) {
  document.querySelectorAll(".highlight-overlay").forEach(hl => {
    hl.style.display = "none";
    hl.className = "highlight-overlay";
  });
  if (badgeLayer) badgeLayer.innerHTML = "";
  document.querySelectorAll(".legal-dot").forEach(d => d.style.display = "none");
}

export function updateEvalBar(evalFill, coachEvalBadge, evalScore, reviewColor) {
  if (evalScore === undefined || evalScore === null) return;
  
  // Convert standard absolute white eval to the HERO's visual perspective
  const wEval = Number(evalScore);
  const displayEval = reviewColor === 'b' ? -wEval : wEval;
  
  // Ensure the losing player always gets at least a 10% visible strip (unless mate)
  let fillPct = 50 + (displayEval / 8) * 50;
  if (Math.abs(displayEval) < 90) {
      fillPct = Math.max(10, Math.min(90, fillPct));
  } else {
      fillPct = Math.max(0, Math.min(100, fillPct));
  }
  
  evalFill.style.height = `${fillPct}%`;
  evalFill.style.bottom = '0';
  evalFill.style.top = 'auto';
  
  // Physically flip the light/dark colors so the Hero's color anchors the bottom
  const evalBarContainer = evalFill.parentElement;
  if (reviewColor === 'w') {
      evalFill.style.backgroundColor = '#ebecd0'; 
      evalBarContainer.style.backgroundColor = '#2A2F3A'; 
  } else {
      evalFill.style.backgroundColor = '#2A2F3A'; 
      evalBarContainer.style.backgroundColor = '#ebecd0'; 
  }
  
  let evalStr = (displayEval > 0 ? "+" : "") + Number(displayEval).toFixed(2);
  if (Math.abs(displayEval) >= 90) evalStr = displayEval > 0 ? "M" : "-M";

  if (coachEvalBadge) coachEvalBadge.textContent = evalStr;
  
  const topText = document.getElementById("evalTextTop");
  const botText = document.getElementById("evalTextBottom");
  if (topText) topText.textContent = "";
  if (botText) botText.textContent = "";
  
  if (displayEval > 0) {
      if (botText) botText.textContent = evalStr;
  } else {
      if (topText) topText.textContent = evalStr;
  }
}

export function setSequenceButtonText(clsName, inMainline) {
  const btnSeq = document.getElementById("btnSeq");
  if (!btnSeq) return;
  
  let innerText = 'Sequence';
  if (inMainline && clsName && clsName !== 'unknown' && clsName !== 'book') {
      innerText = `Why ${clsName}?`;
  }
  
  btnSeq.innerHTML = `<img src="pieces/hand.png" style="width:22px;height:22px;filter:brightness(0) invert(1);" alt="Hand" onerror="this.style.display='none'"> <span style="margin-left:6px;font-size:13px;font-weight:bold;text-transform:capitalize;">${innerText}</span>`;
}
