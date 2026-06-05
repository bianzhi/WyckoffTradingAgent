#!/usr/bin/env python3
"""批量给文件插入 _safe_float 并替换所有未保护的 float()。"""
import re, sys

SAFE_FLOAT_DEF = '''
def _safe_float(v, default=0.0):
    """安全 float 转换，pd.NA/NaN/None → default。"""
    import builtins
    try:
        if v is None:
            return default
        if isinstance(v, (int, float)):
            try:
                if v != v:
                    return default
            except Exception:
                pass
            return builtins.float(v)
        return builtins.float(v)
    except (TypeError, ValueError, AttributeError):
        return default
'''.strip()

def process(fpath):
    with open(fpath) as f:
        content = f.read()
    if 'def _safe_float' in content:
        print(f"  skip: already has _safe_float")
        return False
    lines = content.split('\n')
    # find last import
    last = 0
    for i, l in enumerate(lines):
        s = l.strip()
        if s.startswith('import ') or s.startswith('from '):
            last = i
        elif last > 0 and s == '':
            continue
        elif last > 0 and s and not s.startswith('#'):
            break
    # insert pandas import if missing
    if 'import pandas' not in content:
        lines.insert(last + 1, 'import pandas as pd')
        last += 1
    # insert _safe_float
    for j, dl in enumerate(SAFE_FLOAT_DEF.split('\n')):
        lines.insert(last + 1 + j, dl)
    # replace
    in_def = False
    result = []
    for l in lines:
        if 'def _safe_float' in l:
            in_def = True
            result.append(l)
            continue
        if in_def and l.strip() == '':
            in_def = False
            result.append(l)
            continue
        if in_def:
            result.append(l)
            continue
        result.append(re.sub(r'(?<![a-zA-Z_.])float\(', '_safe_float(', l))
    with open(fpath, 'w') as f:
        f.write('\n'.join(result))
    new_c = '\n'.join(result).count('float(')
    print(f"  ok: {content.count('float(')} → {new_c} float() calls remaining")
    return True

files = sys.argv[1:]
for f in files:
    print(f"processing {f}:")
    process(f)
print("done")
