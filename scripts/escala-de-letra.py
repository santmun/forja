# -*- coding: utf-8 -*-
"""
Saca del código TODOS los tamaños de letra que se usan de verdad, de las tres
formas en que aparecen, y genera la regla CSS del tema. Nada de adivinar:
si el tamaño está en el código, entra en la lista.

Formas encontradas:
  1. style="...font-size:11px..."      (estilo en línea, sin espacio)
  2. style="...font-size: 11px..."     (con espacio)
  3. class="text-[10.5px]"             (clase de Tailwind con valor propio)
"""
import re
import pathlib
from collections import Counter

BASE = pathlib.Path(__file__).resolve().parents[1] / "src" / "admin"

RE_INLINE = re.compile(r"font-size:\s*(\d+(?:\.\d+)?)px")
RE_TW = re.compile(r"text-\[(\d+(?:\.\d+)?)px\]")

inline, tw, con_espacio = Counter(), Counter(), 0
for f in BASE.rglob("*.ts"):
    t = f.read_text(encoding="utf-8")
    for m in RE_INLINE.finditer(t):
        inline[float(m.group(1))] += 1
        if ": " in m.group(0):
            con_espacio += 1
    for m in RE_TW.finditer(t):
        tw[float(m.group(1))] += 1

print(f"tamaños en estilo en línea: {sorted(inline)}")
print(f"  (de ellos, escritos con espacio: {con_espacio})")
print(f"tamaños en clases Tailwind : {sorted(tw)}")

# Escala: nada por debajo de 13.5; los chicos suben más que los grandes.
def escalar(px: float) -> float:
    if px <= 9.5:
        return 13.5
    if px <= 10.5:
        return 14.0
    if px <= 11.5:
        return 14.5
    if px <= 12.5:
        return 15.0
    if px <= 13.5:
        return 15.5
    if px <= 14.5:
        return 16.5
    if px <= 15:
        return 17.0
    return px  # los títulos grandes se quedan como están


def fmt(px: float) -> str:
    return f"{px:g}"


lineas = []
for px in sorted(set(inline) | set(tw)):
    nuevo = escalar(px)
    if nuevo == px:
        continue
    sel = []
    if px in inline:
        sel.append(f'[style*="font-size:{fmt(px)}px"]')
        sel.append(f'[style*="font-size: {fmt(px)}px"]')
    if px in tw:
        # OJO: en CSS hay que escapar los corchetes Y EL PUNTO del decimal.
        # Sin escapar el punto, ".text-\[10.5px\]" se lee como ".text-\[10"
        # seguido de ".5px\]" y la regla entera se descarta en silencio: por eso
        # "USD · deja vacío para quitar el límite" seguía chico (10/08/2026).
        # En el .ts, cada "\\" del código produce un "\" en el CSS final.
        sel.append(f'.text-\\\\[{fmt(px).replace(".", "\\\\.")}px\\\\]')
    lineas.append(f"    {','.join(sel)}{{font-size:{fmt(nuevo)}px !important}}")

salida = "\n".join(lineas)
destino = pathlib.Path(__file__).resolve().parent / "escala.css"
destino.write_text(salida, encoding="utf-8")
print(f"\nreglas generadas: {len(lineas)}")
print(salida[:600])
