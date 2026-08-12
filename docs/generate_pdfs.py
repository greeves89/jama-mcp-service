#!/usr/bin/env python3
"""
Erzeugt druckreife PDF-Dokumente aus den Markdown-Dateien in docs/.

    pip install markdown weasyprint
    python docs/generate_pdfs.py

Das Design ist bewusst neutral gehalten — dieses Repository ist quelloffen und
soll kein Firmen-Branding tragen.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import markdown
    from weasyprint import HTML
except ImportError:
    sys.exit("Fehlende Abhaengigkeiten. Bitte ausfuehren: pip install markdown weasyprint")

DOCS = Path(__file__).parent

# --- Farben -----------------------------------------------------------------
PRIMARY = "#1e293b"
PRIMARY_DARK = "#0f172a"
ACCENT = "#0369a1"
MUTED = "#64748b"
BORDER = "#e2e8f0"
SURFACE = "#f8fafc"

# --- Dokument-Metadaten -----------------------------------------------------
DOC_META = {
    "vergleich-mcp.md": {
        "subtitle": "Offizieller Jama Connect MCP gegenüber der Eigenentwicklung",
        "doc_type": "ENTSCHEIDUNGSGRUNDLAGE",
    },
    "KONZEPT.md": {
        "subtitle": "Architektur, Anwendungsfälle, Tool-Katalog und Betrieb",
        "doc_type": "KONZEPT",
    },
}


def extract_metadata(text: str) -> tuple[str, dict[str, str], str]:
    """Liest Titel und die **Key:** Value-Zeilen vor dem ersten Trenner."""
    lines = text.split("\n")
    title = ""
    meta: dict[str, str] = {}
    start = 0

    for index, line in enumerate(lines):
        stripped = line.strip()
        if not title and stripped.startswith("# "):
            title = stripped[2:].strip()
            continue
        if stripped == "---" and title:
            start = index + 1
            break
        match = re.match(r"^\*\*(.+?):\*\*\s*(.*)$", stripped)
        if match and title:
            meta[match.group(1)] = match.group(2)

    return title, meta, "\n".join(lines[start:])


def preprocess_markdown(text: str) -> str:
    """
    Ergaenzt Leerzeilen vor Listen. Python-Markdown erkennt eine Liste sonst
    nicht, wenn direkt darueber ein Absatz steht.
    """
    out: list[str] = []
    previous = ""
    for line in text.split("\n"):
        is_list = re.match(r"^\s*([-*+]|\d+\.)\s", line)
        if is_list and previous.strip() and not re.match(r"^\s*([-*+]|\d+\.)\s", previous):
            out.append("")
        out.append(line)
        previous = line
    return "\n".join(out)


def build_cover(title: str, meta: dict[str, str], doc_type: str, subtitle: str) -> str:
    rows = "".join(
        f"<tr><th>{key}</th><td>{value}</td></tr>" for key, value in meta.items()
    )
    return f"""
    <div class="cover">
      <div class="cover-type">{doc_type}</div>
      <h1 class="cover-title">{title}</h1>
      <p class="cover-subtitle">{subtitle}</p>
      <table class="cover-meta">{rows}</table>
    </div>
    """


def build_toc(html: str) -> str:
    """Baut ein Inhaltsverzeichnis aus den h2- und h3-Ueberschriften."""
    entries = re.findall(r'<h([23]) id="([^"]+)">(.*?)</h[23]>', html)
    if not entries:
        return ""
    items = "".join(
        f'<li class="toc-h{level}"><a href="#{anchor}">{re.sub(r"<[^>]+>", "", text)}</a></li>'
        for level, anchor, text in entries
    )
    return f'<div class="toc"><h2 class="toc-title">Inhalt</h2><ul>{items}</ul></div>'


CSS = f"""
@page {{
  size: A4;
  margin: 20mm 18mm 18mm 18mm;
  @bottom-left  {{ content: "jama-mcp-service"; font-size: 7.5pt; color: {MUTED}; }}
  @bottom-center{{ content: counter(page); font-size: 8pt; color: {MUTED}; }}
  @bottom-right {{ content: "__FOOTER_RIGHT__"; font-size: 7.5pt; color: {MUTED}; }}
}}
@page :first {{ margin: 0; @bottom-left {{ content: ""; }} @bottom-center {{ content: ""; }} @bottom-right {{ content: ""; }} }}

* {{ box-sizing: border-box; }}
body {{
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 9.5pt; line-height: 1.55; color: {PRIMARY}; margin: 0;
}}

.cover {{
  page-break-after: always; height: 297mm; padding: 60mm 22mm 22mm 22mm;
  border-top: 10mm solid {ACCENT};
}}
.cover-type {{
  font-size: 8.5pt; letter-spacing: 0.22em; color: {ACCENT};
  font-weight: 700; margin-bottom: 8mm;
}}
.cover-title {{
  font-size: 30pt; line-height: 1.15; font-weight: 700;
  color: {PRIMARY_DARK}; margin: 0 0 5mm 0; border: none; padding: 0;
}}
.cover-subtitle {{ font-size: 12pt; color: {MUTED}; margin: 0 0 18mm 0; font-weight: 400; }}
.cover-meta {{ border-collapse: collapse; font-size: 9.5pt; width: auto; }}
.cover-meta th {{
  text-align: left; padding: 2.2mm 12mm 2.2mm 0; color: {MUTED};
  font-weight: 600; border: none; background: none;
}}
.cover-meta td {{ padding: 2.2mm 0; color: {PRIMARY_DARK}; border: none; }}

