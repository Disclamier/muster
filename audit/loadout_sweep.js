// Every unit whose datasheet lists wargear options (wo) must have a loadout (lo) whose option names cover the items those lines offer.
const P=require(process.argv[2]||"../app/data/points.json"),D=require(process.argv[3]||"../app/data/datasheets.json");
const N=s=>String(s).toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]/g,"").replace(/s$/,"");
function offered(t){ // items a line offers
  t=t.replace(/‑/g,"-");
  let m=t.match(/(?:replaced with|equipped with|be equipped with)\s*(?:one of the following:?)?(.*)$/i); if(!m) return [];
  return m[1].split(/▫|;|•|\bor\b/).map(x=>x.trim().replace(/^\d+\s+/,"").replace(/[.*]+$/,"").trim()).filter(x=>x&&!/model|following|cannot|\(/i.test(x))
    .flatMap(x=>x.split(/,\s*(?=\d)|\s+and\s+(?=\d)/).map(y=>y.replace(/^\d+\s+/,"").trim())).filter(x=>x.length>2&&!/additional/i.test(x));
}
function have(lo){const s=new Set();for(const m of (lo&&lo.m)||[]){m[3].forEach(x=>s.add(N(x)));for(const sl of m[4])for(const o of sl[1])String(o[0]).split(/\s*\+\s*/).forEach(x=>s.add(N(x)))}
  for(const sl of (lo&&lo.u)||[])for(const o of sl[1])String(o[0]).split(/\s*\+\s*/).forEach(x=>s.add(N(x)));return s}
const known=(k,h)=>h.has(k)||[...h].some(x=>x.length>5&&(x.includes(k)||k.includes(x)));
const fails=[];
for(const f of P.factions)for(const u of f.units){const d=((D.factions[f.id]||{}).units||{})[u.n];if(!d||!(d.wo||[]).length)continue;
  const h=have(u.lo);const miss=[];for(const t of d.wo)for(const it of offered(t))if(!known(N(it),h))miss.push(it);
  if(!u.lo||!u.lo.m||!u.lo.m.length||miss.length)fails.push({f:f.id,u:u.n,nolo:!u.lo,miss:[...new Set(miss)]});}
module.exports={fails,offered};
if(require.main===module){const by={};fails.forEach(x=>by[x.f]=(by[x.f]||0)+1);console.log(fails.length,JSON.stringify(by));if(process.argv[4]=="-v")fails.forEach(x=>console.log(x.f,"|",x.u,x.nolo?"NOLO":"",x.miss.join(" / ")))}
