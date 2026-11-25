# calidad.py — generado por FARO (harness.js calidad / harness.js ci). No lo edites a mano: se regenera.
#
# Mide la calidad del código que TOCA un cambio, con los principios de ub-mode
# (https://github.com/unclebob/ub-mode, MIT) y sus herramientas deterministas:
#   - crapper: CRAP = CC² × (1 − cobertura)³ + CC  ->  cada función tocada, CRAP < 10.
#   - dryer:   duplicación estructural                ->  ningún duplicado >= 0,8 con una función tocada.
#
# Solo lo tocado: una función cuenta si su rango de líneas se cruza con el diff contra la rama base.
# Así se puede adoptar en un repo con historia sin exigir antes reescribirlo todo.
#
# Sin cobertura (lo normal en CI, que no repite los tests): CRAP >= CC siempre, así que se exige
# CC < umbral, que es una cota segura (nunca da un falso positivo). Con --cobertura, o con un
# informe LCOV ya en disco, se usa el CRAP real.
#
# Uso: python calidad.py [--base REF] [--todo] [--ci] [--cobertura] [--umbral-crap N] [--umbral-dup N]
# Salida 0 siempre, salvo --ci con incumplimientos (1). Sin las herramientas instaladas: aviso y 0.
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

UMBRAL_CRAP = 10.0
UMBRAL_DUP = 0.8

# ---------- dominio (puro: textos y números, sin disco ni procesos) ----------

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def rangos_diff(texto: str) -> dict[str, list[tuple[int, int]]]:
    """Líneas nuevas o cambiadas por fichero, de un `git diff -U0`. Un borrado marca la línea donde ocurre."""
    rangos: dict[str, list[tuple[int, int]]] = {}
    actual = None
    for linea in texto.splitlines():
        if linea.startswith("+++ "):
            destino = linea[4:].strip()
            actual = None if destino == "/dev/null" else re.sub(r"^b/", "", destino)
            continue
        m = _HUNK.match(linea)
        if m and actual:
            inicio = int(m.group(1))
            cuantas = 1 if m.group(2) is None else int(m.group(2))
            fin = inicio + max(cuantas, 1) - 1
            rangos.setdefault(actual, []).append((max(inicio, 1), max(fin, 1)))
    return rangos


def cruza(rangos: list[tuple[int, int]] | None, inicio: int, fin: int) -> bool:
    """None = todo cuenta como tocado (--todo)."""
    if rangos is None:
        return True
    return any(a <= fin and inicio <= b for a, b in rangos)


def de_faro(fichero: str) -> bool:
    """Lo que vive en .faro/ (esta misma copia del script, por ejemplo) es de FARO, no del proyecto."""
    return fichero.replace("\\", "/").startswith(".faro/")


def tocado(rangos_por_fichero: dict | None, fichero: str, inicio: int, fin: int) -> bool:
    if de_faro(fichero):
        return False
    if rangos_por_fichero is None:
        return True
    return cruza(rangos_por_fichero.get(fichero, []), inicio, fin)


def incumple_crap(complejidad: int, crap: float | None, umbral: float) -> bool:
    """Sin cobertura, CRAP >= CC: exigir CC < umbral es una cota segura."""
    valor = complejidad if crap is None else crap
    return valor >= umbral


def evaluar(funciones: list[dict], duplicados: list[dict], rangos: dict | None,
            umbral_crap: float = UMBRAL_CRAP, umbral_dup: float = UMBRAL_DUP) -> dict:
    """funciones: {fichero, nombre, inicio, fin, complejidad, crap|None}.
    duplicados: {score, a:{fichero,inicio,fin}, b:{...}}. Devuelve lo que incumple en lo tocado."""
    crap = [f for f in funciones
            if tocado(rangos, f["fichero"], f["inicio"], f["fin"])
            and incumple_crap(f["complejidad"], f.get("crap"), umbral_crap)]
    dup = [d for d in duplicados
           if d["score"] >= umbral_dup
           and (tocado(rangos, d["a"]["fichero"], d["a"]["inicio"], d["a"]["fin"])
                or tocado(rangos, d["b"]["fichero"], d["b"]["inicio"], d["b"]["fin"]))]
    medidas = [f for f in funciones if tocado(rangos, f["fichero"], f["inicio"], f["fin"])]
    return {"crap": sorted(crap, key=lambda f: -(f.get("crap") or f["complejidad"])),
            "dup": sorted(dup, key=lambda d: -d["score"]),
            "medidas": len(medidas)}


