import { Chess } from '../chess.js';
import { createBoardGrid, renderPieces, applyHighlights, clearHighlights, drawArrow, clearArrow } from '../uiengine.js';

function formatThemeName(rawName) {
    const spaced = rawName.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
    return spaced.replace(/^./, str => str.toUpperCase());
}

export class PuzzleBoard {
    constructor(containerId, config) {
        this.container = document.getElementById(containerId);
        this.config = config;
        this.startTime = null;
        this.timerInterval = null;
        
        this.baseFen = config.puzzleData.f;
        this.chess = new Chess(this.baseFen);
        this.solutionMoves = config.puzzleData.m.split(' ');
        this.currentPly = 0;
        
        this.reviewColor = this.chess.turn() === 'w' ? 'b' : 'w';
        this.selectedSquare = null;
        this.pieceSetDB = null;
        
        this.movesPlayed = []; 
        this.viewingPly = 0;
        
        this.appSettings = JSON.parse(localStorage.getItem("chessReviewSettings") || "{}");
        this.init();
    }

    async init() {
        document.documentElement.style.setProperty('--sq-light', this.appSettings.wHexCode || '#ebecd0');
        document.documentElement.style.setProperty('--sq-dark', this.appSettings.bHexCode || '#739552');
        document.documentElement.style.setProperty('--move-duration', `${this.appSettings.moveSpeed || 0.4}s`);

        try {
            const res = await fetch('../pieces.json');
            if (res.ok) this.pieceSetDB = await res.json();
        } catch (e) {}
        
        this.renderLayout();
        this.checkAndShowReadyModal();
    }

    renderLayout() {
        const formattedTheme = formatThemeName(this.config.themeName);
        
        const lLeft = this.config.topBar.labelLeft || "Rating";
        const vLeft = this.config.topBar.valLeft !== undefined ? this.config.topBar.valLeft : (this.config.topBar.rating || "--");
        const lRight = this.config.topBar.labelRight || "Tier";
        const vRight = this.config.topBar.valRight !== undefined ? this.config.topBar.valRight : (this.config.topBar.tier || "--");

        // Ripped the modal out of here entirely. It is now handled cleanly by checkAndShowReadyModal()
        this.container.innerHTML = `
            <div style="width: 100%; max-width: 55vh; margin: 0 auto 15px auto; background:#1c1a24; border:1px solid var(--line); border-radius:12px; padding:12px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); box-sizing: border-box;">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
                    <div style="background:#2a2735; padding:8px; border-radius:6px; text-align:center;">
                        <div style="font-size:10px; color:var(--muted); text-transform:uppercase;">${lLeft}</div>
                        <div id="ui-rating-val" style="font-weight:900; color:var(--purple); font-size:16px;">${vLeft}</div>
                    </div>
                    <div style="background:#2a2735; padding:8px; border-radius:6px; text-align:center;">
                        <div style="font-size:10px; color:var(--muted); text-transform:uppercase;">${lRight}</div>
                        <div style="font-weight:900; color:#fff; font-size:16px;">${vRight}</div>
                    </div>
                    <div style="background:#2a2735; padding:8px; border-radius:6px; text-align:center;">
                        <div style="font-size:10px; color:var(--muted); text-transform:uppercase;">Time</div>
                        <div class="timer-tick" style="font-weight:900; color:#fff; font-size:16px;">00:00</div>
                    </div>
                    <div style="background:#2a2735; padding:4px; border-radius:6px; text-align:center; display:flex; align-items:center; justify-content:center;">
                        ${this.config.themeHidden 
                            ? `<button id="btnReveal" class="ghost-btn" style="font-size:11px; padding:6px; width:100%; border:none; color:var(--muted);">Show Theme</button>` 
                            : `<strong style="color:var(--purple); font-size:12px;">${formattedTheme}</strong>`}
                    </div>
                </div>
                <div id="pboard-comment" style="color:#fff; font-size:14px; line-height:1.45; height: 5.8em; overflow-y:auto; text-align:center; font-weight:700;">
                    Waiting to start...
                </div>
            </div>
            
            <div class="board-layout-wrapper">
                <div class="chessboard-wrapper" id="pb-board-area">
                    <div id="pb-grid" class="chessboard"></div>
                    <div id="pb-pieces" class="piece-layer"></div>
                    <div id="pb-badges" class="badge-layer"></div>
                </div>
            </div>

            <div class="slider-wrapper" style="width: 100%; max-width: 55vh; margin: 0 auto 15px auto; box-sizing: border-box;">
                <div class="move-slider" id="moveSliderContainer"></div>
            </div>
            
            <div class="action-controls" id="action-container" style="display:flex; gap:10px; width: 100%; max-width: 55vh; margin: 0 auto; box-sizing: border-box;"></div>
        `;

        if (this.config.themeHidden) {
            document.getElementById('btnReveal').onclick = (e) => {
                e.target.parentElement.innerHTML = `<strong style="color:var(--purple); font-size:12px;">${formattedTheme}</strong>`;
            };
        }
        
        this.boardClickArea = document.getElementById("pb-board-area");
        this.gridEl = document.getElementById("pb-grid");
        this.pieceLayer = document.getElementById("pb-pieces");
        this.badgeLayer = document.getElementById("pb-badges");
        
        const dummyEval = document.createElement("div"); 
        createBoardGrid(this.gridEl, this.boardClickArea, dummyEval, this.reviewColor);
        this.updateBoardVisuals();
        
        if (this.config.actions && this.config.actions.length > 0) {
            const actionCont = document.getElementById("action-container");
            actionCont.innerHTML = "";
            this.config.actions.forEach(btnDef => {
                const btn = document.createElement("button");
                btn.className = btnDef.class || "action-btn";
                if(btnDef.id) btn.id = btnDef.id;
                btn.style.flex = "1";
                btn.innerText = btnDef.label;
                btn.onclick = () => btnDef.onClick(this.getElapsedTime());
                actionCont.appendChild(btn);
            });
        }
        
        window.activeBoard = this;
    }

