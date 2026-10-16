const DB_VERSION = 3;
let dbInstance = null;

async function openDB() {
    if (dbInstance) return dbInstance;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("ChessReviewDB", DB_VERSION);
        req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
        req.onerror = () => reject(req.error);
    });
}

async function getDB(key) {
    const db = await openDB();
    return new Promise(res => {
        const tx = db.transaction("puzzles", "readonly");
        const req = tx.objectStore("puzzles").get(key);
        req.onsuccess = () => res(req.result ? req.result.val : null);
        req.onerror = () => res(null);
    });
}

async function setDB(key, val) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("puzzles", "readwrite");
        tx.objectStore("puzzles").put({ key, val });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Added 'tier' parameter to uniquely identify puzzles across the 3 files
async function logPuzzleResult(modeId, status, themeId, tier, puzzleIdx, timeMs) {
    const ts = Math.floor(Date.now() / 1000); 
    const histEntry = { m: modeId, p: (status << 1) | (status === 2 ? 1 : 0), t: themeId, tr: tier, i: puzzleIdx, ts: ts, d: timeMs }; 
    
    let history = await getDB("puzzleHistory") || [];
    history.unshift(histEntry); 
    await setDB("puzzleHistory", history);

    const statKeys = ["totalWon", "totalWrong", "totalSkipped"];
    let currentStat = await getDB(statKeys[status]) || 0;
    await setDB(statKeys[status], currentStat + 1);
    
    let totalPlayed = await getDB("totalPlayed") || 0;
    await setDB("totalPlayed", totalPlayed + 1);

    // FIXED: Added tier to specific key to prevent overwriting index collisions
    const specificKey = `${themeId}_${tier}_${puzzleIdx}`;
    
    if (status === 1) { 
        let mistakes = await getDB("mistakeArchive") || {};
        mistakes[specificKey] = { t: themeId, tr: tier, i: puzzleIdx, ts: ts };
        await setDB("mistakeArchive", mistakes);
    } else if (status === 2) { 
        let skips = await getDB("skippedArchive") || {};
        skips[specificKey] = { t: themeId, tr: tier, i: puzzleIdx, ts: ts };
        await setDB("skippedArchive", skips);
    } else if (status === 0) { 
        let mistakes = await getDB("mistakeArchive") || {};
        let skips = await getDB("skippedArchive") || {};
        if (mistakes[specificKey]) { delete mistakes[specificKey]; await setDB("mistakeArchive", mistakes); }
        if (skips[specificKey]) { delete skips[specificKey]; await setDB("skippedArchive", skips); }
    }
}