.toc {{ page-break-after: always; }}
.toc-title {{ border: none; padding: 0; margin: 0 0 6mm 0; }}
.toc ul {{ list-style: none; padding: 0; margin: 0; }}
.toc li {{ padding: 1.4mm 0; border-bottom: 1px dotted {BORDER}; }}
.toc li a {{ text-decoration: none; color: {PRIMARY}; }}
.toc-h3 {{ padding-left: 7mm; font-size: 9pt; color: {MUTED}; }}

h1, h2, h3, h4 {{ color: {PRIMARY_DARK}; font-weight: 700; page-break-after: avoid; }}
h2 {{
  font-size: 15pt; margin: 0 0 5mm 0; padding-bottom: 2.5mm;
  border-bottom: 2px solid {ACCENT}; page-break-before: always;
}}
.toc + h2, h2:first-of-type {{ page-break-before: avoid; }}
h3 {{ font-size: 11.5pt; margin: 7mm 0 2.5mm 0; }}
h4 {{ font-size: 10pt; margin: 5mm 0 2mm 0; color: {MUTED}; }}
p {{ margin: 0 0 3mm 0; text-align: justify; hyphens: auto; }}

ul, ol {{ margin: 0 0 3.5mm 0; padding-left: 5mm; }}
li {{ margin-bottom: 1.2mm; }}

/* Lange Tabellen duerfen umbrechen — sonst rutschen sie als Ganzes auf die
   naechste Seite und hinterlassen eine fast leere. Einzelne Zeilen bleiben
   aber zusammen, und der Tabellenkopf wird auf jeder Folgeseite wiederholt. */
table {{
  width: 100%; border-collapse: collapse; margin: 3.5mm 0 5mm 0;
  font-size: 8.5pt; page-break-inside: auto;
}}
thead {{ display: table-header-group; }}
tr {{ page-break-inside: avoid; page-break-after: auto; }}
th {{
  background: {PRIMARY_DARK}; color: #fff; text-align: left;
  padding: 2.2mm 2.5mm; font-weight: 600; font-size: 8pt;
}}
td {{ padding: 2.2mm 2.5mm; border-bottom: 1px solid {BORDER}; vertical-align: top; }}
tr:nth-child(even) td {{ background: {SURFACE}; }}

code {{
  font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 8pt;
  background: {SURFACE}; padding: 0.4mm 1.2mm; border-radius: 1mm; color: {ACCENT};
}}
pre {{
  background: {SURFACE}; border-left: 3px solid {ACCENT}; padding: 3mm;
  overflow-x: auto; font-size: 8pt; page-break-inside: avoid; margin: 3mm 0;
}}
pre code {{ background: none; padding: 0; color: {PRIMARY}; }}

hr {{ border: none; border-top: 1px solid {BORDER}; margin: 6mm 0; }}
strong {{ color: {PRIMARY_DARK}; font-weight: 700; }}
a {{ color: {ACCENT}; text-decoration: none; }}
blockquote {{
  margin: 3mm 0; padding: 2mm 0 2mm 4mm;
  border-left: 3px solid {ACCENT}; color: {MUTED};
}}
"""


def generate(md_name: str, pdf_name: str) -> bool:
    source = DOCS / md_name
    if not source.exists():
        print(f"  uebersprungen: {md_name} nicht gefunden")
        return False

    title, meta, content = extract_metadata(source.read_text(encoding="utf-8"))
    info = DOC_META.get(md_name, {})

    body = markdown.markdown(
        preprocess_markdown(content),
        extensions=["tables", "fenced_code", "toc", "attr_list", "sane_lists"],
    )

    # Der Fusszeilentext rechts nennt die Dokumentart des jeweiligen Dokuments.
    css = CSS.replace("__FOOTER_RIGHT__", info.get("doc_type", "DOKUMENT").title())

    html = (
        f"<html><head><meta charset='utf-8'><style>{css}</style></head><body>"
        + build_cover(title, meta, info.get("doc_type", "DOKUMENT"), info.get("subtitle", ""))
        + build_toc(body)
        + body
        + "</body></html>"
    )

    target = DOCS / pdf_name
    HTML(string=html, base_url=str(DOCS)).write_pdf(target)
    print(f"  erstellt: {pdf_name} ({target.stat().st_size // 1024} KB)")
    return True


def main() -> None:
    files = [
        ("vergleich-mcp.md", "Jama-MCP-Vergleich.pdf"),
        ("KONZEPT.md", "Jama-MCP-Konzept.pdf"),
    ]
    print("PDF-Erzeugung")
    erzeugt = sum(generate(md, pdf) for md, pdf in files)
    print(f"{erzeugt} von {len(files)} Dokumenten erstellt.")


if __name__ == "__main__":
    main()
