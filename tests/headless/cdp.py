import subprocess, time, json, urllib.request, base64, sys, websocket, shutil
PORT=9351
class B:
    def __init__(s, w=390, h=844, base='http://127.0.0.1:18768/'):
        shutil.rmtree('/tmp/chp_sw', ignore_errors=True)
        s.p=subprocess.Popen(['google-chrome','--headless=new','--disable-gpu','--hide-scrollbars',f'--remote-debugging-port={PORT}','--remote-allow-origins=*','--user-data-dir=/tmp/chp_sw',f'--window-size={w},{h}','about:blank'],stderr=subprocess.DEVNULL)
        for _ in range(80):
            try: tabs=json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json')); break
            except Exception: time.sleep(.25)
        s.ws=websocket.create_connection([t for t in tabs if t['type']=='page'][0]['webSocketDebuggerUrl'],timeout=600)
        s.i=0; s.errors=[]; s.base=base
        mob=w<800
        s.cmd('Emulation.setDeviceMetricsOverride',width=w,height=h,deviceScaleFactor=2 if mob else 1,mobile=mob)
        if mob: s.cmd('Emulation.setTouchEmulationEnabled',enabled=True,maxTouchPoints=5)
        s.cmd('Emulation.setEmulatedMedia',features=[{'name':'prefers-color-scheme','value':'dark'}])
        s.cmd('Runtime.enable'); s.cmd('Log.enable')
        # our automated visits are never counted in Muster's traffic stats (app/js/stats.js reads this flag)
        s.cmd('Page.enable'); s.cmd('Page.addScriptToEvaluateOnNewDocument',source="try{localStorage.setItem('muster.stats.bot','1')}catch(e){}")
    def cmd(s,m,**pr):
        s.i+=1; s.ws.send(json.dumps({'id':s.i,'method':m,'params':pr}))
        while True:
            r=json.loads(s.ws.recv())
            if r.get('id')==s.i: return r.get('result')
            if r.get('method')=='Runtime.exceptionThrown': s.errors.append(r['params']['exceptionDetails'].get('exception',{}).get('description') or r['params']['exceptionDetails'].get('text'))
            if r.get('method')=='Runtime.consoleAPICalled' and r['params']['type']=='error': s.errors.append(' '.join(str(a.get('value',a.get('description',''))) for a in r['params']['args']))
    def ev(s,js): r=s.cmd('Runtime.evaluate',expression=js,awaitPromise=True,returnByValue=True); return r.get('result',{}).get('value', r)
    def setup(s,lists,hsh):
        s.cmd('Page.navigate',url=s.base); time.sleep(2)
        s.ev(f"localStorage.setItem('muster.theme','dark');localStorage.setItem('muster.guest','1');localStorage.setItem('muster.lists',{json.dumps(json.dumps(lists))});")
        s.cmd('Page.navigate',url='about:blank'); time.sleep(.3)
        s.cmd('Page.navigate',url=s.base+hsh); time.sleep(4)
    def shot(s,out): open(out,'wb').write(base64.b64decode(s.cmd('Page.captureScreenshot',format='png')['data']))
    def close(s): s.p.kill()