    checkAndShowReadyModal() {
        // Global Check: Has the user started a session?
        if (sessionStorage.getItem("chessSessionReady") === "true") {
            this.startPuzzle();
            return;
        }

        // Appends safely to document.body, avoiding all CSS container constraints
        let modal = document.getElementById("globalReadyModal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "globalReadyModal";
            modal.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 100000; backdrop-filter: blur(2px);";
            
            modal.innerHTML = `
                <div style="background: var(--panel); border: 1px solid var(--line); padding: 30px 20px; border-radius: 12px; width: 90%; max-width: 340px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                    <h2 style="color: var(--purple); margin: 0 0 10px 0; font-size: 24px;">Are you ready?</h2>
                    <p style="color: var(--muted); margin-bottom: 25px; font-size: 14px; line-height: 1.5;">Take a deep breath.<br>Click below to start your session.</p>
                    <button id="btnGlobalReady" style="width: 100%; background: var(--purple); border: 1px solid var(--purple); font-size: 16px; padding: 12px; color: #fff; font-weight: bold; border-radius: 8px; cursor: pointer; transition: 0.2s;">I am ready</button>
                </div>
            `;
            document.body.appendChild(modal);
        }

        modal.style.display = "flex";
        
        document.getElementById("btnGlobalReady").onclick = () => {
            sessionStorage.setItem("chessSessionReady", "true"); // Locks modal out for the whole session
            modal.style.display = "none";
            this.startPuzzle();
        };
    }

    startPuzzle() {
        const oppColor = this.reviewColor === 'b' ? "White" : "Black";
        this.setComment(`${oppColor} blundered. Can you spot the correct move?`);
        
        this.playMove(this.solutionMoves[this.currentPly++], 'blunder');
        
        this.startTime = Date.now();
        this.startPerPuzzleTimer();
        this.boardClickArea.addEventListener('click', (e) => this.handleBoardClick(e));
    }

