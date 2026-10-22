import re, os, sys
S = __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))), "src")

def strip_keep_interp(text):
    """Маха коментари и стрингове, НО пази ${...} вътре в шаблонните стрингове."""
    out, i, n, mode, depth = [], 0, len(text), None, []
    while i < n:
        c = text[i]; nx = text[i+1] if i+1 < n else ''
        if mode is None:
            if c in '"\'':       mode = c; out.append(' '); i += 1; continue
            if c == '`':         mode = '`'; out.append(' '); i += 1; continue
            if c == '/' and nx == '/': mode = 'line'; i += 2; continue
            if c == '/' and nx == '*': mode = 'block'; i += 2; continue
            out.append(c); i += 1; continue
        if mode == '`':
            if c == '\\': i += 2; continue
            if c == '$' and nx == '{':      # влизаме във вмъкната стойност - пазим я
                mode = 'interp'; depth = 1; out.append(' '); i += 2; continue
            if c == '`': mode = None; i += 1; continue
            if c == '\n': out.append('\n')
            i += 1; continue
        if mode == 'interp':
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: mode = '`'; out.append(' '); i += 1; continue
            out.append(c); i += 1; continue
        if mode in '"\'':
            if c == '\\': i += 2; continue
            if c == mode: mode = None
            i += 1; continue
        if mode == 'line':
            if c == '\n': mode = None; out.append('\n')
            i += 1; continue
        if c == '*' and nx == '/': mode = None; i += 2; continue
        if c == '\n': out.append('\n')
        i += 1
    return ''.join(out)

DEF  = re.compile(r'^(?:export\s+)?(?:async\s+function|function|const|let|var|type|interface|class)\s+([A-Za-z_$Ѐ-ӿ][\w$Ѐ-ӿ]*)')
WORD = re.compile(r'(?<![\w$.Ѐ-ӿ])([A-Za-z_$Ѐ-ӿ][\w$Ѐ-ӿ]*)')
IMP  = re.compile(r'^import\s+\{([^}]*)\}\s+from\s+"\./(\w+)";', re.M)

mods = {f[:-3]: open(os.path.join(S, f), encoding="utf-8").read()
        for f in sorted(os.listdir(S)) if f.endswith(".ts")}

defs, mine = {}, {}
for nm, t in mods.items():
    s = set()
    for ln in t.split("\n"):
        m = DEF.match(ln)
        if m: defs[m.group(1)] = nm; s.add(m.group(1))
    mine[nm] = s

# локални имена: параметри, променливи в тела - за да не бъркаме, броим само
# имена, които НЯКЪДЕ са top-level дефиниция в друг модул
проблеми = []
for nm, t in mods.items():
    imported = set()
    for ids, src in IMP.findall(t):
        imported |= {x.strip() for x in ids.split(",") if x.strip()}
    # „...“ се маха ПРЕДИ разпознаването на имената. WORD нарочно пропуска име,
    # пред което стои точка (обект.свойство), но третата точка на оператора за
    # разгъване изглежда точно така — затова `...netLine(l)` и `...artRows(...)`
    # оставаха невидими и липсващите им import-и не бяха хванати (21.10.2026).
    used = set(WORD.findall(strip_keep_interp(t).replace("...", "   ")))
    for w in sorted(used):
        if w in defs and defs[w] != nm and w not in imported and w not in mine[nm]:
            проблеми.append((nm, w, defs[w]))

if проблеми:
    print("ЛИПСВАЩИ IMPORT-И:")
    for nm, w, src in проблеми:
        print(f"  {nm}.ts  ползва  {w}  (дефиниран в {src}.ts)  — НЕ Е ВНЕСЕН")
    sys.exit(1)
print("няма липсващи import-и")
