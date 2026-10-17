import sys, json, time; sys.path.insert(0,__import__('os').path.dirname(__import__('os').path.abspath(__file__))); from cdp import B
base=sys.argv[1]; out=sys.argv[2]
P=json.load(open(''+__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)),'../../app/data/points.json')+''))
b=B(390,844,base)
b.setup([], '#/lists')
subs=b.ev('JSON.stringify(Object.entries(Muster.S.idx.subs).map(([k,v])=>[k,v.faction||v.f||v.parent||null]))')
subs=json.loads(subs) if isinstance(subs,str) else []
print('subs',len(subs),subs[:3])
lists=[]
for f in P['factions']:
    ents=[{"uid":f"u{i}","unit":u["n"],"models":(u["t"][0][2][0][0] if u["t"] and u["t"][0][2] and u["t"][0][2][0][0] else 1),"wargear":{},"addons":[],"enh":None} for i,u in enumerate(f["units"])]
    lists.append({"id":"f-"+f["id"],"name":f["id"],"faction":f["id"],"sub":f["id"],"size":"onslaught","dets":[],"showLegends":True,"showLocked":True,"app":"muster","schema":1,"updated":"2026-10-16T00:00:00Z","entries":ents})
for sid,fid in subs:
    if fid and sid!=fid: lists.append({"id":"s-"+sid,"name":sid,"faction":fid,"sub":sid,"size":"onslaught","dets":[],"showLegends":True,"showLocked":True,"app":"muster","schema":1,"updated":"2026-10-16T00:00:00Z","entries":[]})
b.setup(lists,'#/lists')
SWEEP=r'''(async()=>{const errs=[];const on=(m)=>errs.push(m);window.__on=on;
window.onerror=(m,s,l,c,e)=>{on(String(e&&e.stack||m));};window.onunhandledrejection=(e)=>on(String(e.reason&&e.reason.stack||e.reason));
const ce=console.error;console.error=(...a)=>{on(a.map(String).join(" "));ce.apply(console,a)};
const res=[];const pane=()=>document.querySelector(".panel")||document.querySelector(".editor");
const eyes=[...document.querySelectorAll("[data-action=preview-unit]")].map(e=>e.dataset.unit);
for(const n of [...new Set(eyes)]){errs.length=0;const e=[...document.querySelectorAll("[data-action=preview-unit]")].find(x=>x.dataset.unit===n);
 if(!e){res.push([n,"cat","eye vanished"]);continue}
 try{e.click()}catch(x){on(String(x.stack))}
 const p=document.querySelector(".panel");const ok=p&&p.querySelector("[data-testid=ds-stats]");const miss=p&&p.querySelector("[data-testid=ds-missing]");
 if(!ok||errs.length) res.push([n,"cat",errs.length?errs[0].slice(0,200):miss?"ds-missing":"no datasheet rendered"]);}
const uids=[...document.querySelectorAll("[data-action=ds-pop][data-uid]")].map(e=>e.dataset.uid);
for(const u of uids){errs.length=0;const e=document.querySelector(`[data-action=ds-pop][data-uid="${u}"]`);if(!e){res.push([u,"roster","eye vanished"]);continue}
 const nm=(e.closest("[data-uid]")||e).innerText.split("\n").find(x=>x.trim()&&!/^\d+$/.test(x.trim()))||u;
 try{e.click()}catch(x){on(String(x.stack))}
 const m=[...document.querySelectorAll("#modal .modal")].pop();const ok=m&&m.querySelector("[data-testid=ds-stats]");
 if(!ok||errs.length) res.push([nm.trim(),"roster",errs.length?errs[0].slice(0,200):(m&&m.querySelector("[data-testid=ds-missing]"))?"ds-missing":"no datasheet rendered"]);
 const x=document.querySelector("#modal [data-action=close-modal]");x&&x.click();}
// unit-row click (opens unit panel incl. profiles)
for(const u of uids){errs.length=0;const r=document.querySelector(`.roster [data-action=select-entry][data-uid="${u}"]`);if(!r)continue;try{r.click()}catch(x){on(String(x.stack))}
 const p=document.querySelector(".panel");if(!(p&&p.querySelector("[data-testid=ds-stats]"))||errs.length)res.push([u,"unitclick",errs.length?errs[0].slice(0,200):"no datasheet in panel"]);}
return JSON.stringify({eyes:new Set(eyes).size,roster:uids.length,res});})()'''
allres={}
for l in lists:
    b.cmd('Page.navigate',url=base+'#/list/'+l['id']); time.sleep(1.5)
    r=b.ev(SWEEP)
    try: r=json.loads(r)
    except Exception: print(l['id'],'EVAL FAIL',str(r)[:300]); allres[l['id']]={'fail':str(r)[:300]}; continue
    allres[l['id']]=r
    print(l['id'],r['eyes'],r['roster'],len(r['res']),flush=True)
json.dump(allres,open(out,'w'),indent=1,ensure_ascii=False); b.close()
