/**
 * parser.js
 * Validates PGN strictly for real chess moves and saves to storage.
 */

function stripPGNNoise(text) {
  let out = "";
  let braceDepth = 0, variationDepth = 0, lineComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (braceDepth > 0) { if (ch === "{") braceDepth++; else if (ch === "}") braceDepth--; continue; }
    if (ch === ";") { lineComment = true; continue; }
    if (ch === "{") { braceDepth = 1; continue; }
    if (ch === "(") { variationDepth++; continue; }
    if (ch === ")") { variationDepth = Math.max(0, variationDepth - 1); continue; }
    if (variationDepth > 0) continue;
    out += ch;
  }
  return out.replace(/\$\d+/g, " ");
}

export function parseAndSavePGN(pgnString) {
  const source = String(pgnString || "").replace(/\r/g, "");
  const tags = {};
  const tagRe = /^\s*\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/gm;
  let match;
  
  while ((match = tagRe.exec(source))) {
    tags[match[1]] = match[2];
  }

  const cleanBody = stripPGNNoise(source.replace(tagRe, " "));
  const tokens = cleanBody
    .trim()
    .split(/\s+/)
    .flatMap(token => token.replace(/(\d+)\.(\.\.)?/g, " ").split(/\s+/).filter(Boolean))
    .filter(Boolean)
    .filter(token => !/^\d+\.(?:\.\.)?$/.test(token))
    .filter(token => !/^\d+\.\.\.$/.test(token))
    .filter(token => !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token));

  // Verify at least one valid chess move exists (e.g., e4, Nf3, O-O, cxd4)
  const validMoveRegex = /^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[\+#]?|O-O(-O)?)$/;
  const hasRealMoves = tokens.some(t => validMoveRegex.test(t));
  
  if (!hasRealMoves || tokens.length === 0) {
    throw new Error("Invalid PGN: No recognizable chess moves found.");
  }

  const gameId = `game_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const newGame = {
    id: gameId,
    pgn: pgnString,
    white: tags.White || "White",
    black: tags.Black || "Black",
    playedAt: tags.Date ? tags.Date.replace(/\./g, "-") : new Date().toISOString(),
    result: tags.Result || source.match(/(?:1-0|0-1|1\/2-1\/2|\*)\s*$/m)?.[1] || "*",
    moveCount: tokens.length,
    status: "pending", 
    opening: "Unidentified", // Left as a placeholder for your custom implementation
    timestamp: Date.now()
  };

  const existingGames = JSON.parse(localStorage.getItem("chessReviewGames") || "[]");
  existingGames.unshift(newGame);
  localStorage.setItem("chessReviewGames", JSON.stringify(existingGames));
  localStorage.setItem("needsIndexRefresh", "1");
  window.location.href = `wait.html?gameId=${encodeURIComponent(gameId)}`;
}