    setComment(text) { document.getElementById("pboard-comment").innerText = text; }
    stopTimer() { if (this.timerInterval) clearInterval(this.timerInterval); }

    drawZenArrow(uci) { drawArrow(uci, this.reviewColor); }

    updateBoardVisuals() {
        const activeSet = this.appSettings.activePieceSet || "Piece-set-1";
        let customPieceDB = this.pieceSetDB ? JSON.parse(JSON.stringify(this.pieceSetDB)) : {};

        for (let setName in customPieceDB) {
            if (customPieceDB[setName].src_path) customPieceDB[setName].src_path = "../" + customPieceDB[setName].src_path;
        }

        if (!customPieceDB[activeSet]) {
            customPieceDB[activeSet] = {
                src_path: "../pieces/",
                pieces: { "wp":"wp.png", "wn":"wn.png", "wb":"wb.png", "wr":"wr.png", "wq":"wq.png", "wk":"wk.png", "bp":"bp.png", "bn":"bn.png", "bb":"bb.png", "br":"br.png", "bq":"bq.png", "bk":"bk.png" }
            };
        }

        renderPieces(this.pieceLayer, this.chess.fen(), this.reviewColor, customPieceDB, activeSet);
    }

    handleBoardClick(e) {
        if (this.viewingPly !== this.movesPlayed.length) return; 

        const rect = this.boardClickArea.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;

        const fileIdx = Math.floor((x / rect.width) * 8);
        const rankIdx = Math.floor((y / rect.height) * 8);
        const file = this.reviewColor === 'w' ? String.fromCharCode(97 + fileIdx) : String.fromCharCode(104 - fileIdx);
        const rank = this.reviewColor === 'w' ? 8 - rankIdx : rankIdx + 1;
        const sq = file + rank;

        document.querySelectorAll(".legal-dot").forEach(d => d.style.display = "none");
        clearArrow(); 

        if (this.selectedSquare) {
            const moves = this.chess.moves({ square: this.selectedSquare, verbose: true });
            const matchingMoves = moves.filter(m => m.to === sq);
            
            if (matchingMoves.length > 0) {
                let match = matchingMoves[0];
                
                if (matchingMoves.length > 1) {
                    const expectedUci = this.solutionMoves[this.currentPly] || "";
                    const expectedPromo = expectedUci.length === 5 ? expectedUci[4] : 'q';
                    
                    if (match.from + match.to === expectedUci.substring(0,4)) {
                        match = matchingMoves.find(m => m.promotion === expectedPromo) || matchingMoves[0];
                    } else {
                        let promo = prompt("Promote to Queen(q), Rook(r), Bishop(b), or Knight(n)?", "q");
                        if (!['q', 'r', 'b', 'n'].includes(promo)) promo = 'q';
                        match = matchingMoves.find(m => m.promotion === promo) || matchingMoves[0];
                    }
                }
                
                this.validateUserMove(match);
                this.selectedSquare = null;
                return;
            }
        }

        const piece = this.chess.get(sq);
        if (piece && piece.color === this.chess.turn()) {
            this.selectedSquare = sq;
            clearHighlights(this.badgeLayer);
            const hl = document.getElementById(`hl-${sq}`);
            if (hl) {
                hl.style.display = "block";
                hl.style.backgroundColor = "rgba(168, 85, 247, 0.4)";
            }
            this.chess.moves({ square: sq, verbose: true }).forEach(m => {
                const dot = document.getElementById(`dot-${m.to}`);
                if (dot) dot.style.display = "block";
            });
        } else {
            this.selectedSquare = null;
        }
    }

