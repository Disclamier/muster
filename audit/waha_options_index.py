"""Index Wahapedia wargear-option lines per Muster faction/unit (faction-aware) -> audit/out/waha_options.json"""
import csv,json,re,sys,html,os
csv.field_size_limit(10**9)
W=sys.argv[1] if len(sys.argv)>1 else "/tmp/waha"
rd=lambda f:list(csv.DictReader(open(os.path.join(W,f),encoding="utf-8-sig"),delimiter="|"))
N=lambda s:re.sub(r"[^a-z0-9]","",re.sub(r"\s*\[legends\]","",str(s).lower().replace("‑","-")))
FM={"imperial-agents":"AoI","astra-militarum":"AM","genestealer-cults":"GC","necrons":"NEC","aeldari":"AE","titan-legions":"TL","chaos-titan-legions":"TL","orks":"ORK","grey-knights":"GK","tau-empire":"TAU","leagues-of-votann":"LoV","adeptus-mechanicus":"AdM","thousand-sons":"TS","death-guard":"DG","emperors-children":"EC","world-eaters":"WE","chaos-knights":"QT","chaos-daemons":"CD","imperial-knights":"QI","space-marines":"SM","tyranids":"TYR","adeptus-custodes":"AC","adepta-sororitas":"AS","chaos-space-marines":"CSM","drukhari":"DRU"}
for c in ["black-templars","blood-angels","dark-angels","deathwatch","space-wolves"]:FM[c]="SM"
DS=rd("Datasheets.csv");OP=rd("Datasheets_options.csv")
ops={}
for o in OP: ops.setdefault(o["datasheet_id"],[]).append(re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]+>"," ▫ ",o["description"]))).strip(" ▫"))
by={};anyn={}
for d in DS:
  if d.get("virtual")=="true":continue
  by.setdefault((d["faction_id"],N(d["name"])),d); anyn.setdefault(N(d["name"]),[]).append(d)
P=json.load(open(sys.argv[2] if len(sys.argv)>2 else "../app/data/points.json"))
out={}
for f in P["factions"]:
  for u in f["units"]:
    k=N(u["n"]); d=by.get((FM.get(f["id"]),k)) or (anyn[k][0] if len(anyn.get(k,[]))==1 else None)
    if d and ops.get(d["id"]): out.setdefault(f["id"],{})[u["n"]]={"id":d["id"],"wo":ops[d["id"]],"loadout":re.sub(r"<[^>]+>","",html.unescape(d["loadout"]))}
os.makedirs("out",exist_ok=True);json.dump(out,open("out/waha_options.json","w"),ensure_ascii=False,indent=0)
print(sum(len(v) for v in out.values()),"units with Wahapedia options")
