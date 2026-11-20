"""Read public supplier catalogues and generate a daily Printastic 360 edition."""
import json
import re
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

SOURCES = [
    ("Print e Poupe", "PT", "https://printepoupe.com/loja/novidades", "h4 a, .product-thumb h4 a"),
    ("Cola-me", "PT", "https://www.colame.net/loja/", "a.woocommerce-LoopProduct-link, a.woocommerce-loop-product__link"),
    ("Sublimet", "ES", "https://www.sublimet.com/es/productos-nuevos/", ".product-title a, .product-miniature h2 a, .product-miniature h3 a"),
    ("Brildor", "ES", "https://www.brildor.com/pt/novidades", ".product-item-link, .product-item-name a"),
]
PRODUCTS = [
    (r"natal|navidad|advento", "Enfeite ou presente de Natal com nome e ano", "Famílias e empresas", "Natal"),
    (r"camiset|t-shirt|avental|delantal|sweat|gorro|bon[eé]", "Identidade da equipa à frente e nome na manga, por DTF têxtil conforme o tecido", "Equipas, comércio e associações", ""),
    (r"caneca|taza|ch[aá]vena|garrafa|botella|vaso|copo", "Nome e grafismo a condizer com a campanha; confirmar revestimento e técnica", "Empresas, famílias e eventos", ""),
    (r"saco|bolsa|mochila|tote|t[aá]bua|bambu|rel[oó]gio", "Pequena coleção com iniciais e opção de logótipo para encomendas em quantidade", "Comércio, empresas e eventos", ""),
    (r"iman|[ií]m[aã]|moldura|fotopain|azulej|chaveiro|llavero|porta-chaves|puzzle|pulseira|pulsera|cadern|bloco|esferogr[aá]fica", "Edição com nome, data e motivo gráfico alusivo à ocasião", "Famílias, empresas e associações", ""),
]
EXCLUDE = re.compile(r"impresora|impressora|plancha|prensa|recambio|resist[eê]ncia|consum[ií]ve|bobina|papel|tinta|pel[ií]cula|plotter|maquina|m[aá]quina|software|fecho da|fita term|acess[oó]ri[oa] para prens|repuesto|cabe[cç]al de impress", re.I)
PRICE = re.compile(r"(?:€\s*)?\d[\d .]*[,.]\d{2}\s*€|€\s*\d[\d .]*[,.]\d{2}")
AGENT = "Printastic360Catalog/1.0"
HTTP = requests.Session()
HTTP.headers["User-Agent"] = AGENT


def campaign(month):
    if month in (10, 11, 12):
        return "Natal e presentes de equipa"
    if month in (1, 2):
        return "São Valentim e Dia do Pai"
    if month in (3, 4):
        return "Dia do Pai, Páscoa e Dia da Mãe"
    if month in (5, 6):
        return "Final de aulas, torneios e eventos"
    if month in (7, 8):
        return "Verão e regresso às aulas"
    return "Regresso às aulas e campanhas de outono"


def permitted(url):
    root = urlsplit(url)
    response = HTTP.get(f"{root.scheme}://{root.netloc}/robots.txt", timeout=15)
    if response.status_code == 404:
        return True
    response.raise_for_status()
    robots = RobotFileParser()
    robots.parse(response.text.splitlines())
    return robots.can_fetch(AGENT, url)