    isSacrifice(moveObj) {
        if (moveObj.piece === 'p') return false; 
        
        const temp = new Chess(this.chess.fen());
        temp.move(moveObj);
        const enemyMoves = temp.moves({ verbose: true });
        const captureMove = enemyMoves.find(m => m.to === moveObj.to);
        if (!captureMove) return false; 
        temp.move(captureMove); 
        const ourRecaptures = temp.moves({ verbose: true }).filter(m => m.to === moveObj.to);
        return ourRecaptures.length === 0; 
    }

    validateUserMove(moveObj) {
        const attemptedUci = moveObj.from + moveObj.to + (moveObj.promotion || '');
        const expectedUci = this.solutionMoves[this.currentPly];
        
        if (attemptedUci === expectedUci || attemptedUci === expectedUci.substring(0,4)) { 
            const sac = this.isSacrifice(moveObj);
            const cls = sac ? 'brilliant' : 'best';
            
            this.playMove(expectedUci, cls);
            this.setComment(`${sac ? "Brilliant sacrifice!" : "Best move!"} Keep going.`);
            this.currentPly++;
            
            if (this.currentPly >= this.solutionMoves.length) {
                this.stopTimer();
                this.setComment(`Puzzle Complete!`);
                this.config.onComplete(this.getElapsedTime());
            } else {
                setTimeout(() => {
                    this.playMove(this.solutionMoves[this.currentPly++], 'best');
                }, 500);
            }
        } else {
            this.stopTimer();
            this.setComment("Incorrect. That is a Miss!");
            this.playMove(attemptedUci, 'miss');
            this.chess.undo(); 
            
            this.boardClickArea.style.pointerEvents = 'none';
            this.config.onFail(this.getElapsedTime());
        }
    }
    
    undoLastMove() {
        if (this.movesPlayed.length === 0) return;
        this.movesPlayed.pop();
        this.viewingPly = this.movesPlayed.length;
        
        const prevFen = this.viewingPly === 0 ? this.baseFen : this.movesPlayed[this.viewingPly - 1].fen;
        this.chess = new Chess(prevFen);
        
        this.updateBoardVisuals();
        clearHighlights(this.badgeLayer);
        clearArrow(); 
        
        if (this.viewingPly > 0) {
            const m = this.movesPlayed[this.viewingPly - 1];
            applyHighlights(this.badgeLayer, m.from, m.to, m.cls, this.reviewColor, this.getIconHTML);
        }
        
        this.renderSlider();
        this.boardClickArea.style.pointerEvents = 'auto'; 
        this.setComment("Mistake reverted. Try again.");
    }

    playMove(uciMove, clsName) {
        const from = uciMove.substring(0, 2);
        const to = uciMove.substring(2, 4);
        const promo = uciMove.length === 5 ? uciMove[4] : undefined;
        
        const sanStr = this.chess.move({ from, to, promotion: promo }).san;
        
        this.movesPlayed.push({ from, to, cls: clsName, san: sanStr, fen: this.chess.fen(), isSeparator: false });
        this.viewingPly = this.movesPlayed.length;
        
        this.updateBoardVisuals();
        clearHighlights(this.badgeLayer);
        clearArrow(); 
        applyHighlights(this.badgeLayer, from, to, clsName, this.reviewColor, this.getIconHTML);
        this.renderSlider();
    }

    playSolution() {
        this.viewingPly = -1; 
        this.movesPlayed.push({ isSeparator: true });
        this.chess = new Chess(this.baseFen);
        
        for(let i=0; i < this.currentPly; i++) {
            this.chess.move(this.solutionMoves[i], {sloppy: true});
        }
        
        const step = () => {
            if (this.currentPly < this.solutionMoves.length) {
                const mv = this.solutionMoves[this.currentPly++];
                const from = mv.substring(0, 2);
                const to = mv.substring(2, 4);
                
                const sanStr = this.chess.move(mv, {sloppy: true}).san;
                this.movesPlayed.push({ from, to, cls: 'best', san: sanStr, fen: this.chess.fen(), isSeparator: false });
                this.viewingPly = this.movesPlayed.length;

                this.updateBoardVisuals();
                clearHighlights(this.badgeLayer);
                clearArrow(); 
                applyHighlights(this.badgeLayer, from, to, 'best', this.reviewColor, this.getIconHTML);
                this.renderSlider();
                
                setTimeout(step, 800);
            }
        };
        step();
    }

