const get = id => document.getElementById(id)
const key = 'printastic360-opportunities-v1'
const status = get('status')
const editions = JSON.parse(localStorage.getItem(key) ?? '{}')
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
  const entries = editions[date]
  get('results').replaceChildren(...entries.map(item => {
    const card = document.createElement('article')
    const subtitle = document.createElement('small')
    subtitle.textContent = item.country + ' · ' + item.supplier + ' · ' + item.season
    const heading = document.createElement('h2')
    heading.textContent = item.name
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
    : date + ' · Sem oportunidades verificadas nesta edição.'
}

function refresh(date) {
  const dates = Object.keys(editions).sort().reverse()
  get('edition').replaceChildren(...dates.map(value => new Option(value, value)))
  get('edition').value = date
  get('archive').hidden = false
  show(date)
}

function importReport(text) {
  try {
    if (text.length > 200000) throw new Error('O relatório é demasiado grande.')
    const {date, items} = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(items) || items.length > 10 ||
        !items.every(item => item && fields.every(field => typeof item[field] === 'string') &&
          ['PT','ES'].includes(item.country) && verifiedUrl(item.url)))
      throw new Error('Formato inválido. Usa o JSON da edição do Product Hunter.')
    const next = {...editions, [date]: items}
    localStorage.setItem(key, JSON.stringify(next))
    editions[date] = items
    refresh(date)
  } catch (error) {
    status.textContent = error instanceof SyntaxError ? 'Não consegui ler o JSON da edição.' : error.message
  }
}

get('file').onchange = async event => {
  const file = event.target.files[0]
  if (!file) return
  if (file.size > 200000) {
    status.textContent = 'O relatório é demasiado grande.'
    return
  }
  importReport(await file.text())
  event.target.value = ''
}
get('paste').onclick = () => importReport(get('pasted').value)
get('edition').onchange = event => show(event.target.value)
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
    importReport(JSON.stringify({ date: report.date, items: report.items }))
    const available = report.sources.filter(source => source.checked).map(source => source.supplier)
    const unavailable = report.sources.filter(source => !source.checked).map(source => source.supplier)
    indicator.textContent = 'Pesquisa automática · ' + report.date +
      ' · Verificados: ' + (available.join(', ') || 'nenhum') +
      (unavailable.length ? ' · Indisponíveis: ' + unavailable.join(', ') : '')
  } catch {
    indicator.textContent = 'Edição automática indisponível neste momento.'
  }
}
loadDaily()
