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
    ("Brildor", "ES", "https://www.brildor.com/pt/personalizaveis", ".product-item-link, .product-item-name a"),
    ("Brildor", "ES", "https://www.brildor.com/pt/personalizaveis/paineis-sublimacao/madeira", ".product-item-link, .product-item-name a"),
]
PRODUCTS = [
    (r"fotopain|ard[oó]sia|moldura|lumin[aá]ria|\bled\b|luz noturna", "Cria uma peça fotográfica com dedicatória e uma opção com embalagem de oferta", "Famílias, escolas e associações", ""),
    (r"puzzle|quebra.cabe|jogo|domin[oó]", "Transforma uma fotografia ou ilustração original num jogo personalizado", "Escolas, famílias e eventos", ""),
    (r"corti[cç]a|madeira|bambu|\bmdf\b|t[aá]bua|placa|acr[ií]lic", "Prepara uma coleção de placas de porta, marcadores de mesa ou peças de reconhecimento para equipas", "Empresas, eventos e associações", ""),
    (r"lancheir|estojo|necessaire|marmita|organizador|porta.cart[oõ]es|guarda.chuva", "Mostra uma versão com nome e outra com identidade visual para encomendas de equipa", "Empresas, escolas e comércio", ""),
    (r"natal|navidad|advento", "Enfeite ou presente de Natal com nome e ano", "Famílias e empresas", "Natal"),
    (r"camiset|t-shirt|avental|delantal|sweat|gorro|bon[eé]", "Identidade da equipa à frente e nome na manga, por DTF têxtil conforme o tecido", "Equipas, comércio e associações", ""),
    (r"caneca|taza|ch[aá]vena|garrafa|botella|vaso|copo", "Nome e grafismo a condizer com a campanha; confirmar revestimento e técnica", "Empresas, famílias e eventos", ""),
    (r"saco|bolsa|mochila|tote|t[aá]bua|bambu|rel[oó]gio", "Pequena coleção com iniciais e opção de logótipo para encomendas em quantidade", "Comércio, empresas e eventos", ""),
    (r"iman|[ií]m[aã]|moldura|fotopain|azulej|chaveiro|llavero|porta-chaves|puzzle|pulseira|pulsera|cadern|bloco|esferogr[aá]fica", "Edição com nome, data e motivo gráfico alusivo à ocasião", "Famílias, empresas e associações", ""),
]
EXCLUDE = re.compile(r"impresora|impressora|plancha|prensa|recambio|resist[eê]ncia|consum[ií]ve|bobina|papel|tinta|pel[ií]cula|plotter|maquina|m[aá]quina|software|grabadora|cortadora|laserpecker|xTool|engraver|cutter|fecho da|fita term|acess[oó]ri[oa] para prens|repuesto|cabe[cç]al de impress", re.I)
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


def product_family(name):
    return next((index for index, row in enumerate(PRODUCTS) if re.search(row[0], name, re.I)), len(PRODUCTS))


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
    for anchor in anchors[:150]:
        href = urljoin(source, anchor.get("href", ""))
        original = urlsplit(source)
        target = urlsplit(href)
        if target.scheme != "https" or target.hostname != original.hostname or target.path == original.path:
            continue
        href = target._replace(query="", fragment="").geturl()
        price_area = anchor.find_parent(class_=re.compile(r"product-thumb|product-miniature|product-item-info")) or anchor
        price = PRICE.search(price_area.get_text(" ", strip=True))
        image = price_area.select_one("img.product-image-photo, img.attachment-woocommerce_thumbnail, img")
        image_url = urljoin(source, (image.get("data-src") or image.get("src") or "") if image else "")
        if urlsplit(image_url).scheme != "https" or image_url == source:
            image_url = ""
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
            "image": image_url,
            "buyPrice": (price.group().strip() + " no catálogo") if price else "Consultar ficha",
            "sellPrice": "A calcular após portes e personalização",
            "recommendation": "Faz uma amostra e abre pré-encomendas para a campanha " + (match[3] or season) + ".",
        })
    return items


def identity(item):
    return item["supplier"], " ".join(re.findall(r"\w+", item["name"].casefold()))


def select_edition(candidates, previous, today, limit=16):
    available = {item["url"]: item for item in candidates}
    first_seen = previous.get("seen", {})
    last_shown = dict(previous.get("lastShown", {}))
    for item in previous.get("items", []):
        last_shown.setdefault(item["url"], previous.get("date", ""))
    selected = []
    names = set()
    counts = {}
    families = {}

    def add(item):
        selected.append(item)
        names.add(identity(item))
        supplier = item["supplier"]
        family = product_family(item["name"])
        counts[supplier] = counts.get(supplier, 0) + 1
        families[family] = families.get(family, 0) + 1

    if previous.get("date") == today:
        for item in previous.get("items", []):
            current = available.get(item["url"])
            if current and identity(current) not in names and len(selected) < limit:
                add(current)

    current_urls = {entry["url"] for entry in selected}
    remaining = [item for item in candidates if item["url"] not in current_urls]
    while len(selected) < limit:
        eligible = [item for item in remaining if identity(item) not in names]
        if not eligible:
            break
        item = min(eligible, key=lambda entry: (
            last_shown.get(entry["url"], ""),
            counts.get(entry["supplier"], 0),
            families.get(product_family(entry["name"]), 0),
            first_seen.get(entry["url"], today) != today,
            entry["name"].casefold(),
            entry["url"],
        ))
        add(item)
    last_shown.update((item["url"], today) for item in selected)
    return selected, last_shown


def main():
    now = datetime.now(ZoneInfo("Europe/Lisbon"))
    target = Path("oportunidades-diarias.json")
    previous = json.loads(target.read_text()) if target.exists() else {}
    seen = previous.get("seen", {})
    today = now.date().isoformat()
    available = {}
    summaries = {}
    for supplier, country, url, selector in SOURCES:
        summary = summaries.setdefault(supplier, {"supplier": supplier, "country": country,
            "checked": False, "pagesChecked": 0, "pagesUnavailable": 0})
        try:
            items = records(supplier, country, url, selector, campaign(now.month))
            summary["checked"] = True
            summary["pagesChecked"] += 1
            for item in items:
                available.setdefault(item["url"], item)
        except (requests.RequestException, ValueError) as error:
            summary["pagesUnavailable"] += 1
            print(f"{supplier} · {url}: {error}", flush=True)
    candidates = list(available.values())
    stats = list(summaries.values())
    for source in stats:
        source["found"] = sum(item["supplier"] == source["supplier"] for item in candidates)
    if not candidates and previous.get("items"):
        print("Nenhum produto confirmado hoje. A última edição continua disponível.", flush=True)
        return
    selected, last_shown = select_edition(candidates, previous, today)
    for item in candidates:
        seen.setdefault(item["url"], today)
    today_edition = {"date": today, "items": selected, "sources": stats, "seen": seen, "lastShown": last_shown}
    target.write_text(json.dumps(today_edition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"date": today, "selected": len(selected), "sources": stats}))


if __name__ == "__main__":
    main()