def records(supplier, country, source, selector, season):
    if not permitted(source):
        raise ValueError("robots.txt restringe esta página")
    time.sleep(1)
    response = HTTP.get(source, timeout=25)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    anchors = soup.select(selector)
    if not anchors:
        raise ValueError("página sem fichas de produto legíveis")
    items = []
    seen = set()
    for anchor in anchors[:100]:
        href = urljoin(source, anchor.get("href", ""))
        original = urlsplit(source)
        target = urlsplit(href)
        if target.scheme != "https" or target.hostname != original.hostname or target.path == original.path:
            continue
        href = target._replace(query="", fragment="").geturl()
        price_area = anchor.find_parent(class_=re.compile(r"product-thumb|product-miniature|product-item-info")) or anchor
        price = PRICE.search(price_area.get_text(" ", strip=True))
        name_node = anchor.select_one(".woocommerce-loop-product__title, h2, h3")
        name = (name_node or anchor).get_text(" ", strip=True)
        name = unicodedata.normalize("NFC", name).strip()
        match = next((row for row in PRODUCTS if re.search(row[0], name, re.I)), None)
        if not match and re.search(
            r"personaliz|sublim[aá]v|sublimab|para sublima|por personalizar|grava[cç][aã]o|grabado|laser",
            price_area.get_text(" ", strip=True), re.I
        ):
            match = ("", "Testar uma personalização com nome, grafismo ou logótipo sobre a área aplicável",
                     "Empresas, famílias e eventos", "")
        if href in seen or len(name) < 4 or len(name) > 170 or not match or EXCLUDE.search(name):
            continue
        if match[3] == "Natal" and "Natal" not in season:
            continue
        seen.add(href)
        items.append({
            "name": name, "supplier": supplier, "country": country, "url": href,
            "season": match[3] or season, "idea": match[1], "audience": match[2],
            "buyPrice": (price.group().strip() + " no catálogo") if price else "Consultar ficha",
            "sellPrice": "A calcular após portes e personalização",
            "recommendation": "Faz uma amostra e abre pré-encomendas para a campanha " + (match[3] or season) + ".",
        })
    return items


def identity(item):
    return item["supplier"], " ".join(re.findall(r"\w+", item["name"].casefold()))


def main():
    now = datetime.now(ZoneInfo("Europe/Lisbon"))
    target = Path("oportunidades-diarias.json")
    previous = json.loads(target.read_text()) if target.exists() else {}
    seen = previous.get("seen", {})
    today = now.date().isoformat()
    candidates = []
    stats = []
    for supplier, country, url, selector in SOURCES:
        try:
            items = records(supplier, country, url, selector, campaign(now.month))
            stats.append({"supplier": supplier, "country": country, "checked": True, "found": len(items)})
            candidates.extend(items)
        except (requests.RequestException, ValueError) as error:
            stats.append({"supplier": supplier, "country": country, "checked": False, "found": 0})
            print(f"{supplier}: {error}", flush=True)
    # Publish a first edition and then prefer newly detected listings without claiming launch dates.
    available = {item["url"]: item for item in candidates}
    checked = {source["supplier"] for source in stats if source["checked"]}
    current = []
    used_names = set()
    if previous.get("date") == today:
        for item in previous.get("items", []):
            name_key = identity(item)
            still_available = item["url"] in available or item["supplier"] not in checked
            if still_available and name_key not in used_names and not EXCLUDE.search(item["name"]):
                current.append(available.get(item["url"], item))
                used_names.add(name_key)
    current_urls = {item["url"] for item in current}
    fresh = [item for item in candidates if seen.get(item["url"], today) == today and item["url"] not in current_urls]
    fresh.sort(key=lambda item: (item["season"] != "Natal", item["supplier"].lower(), item["name"].lower()))
    count = {}
    selected = list(current)
    for item in selected:
        count[item["supplier"]] = count.get(item["supplier"], 0) + 1
    for item in fresh:
        if len(selected) >= 10:
            break
        supplier = item["supplier"]
        if count.get(supplier, 0) >= 3 or identity(item) in used_names:
            continue
        selected.append(item)
        used_names.add(identity(item))
        count[supplier] = count.get(supplier, 0) + 1
    for item in candidates:
        seen.setdefault(item["url"], today)
    today_edition = {"date": today, "items": selected, "sources": stats, "seen": seen}
    target.write_text(json.dumps(today_edition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"date": today, "selected": len(selected), "sources": stats}))


if __name__ == "__main__":
    main()