    jumpToPly(index) {
        if (index > this.movesPlayed.length || this.movesPlayed[index - 1].isSeparator) return;
        
        this.viewingPly = index;
        const m = this.movesPlayed[index - 1];
        
        this.chess = new Chess(m.fen);
        this.updateBoardVisuals();
        clearHighlights(this.badgeLayer);
        clearArrow(); 
        applyHighlights(this.badgeLayer, m.from, m.to, m.cls, this.reviewColor, this.getIconHTML);
        this.renderSlider();
    }

    renderSlider() {
        const cont = document.getElementById("moveSliderContainer");
        let html = "";
        
        let visualBlocks = [];
        let currentPair = [];
        
        for (let i = 0; i < this.movesPlayed.length; i++) {
            const m = this.movesPlayed[i];
            if (m.isSeparator) {
                if (currentPair.length > 0) {
                    visualBlocks.push(currentPair);
                    currentPair = [];
                }
                visualBlocks.push([{ isSeparator: true }]);
            } else {
                currentPair.push({ data: m, rawIndex: i + 1 });
                if (currentPair.length === 2) {
                    visualBlocks.push(currentPair);
                    currentPair = [];
                }
            }
        }
        if (currentPair.length > 0) visualBlocks.push(currentPair);

        let moveNum = 1;
        visualBlocks.forEach(block => {
            if (block.length === 1 && block[0].isSeparator) {
                html += `<div style="color:var(--purple); font-weight:900; margin: 0 4px;">|</div>`;
            } else {
                let pairHtml = `<div class="move-pair"><div class="move-num">${moveNum}.</div>`;
                block.forEach(m => {
                    pairHtml += `<div class="move-ply ${this.viewingPly === m.rawIndex ? 'active' : ''}" onclick="window.activeBoard.jumpToPly(${m.rawIndex})">${m.data.san} <div class="mc-icon">${this.getIconHTML(m.data.cls)}</div></div>`;
                });
                pairHtml += `</div>`;
                html += pairHtml;
                moveNum++;
            }
        });
        
        cont.innerHTML = html;
        cont.scrollLeft = cont.scrollWidth;
    }

getIconHTML(cls) {
        if (cls === 'best') return `<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="#84cc16"/><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="#fff"/></svg>`;
        if (cls === 'brilliant') return `<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="#1cb0a6"/><path d="M7 6h2l-1 8H6zM15 6h2l-1 8h-2zM7 16h2v2H7zM15 16h2v2h-2z" fill="#fff"/></svg>`;
        if (cls === 'miss') return `<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="#ec4899"/><path d="M5 11h14v2H5z" fill="#fff"/></svg>`;
        if (cls === 'blunder') return `<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="12" fill="#ef4444"/><path d="M8 6a2 2 0 0 0-2 2h2a0 0 0 0 1 0 0c0 2-2 2-2 4h2c0-1 2-1 2-4a2 2 0 0 0-2-2zm-1 9h2v2H7v-2zm9-9a2 2 0 0 0-2 2h2a0 0 0 0 1 0 0c0 2-2 2-2 4h2c0-1 2-1 2-4a2 2 0 0 0-2-2zm-1 9h2v2h-2v-2z" fill="#fff"/></svg>`;
        return "";
    }

    startPerPuzzleTimer() {
        const timerEl = document.querySelector(".timer-tick");
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            timerEl.innerText = `${m}:${s}`;
        }, 1000);
    }

    getElapsedTime() { return Date.now() - this.startTime; }
}