// every loadout item (fixed + option parts) must resolve to a weapon profile / wargear card / ability on the unit's datasheet
const P=require(process.argv[2]),D=require(process.argv[3]);
const N=s=>String(s).toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]/g,"").replace(/s$/,"");
const known=(k,h)=>h.has(k)||[...h].some(x=>x.length>5&&(x.includes(k)||k.includes(x)));
const out=[];
for(const f of P.factions)for(const u of f.units){const d=((D.factions[f.id]||{}).units||{})[u.n];if(!d||!u.lo)continue;
 const h=new Set([...(d.wp||[]).map(x=>N(x[0].split(/\s+[–-]\s+/)[0])),...(d.wp||[]).map(x=>N(x[0])),...(d.wa||[]).map(x=>N(x[1])),...(d.ab||[]).map(x=>N(x[0]))]);
 const items=[];for(const m of u.lo.m||[]){items.push(...m[3]);for(const s of m[4])for(const o of s[1])items.push(...String(o[0]).split(/\s*\+\s*/))}for(const s of u.lo.u||[])for(const o of s[1])items.push(...String(o[0]).split(/\s*\+\s*/));
 const bad=[...new Set(items.filter(i=>!known(N(i),h)))];if(bad.length)out.push([f.id,u.n,bad]);}
module.exports=out;if(require.main===module){console.log(out.length);for(const o of out)if(process.argv[4]=="-v"||/custodes|titan|daemons/.test(o[0]))console.log(o[0],"|",o[1],"|",o[2].join(" / "))}
