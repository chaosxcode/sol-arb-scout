// Prove the colocation win: warm RTT from THIS box to each Jito region.
// From a Frankfurt server the frankfurt engine should be ~1-8ms (vs ~48ms warm from home).
const REGIONS = ['frankfurt','amsterdam','ny','slc','london'];
const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTipAccounts', params:[] });
async function hit(u:string){ const t=performance.now(); await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body}).then(r=>r.arrayBuffer()).catch(()=>null); return performance.now()-t; }
for (const r of REGIONS){ const u=`https://${r}.mainnet.block-engine.jito.wtf/api/v1/bundles`; await hit(u); /*warm*/ const ms=[await hit(u),await hit(u),await hit(u)]; console.log(`  ${r.padEnd(10)} ${Math.min(...ms).toFixed(0)}ms (warm)`); }
console.log('\nIf frankfurt is <10ms here, bundles reach Jito before the edge evaporates —');
console.log('the thing that made every trade "Invalid" from home.');
