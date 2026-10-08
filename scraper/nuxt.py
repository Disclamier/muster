"""Decode Nuxt 3 __NUXT_DATA__ (devalue) payloads."""
import json, re

WRAPPERS = {"ShallowReactive", "Reactive", "Ref", "ShallowRef", "EmptyShallowRef", "EmptyRef", "NuxtError"}


def nuxt_data(html):
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, flags=re.S)
    if not m:
        return None
    arr = json.loads(m.group(1))
    memo = {}

    def h(i):
        if not isinstance(i, int):
            return i
        if i < 0:
            return None  # -1 undefined, -2 hole, -3 NaN ...
        if i in memo:
            return memo[i]
        v = arr[i]
        if isinstance(v, list):
            if v and isinstance(v[0], str) and v[0] in WRAPPERS:
                r = h(v[1]) if len(v) > 1 else None
            elif v and isinstance(v[0], str) and v[0] in ("Date",):
                r = v[1]
            elif v and isinstance(v[0], str) and v[0] == "Set":
                r = [h(x) for x in v[1:]]
            elif v and isinstance(v[0], str) and v[0] == "Map":
                r = {str(h(v[k])): h(v[k + 1]) for k in range(1, len(v) - 1, 2)}
            else:
                r = []
                memo[i] = r
                r.extend(h(x) for x in v)
                return r
        elif isinstance(v, dict):
            r = {}
            memo[i] = r
            for k, x in v.items():
                r[k] = h(x)
            return r
        else:
            r = v
        memo[i] = r
        return r

    return h(0)
