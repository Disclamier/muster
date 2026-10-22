"""Headless Chrome (DevTools protocol) screenshot helper for Muster: dark mode, phone 390x844."""
import json, subprocess, time, urllib.request, websocket, itertools, os, tempfile
PORT = 9361
class B:
    def __init__(self, w=390, h=844, base='http://127.0.0.1:18768/'):
        self.base = base; self.ud = tempfile.mkdtemp(prefix='cdp-')
        self.p = subprocess.Popen(['google-chrome', '--headless=new', f'--remote-debugging-port={PORT}', '--no-first-run', '--remote-allow-origins=*', '--no-sandbox',
            '--disable-gpu', f'--user-data-dir={self.ud}', f'--window-size={w},{h}', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json')); break
            except Exception: time.sleep(0.1)
        t = [x for x in tabs if x.get('type') == 'page'][0]
        self.ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=60); self.n = itertools.count(1)
        self.cmd('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=2, mobile=True)
        self.cmd('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': 'dark'}])
        self.cmd('Emulation.setTouchEmulationEnabled', enabled=True)
        self.cmd('Page.enable'); self.cmd('Runtime.enable')
        self.cmd('Page.addScriptToEvaluateOnNewDocument', source="try{localStorage.setItem('muster.stats.bot','1')}catch(e){}")  # not counted in Muster stats
    def cmd(self, method, **params):
        i = next(self.n); self.ws.send(json.dumps({'id': i, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError(m['error'])
                return m.get('result')
    def ev(self, js):
        r = self.cmd('Runtime.evaluate', expression=js, awaitPromise=True, returnByValue=True)
        if r.get('exceptionDetails'): raise RuntimeError(r['exceptionDetails'])
        return r['result'].get('value')
    def wait(self, js, t=20):
        t0 = time.time()
        while time.time() - t0 < t:
            if self.ev(js): return True
            time.sleep(0.2)
        raise TimeoutError(js)
    def setup(self, lists, hash):
        """open the app, push lists into the in-memory state and route to hash"""
        self.cmd('Page.navigate', url=self.base); self.wait('!!(window.Muster && window.Muster.S && window.Muster.S.data)')
        self.wait('!!window.Muster.S.ds')
        self.ev(f'(()=>{{const L={json.dumps(lists)}; for (const l of L) window.Muster.S.lists.push(l); location.hash={json.dumps(hash)}; return 1}})()')
        time.sleep(1.0)
    def shot(self, out):
        time.sleep(0.4); import base64
        open(out, 'wb').write(base64.b64decode(self.cmd('Page.captureScreenshot', format='png')['data']))
    def close(self):
        try: self.ws.close()
        except Exception: pass
        self.p.terminate(); self.p.wait()
