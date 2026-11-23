const get = id => document.getElementById(id)
const key = 'printastic360-opportunities-v1'
const status = get('status')
let editions = {}
try {
  editions = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
} catch {
  // An unusable local archive must not prevent loading the latest edition.
}
const queryKey = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-PT')
const fields = ['name','supplier','country','url','season','idea','audience','buyPrice','sellPrice','recommendation']

function verifiedUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch {
    return null
  }
  return null
}

function show(date) {
  const supplier = get('supplier').value
  const query = queryKey(get('opportunity-search').value.trim())
  const entries = (editions[date] ?? []).filter(item => (!supplier || item.supplier === supplier) &&
    queryKey([item.name, item.idea, item.audience, item.season].join(' ')).includes(query))
  get('results').replaceChildren(...entries.map(item => {
    const card = document.createElement('article')
    const subtitle = document.createElement('small')
    subtitle.textContent = item.country + ' · ' + item.supplier + ' · ' + item.season
    const heading = document.createElement('h2')
    heading.textContent = item.name
    const imageUrl = verifiedUrl(item.image)
    if (imageUrl) {
      const image = document.createElement('img')
      image.className = 'product-image'
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
      image.onerror = () => image.remove()
      image.src = imageUrl
      card.append(image)
    }
    card.append(subtitle, heading)
    for (const value of [item.idea, 'Público · ' + item.audience, 'Compra · ' + item.buyPrice + ' | Venda · ' + item.sellPrice, item.recommendation]) {
      const paragraph = document.createElement('p')
      paragraph.textContent = value
      card.append(paragraph)
    }
    const link = document.createElement('a')
    link.textContent = 'Ver produto no fornecedor'
    link.href = verifiedUrl(item.url)
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    card.append(link)
    return card
  }))
  status.textContent = entries.length
    ? date + ' · ' + entries.length + ' oportunidades'
    : date + ' · Sem oportunidades para estes filtros.'
}

function refresh(date) {
  const dates = Object.keys(editions).sort().reverse()
  get('edition').replaceChildren(...dates.map(value => new Option(value, value)))
  get('edition').value = date
  get('opportunity-tools').hidden = false
  selectEdition(date)
}

function selectEdition(date) {
  const filter = get('supplier')
  const suppliers = [...new Set((editions[date] ?? []).map(item => item.supplier))].sort()
  filter.replaceChildren(new Option('Todos os fornecedores', ''), ...suppliers.map(value => new Option(value)))
  show(date)
}

function saveEdition(text) {
  try {
    if (text.length > 200000) throw new Error('O relatório é demasiado grande.')
    const {date, items} = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(items) || items.length > 16 ||
        !items.every(item => item && fields.every(field => typeof item[field] === 'string') &&
          ['PT','ES'].includes(item.country) && verifiedUrl(item.url)))
      throw new Error('Formato inválido. Usa o JSON da edição do Product Hunter.')
    const next = {...editions, [date]: items}
    try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
    editions[date] = items
    refresh(date)
  } catch (error) {
    status.textContent = error instanceof SyntaxError ? 'Não consegui ler o JSON da edição.' : error.message
  }
}

get('edition').onchange = event => selectEdition(event.target.value)
get('supplier').onchange = () => show(get('edition').value)
get('opportunity-search').oninput = () => show(get('edition').value)
const latest = Object.keys(editions).sort().at(-1)
if (latest) refresh(latest)

async function loadDaily() {
  const indicator = get('automatic')
  try {
    const response = await fetch('https://raw.githubusercontent.com/jaca000/printastic-360/main/oportunidades-diarias.json', {
      cache: 'no-store', signal: AbortSignal.timeout(8000)
    })
    if (!response.ok) throw new Error('Edição indisponível')
    const report = await response.json()
    if (!Array.isArray(report.sources)) throw new Error('Edição inválida')
    saveEdition(JSON.stringify({ date: report.date, items: report.items }))
    const available = report.sources.filter(source => source.checked).map(source => source.supplier + (source.found != null ? ' (' + source.found + ')' : ''))
    const unavailable = report.sources.filter(source => !source.checked).map(source => source.supplier)
    indicator.textContent = 'Pesquisa automática · ' + report.date +
      ' · Verificados: ' + (available.join(', ') || 'nenhum') +
      (unavailable.length ? ' · Indisponíveis: ' + unavailable.join(', ') : '')
  } catch {
    indicator.textContent = 'Edição automática indisponível neste momento.'
  }
}
loadDaily()
