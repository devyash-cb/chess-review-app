const THEMES = [
    "arabianMate", "pin", "zugzwang", "knightEndgame", "rookEndgame", "endgame", "exposedKing", 
    "discoveredAttack", "bodenMate", "intermezzo", "opening", "interference", "xRayAttack", 
    "hookMate", "smotheredMate", "sacrifice", "clearance", "castling", "quietMove", "mateIn2", 
    "middlegame", "skewer", "queenEndgame", "deflection", "doubleCheck", "defensiveMove", 
    "hangingPiece", "enPassant", "trappedPiece", "bishopEndgame", "mateIn1", "anastasiaMate", 
    "mateIn4", "mateIn3", "underPromotion", "fork", "attraction", "pawnEndgame", "mateIn5"
];
const offsetCache = {};
let metaCache = null;

async function getMeta() {
    if (metaCache) return metaCache;
    try {
        const r = await fetch('../puzzlesbin/puzzle_meta.json');
        metaCache = await r.json();
    } catch(e) { metaCache = {}; }
    return metaCache;
}

async function fetchThemeOffsets(themeName, tierStr) {
    const key = `${themeName}_${tierStr}`;
    if (offsetCache[key]) return offsetCache[key];
    
    // Dynamically routes to the new folder structure
    let url = `../puzzlesbin/${themeName}/${tierStr}.bin`;
    if (themeName === "reserve") url = `../puzzlesbin/reserve/1200.bin`;
    if (themeName === "unclassified") url = `../puzzlesbin/unclassified/${tierStr}.bin`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const buffer = await res.arrayBuffer();
    const dataView = new DataView(buffer);
    const totalPuzzles = dataView.getUint32(0, true);
    const offsets = new Uint32Array(totalPuzzles);
    
    let cursor = 4;
    const isReserve = (themeName === "reserve");
    
    // The reserve file has 1 extra byte (Theme ID) prepended before the standard payload
    for (let i = 0; i < totalPuzzles; i++) {
        offsets[i] = cursor;
        cursor += isReserve ? 3 : 2; 
        const fenLen = dataView.getUint8(cursor++); cursor += fenLen;
        const moveLen = dataView.getUint8(cursor++); cursor += moveLen;
    }
    offsetCache[key] = { buffer, offsets, totalPuzzles };
    return offsetCache[key];
}

async function extractPuzzleData(themeName, tierStr, index) {
    const { buffer, offsets } = await fetchThemeOffsets(themeName, tierStr);
    const startByte = offsets[index];
    const dataView = new DataView(buffer);
    let cursor = startByte;
    
    let tId = THEMES.indexOf(themeName);
    if (themeName === "reserve") {
        tId = dataView.getUint8(cursor++);
    }
    
    const rating = dataView.getUint16(cursor, true); cursor += 2;
    const fenLen = dataView.getUint8(cursor++);
    const fen = new TextDecoder().decode(new Uint8Array(buffer, cursor, fenLen)); cursor += fenLen;
    const moveLen = dataView.getUint8(cursor++);
    const moves = new TextDecoder().decode(new Uint8Array(buffer, cursor, moveLen));
    
    return { r: rating, f: fen, m: moves, t: tId, i: index, tier: parseInt(tierStr)||1 };
}

// targetTier: 0 (Any Tier), 1 (Tier 1), 2 (Tier 2), 3 (Tier 3)
async function fillPuzzleQueue(modeId, themesAllowed, minRating, maxRating, targetTier = 0) {
    const qKey = `m${modeId}Queue`; 
    let currentQueue = await getDB(qKey) || [];
    let playedSet = await getDB("playedPuzzlesSet") || {}; 
    const meta = await getMeta();
    
    const allowed = (!themesAllowed || themesAllowed.length === 0) 
        ? THEMES.map((_, i) => i) 
        : themesAllowed;
        
    const canUseUnclassified = (!themesAllowed || themesAllowed.length === 0);

    while (currentQueue.length < 3) {
        let candidate = null;
        let attempts = 0;
        
        while (!candidate && attempts < 100) {
            attempts++;
            
            // 1200 Reserve Injection Logic
            if (minRating < 1300) {
                try {
                    const rInfo = await fetchThemeOffsets("reserve", "1200");
                    if (rInfo.totalPuzzles > 0) {
                        const rIdx = Math.floor(Math.random() * rInfo.totalPuzzles);
                        const pKey = `res_${rIdx}`;
                        
                        if (!playedSet[pKey] || attempts > 20) {
                            const pData = await extractPuzzleData("reserve", "1200", rIdx);
                            if (pData.r >= minRating && pData.r <= maxRating) {
                                candidate = pData;
                                playedSet[pKey] = true;
                            }
                        }
                    }
                } catch(e) {}
            } else {
                // Standard Meta-Bracket Fetching
                let tName = THEMES[allowed[Math.floor(Math.random() * allowed.length)]];
                if (canUseUnclassified && Math.random() < 0.1) tName = "unclassified";
                
                // If targetTier is 0, randomly pick an available tier (1, 2, or 3)
                const tier = targetTier === 0 ? Math.floor(Math.random()*3)+1 : targetTier;
                const tMeta = meta[tName]?.[`t${tier}`];
                
                if (tMeta && tMeta.total > 0) {
                    let validBrackets = [];
                    let sB = Math.floor(minRating/100)*100;
                    let eB = Math.floor(maxRating/100)*100;
                    
                    for(let b=sB; b<=eB; b+=100) {
                        if (tMeta.brackets[b]) validBrackets.push(tMeta.brackets[b]);
                    }
                    
                    if (validBrackets.length > 0) {
                        const bracket = validBrackets[Math.floor(Math.random()*validBrackets.length)];
                        const rIdx = Math.floor(Math.random() * (bracket[1] - bracket[0] + 1)) + bracket[0];
                        const pKey = `${tName}_t${tier}_${rIdx}`;
                        
                        if (!playedSet[pKey] || attempts > 20) {
                            try {
                                const pData = await extractPuzzleData(tName, tier, rIdx);
                                if (pData.r >= minRating && pData.r <= maxRating) {
                                    candidate = pData;
                                    playedSet[pKey] = true;
                                }
                            } catch(e) {}
                        }
                    }
                }
            }
        }
        if (candidate) currentQueue.push(candidate);
        else break; 
    }
    
    currentQueue.sort((a, b) => a.r - b.r);
    await setDB("playedPuzzlesSet", playedSet);
    await setDB(qKey, currentQueue);
    return currentQueue;
}

async function getNextPuzzle(modeId, themesAllowed, minRating, maxRating, targetTier = 0) {
    let queue = await fillPuzzleQueue(modeId, themesAllowed, minRating, maxRating, targetTier);
    const activePuzzle = queue.shift(); 
    await setDB(`m${modeId}Queue`, queue); 
    fillPuzzleQueue(modeId, themesAllowed, minRating, maxRating, targetTier); 
    return activePuzzle;
}