def sin_duplicacion(ficheros: list[str], extensiones_dryer) -> list[str]:
    """Ficheros tocados cuya duplicación no se puede medir (dryer no lee su lenguaje, p. ej. .js)."""
    return [f for f in ficheros if Path(f).suffix.lower() not in extensiones_dryer]


def informe(r: dict, con_cobertura: bool, umbral_crap: float = UMBRAL_CRAP, umbral_dup: float = UMBRAL_DUP,
            sin_dup: list[str] = ()) -> str:
    lineas = [f"[calidad] {r['medidas']} función(es) tocada(s) medidas"
              + ("" if con_cobertura else " (sin cobertura: se exige CC < umbral, cota segura de CRAP)")]
    if sin_dup:
        exts = ", ".join(sorted({Path(f).suffix for f in sin_dup}))
        lineas.append(f"[calidad] duplicación no medida en {len(sin_dup)} fichero(s) ({exts}): dryer no lee ese lenguaje.")
    if not r["crap"] and not r["dup"]:
        lineas.append(f"[calidad] OK: CRAP < {umbral_crap:g} y sin duplicados >= {umbral_dup:g} en lo tocado.")
        return "\n".join(lineas)
    for f in r["crap"]:
        valor = f"CRAP {f['crap']:.1f}" if f.get("crap") is not None else f"CC {f['complejidad']}"
        lineas.append(f"  CRAP  {f['fichero']}:{f['inicio']}-{f['fin']}  {f['nombre']}  {valor} (>= {umbral_crap:g}): "
                      "trocéala, cúbrela con tests, o las dos.")
    for d in r["dup"]:
        lineas.append(f"  DUP   {d['score']:.2f}  {d['a']['fichero']}:{d['a']['inicio']}-{d['a']['fin']}"
                      f"  ~  {d['b']['fichero']}:{d['b']['inicio']}-{d['b']['fin']}: una decisión en un solo sitio.")
    lineas.append(f"[calidad] {len(r['crap'])} función(es) sobre el umbral CRAP y {len(r['dup'])} duplicado(s).")
    return "\n".join(lineas)

# ---------- adaptadores (git y herramientas) ----------


