export async function initComments(){return new Promise(r=>setTimeout(()=>r(!0),200));}
export function generateComment(n,p,s,c){return`Move ${n}. ${p} played ${s}, classified as a ${c} move.`;}
