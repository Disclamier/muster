"""Minimal React Server Components (Flight) payload parser for Next.js app-router pages."""
import json, re

def parse_rows(text):
    rows = {}
    i, n = 0, len(text)
    while i < n:
        m = re.compile(r'([0-9a-f]+):').match(text, i)
        if not m:
            nl = text.find('\n', i)
            if nl == -1: break
            i = nl + 1; continue
        rid = m.group(1); j = m.end()
        if text.startswith('T', j):  # text chunk: T<hexlen>,<data>
            comma = text.index(',', j)
            ln = int(text[j+1:comma], 16)
            data = text[comma+1:].encode('utf-8')[:ln].decode('utf-8', 'ignore')
            rows[rid] = data
            i = comma + 1 + len(data)
            continue
        nl = text.find('\n', j)
        if nl == -1: nl = n
        payload = text[j:nl]
        if payload[:1] in ('I', 'E', 'H', 'W', 'D'):
            rows[rid] = None
        else:
            try: rows[rid] = json.loads(payload)
            except Exception: rows[rid] = None
        i = nl + 1
    return rows

def resolve(rows, node, depth=0, seen=None):
    if depth > 400: return None
    if isinstance(node, str):
        m = re.fullmatch(r'\$L?([0-9a-f]+)', node)
        if m and m.group(1) in rows:
            return resolve(rows, rows[m.group(1)], depth+1)
        if node.startswith('$$'): return node[1:]
        return node
    if isinstance(node, list):
        return [resolve(rows, x, depth+1) for x in node]
    if isinstance(node, dict):
        return {k: resolve(rows, v, depth+1) for k, v in node.items()}
    return node

def is_el(x):
    return isinstance(x, list) and len(x) == 4 and x[0] == '$' and isinstance(x[3], dict)

def text_of(x):
    if x is None or x is False or x is True: return ''
    if isinstance(x, (int, float)): return str(x)
    if isinstance(x, str): return '' if x == '$undefined' else x
    if is_el(x): return text_of(x[3].get('children'))
    if isinstance(x, list): return ''.join(text_of(c) for c in x)
    return ''