def _git(raiz: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(raiz), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def _base_por_defecto(raiz: Path) -> str | None:
    for ref in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
        mb = _git(raiz, "merge-base", "HEAD", ref).strip()
        if mb:
            return mb
    return None


def rangos_del_repo(raiz: Path, base: str | None) -> dict[str, list[tuple[int, int]]]:
    base = base or _base_por_defecto(raiz)
    texto = _git(raiz, "diff", "-U0", "--no-color", "--no-renames", base) if base else ""
    rangos = rangos_diff(texto)
    for nuevo in _git(raiz, "ls-files", "--others", "--exclude-standard").splitlines():
        if nuevo.strip():
            rangos[nuevo.strip()] = [(1, 10 ** 9)]
    return rangos


def _cobertura(raiz: Path, ficheros: list[Path], correr: bool):
    """El informe de cobertura: el que generen los tests (--cobertura) o el que ya haya en disco; si no, None."""
    from crapper.coverage import load_bundle
    if correr:
        from crapper.runners import run_coverage
        run_coverage(raiz, ficheros, None)
    try:
        bundle = load_bundle(raiz)
    except Exception:
        return None
    return bundle if (bundle.lcov or bundle.go_profile or bundle.jacoco or bundle.form_html) else None


def medir_crap(raiz: Path, ficheros: list[Path], cobertura: bool) -> tuple[list[dict], bool]:
    from crapper.analyze import _coverage
    from crapper.crap import make_entry
    from crapper.discover import is_test_file, language_of
    from crapper.languages import functions_in_file
    ficheros = [f for f in ficheros if language_of(f) and not is_test_file(f)]
    bundle = _cobertura(raiz, ficheros, cobertura)
    rels = [f.resolve().relative_to(raiz).as_posix() for f in ficheros]
    if bundle is not None:
        bundle.bind_sources(rels)
    out = []
    for f, rel in zip(ficheros, rels):
        fuente = f.read_text(encoding="utf-8", errors="replace")
        for fn in functions_in_file(language_of(f), fuente, rel, str(raiz)):
            e = make_entry(fn, _coverage(bundle, fn))
            out.append({"fichero": rel, "nombre": f"{fn.namespace}.{fn.name}", "inicio": fn.start_line,
                        "fin": fn.end_line, "complejidad": e.complexity, "crap": e.crap})
    return out, bundle is not None


def medir_dup(raiz: Path, umbral: float) -> list[dict]:
    from dryer.discover import iter_source_files
    from dryer.scan import find_duplicates, scan_files
    entradas, _avisos = scan_files(iter_source_files([raiz]), raiz, 4, 20)
    span = lambda s: {"fichero": Path(s.file).as_posix(), "inicio": s.start_line, "fin": s.end_line}
    return [{"score": d.score, "a": span(d.left), "b": span(d.right)} for d in find_duplicates(entradas, umbral)]


def _argumentos(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="calidad", description="Calidad del código tocado (ub-mode: crapper + dryer).")
    p.add_argument("--base", help="rama o commit contra el que se compara (defecto: merge-base con origin/HEAD o main)")
    p.add_argument("--todo", action="store_true", help="medir todo el repo, no solo lo tocado")
    p.add_argument("--ci", action="store_true", help="salir con 1 si algo incumple")
    p.add_argument("--cobertura", action="store_true", help="correr los tests para el CRAP real (más lento)")
    p.add_argument("--umbral-crap", type=float, default=UMBRAL_CRAP)
    p.add_argument("--umbral-dup", type=float, default=UMBRAL_DUP)
    return p.parse_args(argv)


def _herramientas_instaladas() -> bool:
    try:
        import crapper  # noqa: F401
        import dryer  # noqa: F401
        return True
    except ImportError:
        return False


def _ficheros(raiz: Path, rangos: dict | None) -> list[Path]:
    if rangos is None:
        from crapper.discover import iter_source_files
        return iter_source_files([raiz])
    return [raiz / f for f in rangos if (raiz / f).is_file()]


def _sin_dup(funciones: list[dict]) -> list[str]:
    from dryer.discover import EXTENSIONS
    return sin_duplicacion(sorted({f["fichero"] for f in funciones if not de_faro(f["fichero"])}), EXTENSIONS)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    a = _argumentos(argv)
    if not _herramientas_instaladas():
        print("[calidad] faltan crapper y dryer: con FARO, `harness.js calidad` los instala; en CI, el job los instala con pip.")
        return 0
    raiz = Path(_git(Path.cwd(), "rev-parse", "--show-toplevel").strip() or Path.cwd()).resolve()
    rangos = None if a.todo else rangos_del_repo(raiz, a.base)
    if rangos == {}:
        print("[calidad] nada tocado respecto a la base: nada que medir.")
        return 0
    funciones, con_cob = medir_crap(raiz, _ficheros(raiz, rangos), a.cobertura)
    r = evaluar(funciones, medir_dup(raiz, a.umbral_dup), rangos, a.umbral_crap, a.umbral_dup)
    print(informe(r, con_cob, a.umbral_crap, a.umbral_dup, _sin_dup(funciones)))
    return 1 if a.ci and (r["crap"] or r["dup"]) else 0


if __name__ == "__main__":
    sys.exit(main())
