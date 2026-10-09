"""Fetch the Warhammer 40,000 app detachment pages from 40k.app (see gwapp_compile.py)."""
import subprocess, time, json, urllib.request, sys, websocket, shutil, os
# usage: python3 scraper/fetch_gwapp.py OUTDIR [slug,slug,...]   (needs google-chrome + websocket-client)
# Saves every detachment page of the given 40k.app factions as text (OUTDIR/<faction>__<detachment>.txt) for
# gwapp_compile.py. A real browser is needed: the site sits behind a bot check that blocks plain HTTP clients.
DEFAULT = ["adepta-sororitas", "adeptus-custodes", "adeptus-mechanicus", "astra-militarum", "imperial-agents", "imperial-knights",
           "titan-legions", "black-templars", "blood-angels", "dark-angels", "deathwatch", "grey-knights", "imperial-fists", "iron-hands",
           "raven-guard", "salamanders", "space-marines", "space-wolves", "ultramarines", "white-scars", "chaos-daemons", "chaos-knights",
           "chaos-space-marines", "chaos-titan-legions", "death-guard", "emperors-children", "thousand-sons", "world-eaters", "aeldari",
           "drukhari", "genestealer-cults", "leagues-of-votann", "necrons", "orks", "tyranids", "tau-empire", "ynnari", "harlequins",
           "legions-of-excess", "plague-legions", "scintillating-legions", "blood-legions"]
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
ids = sys.argv[2].split(",") if len(sys.argv) > 2 else DEFAULT
PROFILE = os.path.join(OUT, '.chrome'); shutil.rmtree(PROFILE, ignore_errors=True)
p = subprocess.Popen(['google-chrome','--headless=new','--disable-gpu','--remote-debugging-port=9338','--remote-allow-origins=*','--user-data-dir='+PROFILE,'--window-size=1300,900','--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36','about:blank'], stderr=subprocess.DEVNULL)
for _ in range(50):
    try: tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9338/json')); break
    except Exception: time.sleep(.2)
ws = websocket.create_connection([t for t in tabs if t['type']=='page'][0]['webSocketDebuggerUrl'], timeout=40)
i=0
def cmd(m, **pr):
    global i; i+=1; ws.send(json.dumps({'id':i,'method':m,'params':pr}))
    while True:
        r=json.loads(ws.recv())
        if r.get('id')==i: return r.get('result')
def get(u, js="document.body ? document.body.innerText : ''"):
    cmd('Page.navigate', url=u)
    for _ in range(25):
        time.sleep(1.2)
        t=cmd('Runtime.evaluate', expression="document.body ? document.body.innerText : ''", returnByValue=True)['result'].get('value','')
        if 'verifying' not in t.lower() and len(t)>400 and ('CREATE LIST' in t or '404' in t): break
    return t, cmd('Runtime.evaluate', expression=js, returnByValue=True)['result'].get('value')
res={}
import sys
for fid in ids:
    if os.path.exists(f'{OUT}/index.json'):
        old=json.load(open(f'{OUT}/index.json'))
        if fid in old and all(os.path.exists(f"{OUT}/{fid}__{u.rsplit('/',1)[1]}.txt") for u in old[fid]['links']): res[fid]=old[fid]; continue
    t,links=get(f'https://www.40k.app/factions/{fid}/detachments', "[...new Set([...document.querySelectorAll('a')].map(a=>a.href).filter(h=>/\\/detachments\\/[^/]+$/.test(h)))]")
    res[fid]={'links':links or [], 'pages':{}}
    print(fid, len(links or []), flush=True)
    for u in links or []:
        k=u.rsplit('/',1)[1]; f=f'{OUT}/{fid}__{k}.txt'
        if os.path.exists(f): continue
        try:
            tt,_=get(u); open(f,'w').write(u+'\n'+tt)
        except Exception as e: print('ERR',u,e,flush=True)
    json.dump(res,open(f'{OUT}/index.json','w'),indent=1)
p.kill()
shutil.rmtree(PROFILE, ignore_errors=True)
