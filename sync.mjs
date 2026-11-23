import { connectVault } from './vault-client.mjs'

const roundQuantity = value => Math.round(value * 100) / 100
const lineAmount = line => Math.round(Math.round(line.quantity * 100) * line.price / 100)

export function plan(products, orders) {
  const bySku = new Map(products.map(product => [product.sku, product]))
  const stock = new Map(products.map(product => [product.sku, product.stock]))
  const purchases = new Map()
  const queue = orders.map(order => {
    const product = bySku.get(order.sku)
    const reserved = Math.min(stock.get(order.sku), order.quantity)
    stock.set(order.sku, roundQuantity(stock.get(order.sku) - reserved))
    const missing = roundQuantity(order.quantity - reserved)
    if (missing > 0) {
      const purchase = purchases.get(order.sku) ?? { product, quantity: 0, due: order.due }
      purchase.quantity = roundQuantity(purchase.quantity + missing)
      purchases.set(order.sku, purchase)
    }
    return { ...order, product, reserved, missing }
  })
  return { queue, purchases: [...purchases.values()] }
}

const states = { pending: 'Pendente', producing: 'Em produção', ready: 'Pronta', closed: 'Fechada' }
const saleTotal = sale => sale.lines.reduce((sum, line) => sum + lineAmount(line), sale.delivery ?? 0)
const paidTotal = sale => (sale.payments ?? []).reduce((sum, item) => sum + item.amount, 0)
export function orderTotals(orders) {
  const { total, paid } = orders.reduce((sum, sale) => ({
    total: sum.total + saleTotal(sale),
    paid: sum.paid + paidTotal(sale)
  }), { total: 0, paid: 0 })
  return { total, paid, outstanding: total - paid }
}
export function estimatedOrderProfit(orders, products) {
  const catalogue = new Map(products.map(product => [product.sku, product]))
  let profit = 0
  for (const sale of orders) {
    for (const line of sale.lines) {
      if (isDeliveryLine(line)) continue
      const product = catalogue.get(line.sku)
      if (!product || product.cost == null || String(product.cost).trim() === '') return null
      const unitCosts = [product.cost, product.personalization, product.packing, product.shipping]
        .map(value => Number(String(value ?? '').trim().replace(',', '.')))
      if (unitCosts.some(value => !Number.isFinite(value) || value < 0)) return null
      const cost = unitCosts.reduce((sum, value) => sum + Math.round(value * 100), 0)
      profit += lineAmount(line) - lineAmount({ ...line, price: cost })
    }
  }
  return profit
}

const paymentState = sale => paidTotal(sale) >= saleTotal(sale) ? 'paid' : paidTotal(sale) ? 'partial' : 'unpaid'
const paymentLabels = { paid: 'Paga', partial: 'Pagamento parcial', unpaid: 'Por pagar' }

export function orderState(sale, lines) {
  if (sale.closedAt) return 'closed'
  if (lines.length && lines.every(line => line.completed)) return 'ready'
  return sale.startedAt || lines.some(line => line.completed) ? 'producing' : 'pending'
}

function completeLine(line, product) {
  if (line.completed) return
  line.completed = true
  line.fulfilled = roundQuantity((line.fulfilled ?? 0) + line.quantity)
  product.stock = Math.max(0, roundQuantity(product.stock - line.quantity))
}

export function advanceOrder(records, reference, action, timestamp) {
  const sale = records.sales?.find(item => item.kind === 'order' && item.reference === reference)
  if (!sale) throw new Error('Encomenda indisponível.')
  const lines = records.orders.filter(item => item.reference === reference)
  const state = orderState(sale, lines)
  if (action === 'start' && state === 'pending') {
    sale.startedAt = timestamp
  } else if (action === 'ready' && (state === 'pending' || state === 'producing') && lines.length) {
    for (const line of lines.filter(item => !item.completed)) {
      const product = records.products.find(item => item.sku === line.sku)
      if (!product) throw new Error('Um dos produtos já não está no catálogo.')
      completeLine(line, product)
    }
    sale.readyAt = timestamp
  } else if (action === 'close' && state === 'ready') {
    if (paymentState(sale) !== 'paid') throw new Error('Regista o saldo em falta antes de fechar a encomenda.')
    sale.closedAt = timestamp
  } else {
    throw new Error('A ação já não está disponível para esta encomenda.')
  }
}

const isDeliveryLine = line => /^portes(?: de envio)?$/i.test(line.name.trim())

export function moveDelivery(records, reference) {
  const sale = records.sales?.find(item => item.reference === reference && item.kind === 'order')
  if (!sale || sale.closedAt) throw new Error('Encomenda indisponível para alterar os portes.')
  const delivery = sale.lines.filter(isDeliveryLine)
  const remaining = sale.lines.filter(line => !isDeliveryLine(line))
  if (!delivery.length || !remaining.length) throw new Error('A encomenda precisa de ter pelo menos um produto.')
  const skus = new Set(delivery.map(line => line.sku))
  if (remaining.some(line => skus.has(line.sku))) throw new Error('A mesma referência está usada como produto e como portes.')
  sale.delivery = delivery.reduce((sum, line) => sum + lineAmount(line), sale.delivery ?? 0)
  sale.lines = remaining
  records.orders = records.orders.filter(line => line.reference !== reference || !skus.has(line.sku) || line.completed)
}

export function removeProduct(records, sku) {
  const index = records.products.findIndex(item => item.sku === sku)
  if (index < 0) throw new Error('Produto indisponível.')
  const used = records.orders.some(item => item.sku === sku) ||
    records.sales?.some(sale => sale.lines.some(line => line.sku === sku))
  if (used) records.products[index].archived = true
  else records.products.splice(index, 1)
  return used
}

export function editOrder(records, change) {
  const sale = records.sales?.find(item => item.kind === 'order' && item.reference === change.reference)
  if (!sale || (sale.closedAt && paymentState(sale) === 'paid')) throw new Error('Esta encomenda está fechada e paga.')
  if (!change.customer || !/^\d{4}-\d{2}-\d{2}$/.test(change.due) || !change.lines.length ||
      !Number.isSafeInteger(change.delivery) || change.delivery < 0) throw new Error('Revê o cliente, o prazo, os produtos e os portes.')
  const quantities = new Map()
  const previous = records.orders.filter(line => line.reference === sale.reference)
  for (const line of change.lines) {
    const product = records.products.find(item => item.sku === line.sku)
    const quantityValid = line.quantity > 0 && roundQuantity(line.quantity) === line.quantity &&
      (product?.unit === 'meter' || Number.isInteger(line.quantity))
    if (!product || (product.archived && !sale.lines.some(item => item.sku === line.sku)) ||
        !quantityValid || !Number.isSafeInteger(line.price) || line.price < 0) throw new Error('Revê os produtos e os preços.')
    quantities.set(line.sku, roundQuantity((quantities.get(line.sku) ?? 0) + line.quantity))
  }
  if (saleTotal(change) < paidTotal(sale)) throw new Error('O total da encomenda não pode ficar abaixo do valor já recebido.')
  const fulfilled = new Map(Object.entries(sale.fulfilled ?? {}))
  for (const row of previous) {
    if (row.completed) fulfilled.set(row.sku, Math.max(fulfilled.get(row.sku) ?? 0, row.fulfilled ?? row.quantity))
  }
  const rows = [...quantities].map(([sku, total]) => {
    const done = fulfilled.get(sku) ?? 0
    const remaining = Math.max(0, roundQuantity(total - done))
    return { reference: sale.reference, customer: change.customer, due: change.due, notes: change.notes,
      sku, quantity: remaining, fulfilled: done, completed: remaining === 0 }
  })
  if (rows.some(row => !row.completed)) delete sale.readyAt
  if (rows.some(row => !row.completed) && fulfilled.size && !sale.startedAt) sale.startedAt = new Date().toISOString()
  Object.assign(sale, { customer: change.customer, customerInfo: change.customerInfo, due: change.due, notes: change.notes,
    delivery: change.delivery, lines: change.lines, fulfilled: Object.fromEntries(fulfilled) })
  records.orders = records.orders.filter(line => line.reference !== sale.reference).concat(rows)
}

if (typeof document !== 'undefined') start()

function start() {
  const element = id => document.getElementById(id)
  const money = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' })
  const dateLabel = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeZone: 'Europe/Lisbon' })
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Lisbon' }).format()
  let busy = false

  const vaultKey = 'printastic360-production-vault-v1'
  const localLogin = element('local-login')
  const passField = localLogin.elements.password
  const encode = bytes => btoa(String.fromCharCode(...bytes))
  const decode = string => Uint8Array.from(atob(string), char => char.charCodeAt(0))
  const encoder = new TextEncoder()
  let vaultSession
  const tabSessionKey = 'printastic360-tab-session-v1'
  const tabSessionDuration = 8 * 60 * 60 * 1000
  const vaultEndpoint = 'https://198.245.56.245'
  const encryption = { name: 'AES-GCM', length: 256 }

  function tabSession(value) {
    try {
      if (value === null) sessionStorage.removeItem(tabSessionKey)
      else if (value !== undefined) sessionStorage.setItem(tabSessionKey, JSON.stringify(value))
      else return JSON.parse(sessionStorage.getItem(tabSessionKey))
    } catch {
      return null
    }
  }

  const menu = element('app-menu')
  const frame = element('app-view')
  const tabs = [...menu.querySelectorAll('[data-view]')]
  const screens = {
    opportunities: { url: './oportunidades.html?panel=1', title: 'Oportunidades' },
    studio: { url: './mockup.html?panel=1', title: 'Estúdio de mockups' }
  }
  let view
  let catalogue = []
  let productsForProfit = []
  let savedSales = []
  let savedOrderHistory = []
  let productionLines = []
  let savedClients = []

  function selectView(next, reload = false) {
    if (!vaultSession || menu.hidden) return
    for (const tab of tabs) {
      const active = tab.dataset.view === next
      tab.classList.toggle('active', active)
      if (active) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
    element('workspace').hidden = next !== 'production'
    element('products-area').hidden = next !== 'products'
    element('clients-area').hidden = next !== 'clients'
    element('reports-area').hidden = next !== 'reports'
    if (next === 'clients') renderClients()
    if (next === 'reports') renderReport()
    const salesView = next === 'orders' || next === 'quotes'
    element('sales-area').hidden = !salesView
    if (salesView && view !== next) {
      resetSale(next)
      renderSales(next)
    }
    frame.hidden = !screens[next]
    if (screens[next] && (view !== next || reload)) {
      frame.title = screens[next].title
      frame.src = screens[next].url
    } else if (!screens[next]) {
      frame.removeAttribute('src')
    }
    view = next
    const anchor = tabs.find(tab => tab.dataset.view === next)?.hash
    if (anchor && location.hash !== anchor) history.replaceState(history.state, '', anchor)
  }

  for (const tab of tabs) {
    tab.onclick = event => {
      event.preventDefault()
      if (tab.dataset.view === 'studio' && view !== 'studio') {
        sessionStorage.removeItem('printastic360-mockup-product')
      sessionStorage.removeItem('printastic360-mockup-photo')
      }
      selectView(tab.dataset.view)
    }
  }

  function loginState(open, initialView = 'production') {
    menu.hidden = !open
    element('access-copy').hidden = open
    if (open) {
      selectView(initialView)
    } else {
      frame.hidden = true
      frame.removeAttribute('src')
      sessionStorage.removeItem('printastic360-mockup-product')
      sessionStorage.removeItem('printastic360-mockup-photo')
      element('products-area').hidden = true
      element('sales-area').hidden = true
      element('clients-area').hidden = true
      element('reports-area').hidden = true
      view = undefined
    }
    localLogin.hidden = open
    element('lock').hidden = !open
  }

  async function readVault(session) {
    const record = JSON.parse(session.body)
    if (!record || record.salt !== session.salt) throw new Error('Desbloqueia novamente os registos.')
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(record.iv) }, session.key, decode(record.data)
    )
    return JSON.parse(new TextDecoder().decode(data))
  }

  async function saveVault(session, records) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, encoder.encode(JSON.stringify(records)))
    const bytes = new Uint8Array(data)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    const body = JSON.stringify({ salt: session.salt, iv: encode(iv), data: btoa(binary) })
    const revision = await session.remote.write(body, session.revision)
    session.body = body
    session.revision = revision
  }

  async function access({ password, remembered }) {
    const material = remembered ? null :
      await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    const derive = salt => crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, 256
    )
    const token = remembered?.token ?? encode(new Uint8Array(await derive(
      encoder.encode('Printastic 360 API login v1 | 198.245.56.245')
    ))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const remote = connectVault(vaultEndpoint, token)
    const stored = await remote.read()
    if (!stored) throw new Error('O servidor ainda não tem uma cópia dos registos.')
    const { salt } = JSON.parse(stored.body)
    if (remembered && remembered.salt !== salt) throw new Error('Desbloqueia novamente os registos.')
    const rawKey = remembered ? decode(remembered.key) : new Uint8Array(await derive(decode(salt)))
    const key = await crypto.subtle.importKey('raw', rawKey, encryption, false, ['encrypt', 'decrypt'])
    const session = { remote, ...stored, salt, key }
    await readVault(session)
    if (!remembered) tabSession({ token, salt, key: encode(rawKey), expires: Date.now() + tabSessionDuration })
    return session
  }

  async function unlock(credentials) {
    const initialView = tabs.find(tab => tab.hash === location.hash)?.dataset.view
    vaultSession = await access(credentials)
    try {
      await refresh()
      loginState(true, initialView)
    } catch (error) {
      vaultSession = undefined
      tabSession(null)
      loginState(false)
      throw error
    }
  }

  async function browserData(path, data) {
    if (!vaultSession) throw new Error('Desbloqueia primeiro os registos.')
    return navigator.locks.request(vaultKey, () => updateBrowserData(path, data))
  }

  async function updateBrowserData(path, data) {
    const records = await readVault(vaultSession)
    if (!data) return {
      products: records.products,
      sales: records.sales ?? [],
      orderHistory: records.orderHistory ?? [],
      clients: records.clients ?? [],
      productionLines: records.orders,
      orders: records.orders.filter(order => !order.completed).sort((a, b) =>
        a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference) || a.sku.localeCompare(b.sku))
    }
    for (const key of ['sku', 'name', 'supplier', 'reference', 'customer', 'notes']) {
      if (typeof data[key] === 'string') data[key] = data[key].trim()
    }
    if (path === '/commercial-followup') {
      const client = records.clients?.find(item => item.id === data.id)
      if (!client || !commercialStates.includes(data.state) || !validDay(data.next) ||
          data.next <= today()) throw new Error('Escolhe uma data futura para o seguimento.')
      client.commercial ??= []
      client.commercial.push({ key: data.key, state: data.state, next: data.next, date: today() })
    } else if (path === '/import-clients') {
      records.clients ??= []
      const existing = new Set(records.clients.map(item => clientKey(item.name)))
      let imported = 0
      let duplicates = 0
      let invalid = 0
      for (const row of data.rows) {
        const key = clientKey(row.name)
        if (!key) {
          invalid++
          continue
        }
        if (existing.has(key)) {
          duplicates++
          continue
        }
        existing.add(key)
        records.clients.push({ ...row, id: crypto.randomUUID() })
        imported++
      }
      if (imported) await saveVault(vaultSession, records)
      return { imported, duplicates, invalid }
    } else if (path === '/clients') {
      records.clients ??= []
      for (const key of ['id', 'name', 'email', 'phone', 'tax', 'address', 'notes']) data[key] = data[key].trim()
      if (!data.name) throw new Error('Indica o nome do cliente.')
      const duplicate = records.clients.some(item => item.id !== data.id && item.name.toLocaleLowerCase('pt') === data.name.toLocaleLowerCase('pt'))
      if (duplicate) throw new Error('Já existe uma ficha com este nome.')
      const index = records.clients.findIndex(item => item.id === data.id)
      if (index < 0) records.clients.push({ ...data, id: crypto.randomUUID() })
      else records.clients[index] = { ...records.clients[index], ...data }
    } else if (path === '/order-state') {
      advanceOrder(records, data.reference, data.action, new Date().toISOString())
    } else if (path === '/invoice-status') {
      const sale = records.sales?.find(item => item.kind === 'order' && item.reference === data.reference)
      if (!sale || typeof data.issued !== 'boolean') throw new Error('Encomenda indisponível.')
      const number = data.issued ? String(data.number ?? '').trim() : ''
      if (number.length > 120) throw new Error('O número da fatura pode ter até 120 caracteres.')
      sale.invoiceIssued = data.issued
      sale.invoiceNumber = number
    } else if (path === '/payment') {
      const sale = (records.sales ?? []).find(item => item.reference === data.reference && item.kind === 'order')
      const method = ['MB WAY', 'Transferência', 'Numerário'].includes(data.method)
      if (!sale || sale.closedAt || !method || !Number.isSafeInteger(data.amount) || data.amount <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('Revê os dados do pagamento.')
      sale.payments ??= []
      const outstanding = saleTotal(sale) - sale.payments.reduce((sum, item) => sum + item.amount, 0)
      if (data.amount > outstanding) throw new Error('O pagamento ultrapassa o saldo da encomenda.')
      sale.payments.push({ amount: data.amount, method: data.method, date: data.date })
    } else if (path === '/sales' || path === '/convert') {
      saveSale(records, path, data)
    } else if (path === '/edit-order') {
      const previous = records.sales?.find(item => item.reference === data.reference)
      const customerInfo = previous?.customer === data.customer ? previous.customerInfo :
        records.clients?.find(item => item.name === data.customer)
      editOrder(records, { ...data, customerInfo })
    } else if (path === '/move-delivery') {
      moveDelivery(records, data.reference)
    } else if (path === '/remove-product') {
      const archived = removeProduct(records, data.sku)
      await saveVault(vaultSession, records)
      return { archived }
    } else if (path === '/restore-product') {
      const product = records.products.find(item => item.sku === data.sku)
      if (!product?.archived) throw new Error('Produto indisponível.')
      delete product.archived
    } else if (path === '/products') {
      if (!data.sku || !data.name || !data.supplier)
        throw new Error('Preenche a referência, o nome e o fornecedor.')
      if (data.url && !httpsUrl(data.url)) throw new Error('Indica um link HTTPS válido ou deixa o campo vazio.')
      data.unit = data.unit === 'meter' ? 'meter' : 'piece'
      if (!Number.isFinite(data.stock) || data.stock < 0 || roundQuantity(data.stock) !== data.stock ||
          (data.unit === 'piece' && !Number.isInteger(data.stock)))
        throw new Error('Indica o stock na unidade de venda do produto.')
      if (data.baseCost?.trim()) data.cost = (Math.round(cents(data.baseCost) * 123 / 100) / 100).toFixed(2)
      data.cost = data.cost.trim().replace(',', '.')
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(data.cost))
        throw new Error('Indica um custo válido com até duas casas decimais.')
      data.sell = data.sell?.trim() || ''
      if (data.sell) data.sell = cents(data.sell) / 100
      const index = records.products.findIndex(product => product.sku === data.sku)
      if (index >= 0 && (records.products[index].unit ?? 'piece') !== data.unit &&
          (records.orders.some(order => order.sku === data.sku) ||
           records.sales?.some(sale => sale.lines.some(line => line.sku === data.sku))))
        throw new Error('Este produto já tem registos. Cria uma nova referência para mudar a unidade de venda.')
      data.photo ??= records.products[index]?.photo
      if (data.photoUrl === '') data.photoUrl = records.products[index]?.photoUrl
      if (records.products[index]?.archived) data.archived = true
      if (data.photo) delete data.photoUrl
      if (index < 0) records.products.push(data)
      else records.products[index] = data
    } else {
      const product = records.products.find(item => item.sku === data.sku)
      if (!product || !data.reference) throw new Error('Indica a encomenda e um produto do catálogo.')
      const index = records.orders.findIndex(item => item.reference === data.reference && item.sku === data.sku)
      const previous = records.orders[index]
      if (path === '/close') {
        if (previous) completeLine(previous, product)
      } else {
        if (!validQuantity(data.quantity, product.unit)) throw new Error('Indica a quantidade na unidade de venda.')
        if (product.archived && !previous) throw new Error('Seleciona um produto ativo.')
        if (!data.customer) throw new Error('Indica o cliente.')
        if (previous?.completed) throw new Error('Esta linha já está concluída.')
        if (index < 0) records.orders.push(data)
        else records.orders[index] = data
      }
    }
    await saveVault(vaultSession, records)
    return { ok: true }
  }

  loginState(false)
  localLogin.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      try {
        await unlock({ password: passField.value })
      } finally {
        localLogin.reset()
      }
    }, 'Área de produção desbloqueada.')
  }

  element('lock').onclick = () => run(async () => {
    tabSession(null)
    vaultSession = undefined
    element('workspace').hidden = true
    catalogue = []
    productsForProfit = []
    savedSales = []
    savedOrderHistory = []
    productionLines = []
    savedClients = []
    clearProductLookup()
    element('client-form').reset()
    element('odoo-form').reset()
    element('odoo-result').textContent = ''
    for (const id of ['client-list', 'report-metrics', 'report-list']) element(id).replaceChildren()
    element('sales-form').reset()
    element('sales-lines').replaceChildren()
    element('sales-list').replaceChildren()
    element('clients').replaceChildren()
    element('legacy-edit').hidden = true
    element('payment-dialog').close()
    element('payment-form').reset()
    paymentReference = undefined
    for (const id of ['queue', 'purchases', 'catalog']) element(id).replaceChildren()
    for (const id of ['product', 'order']) element(id).reset()
    element('order').elements.sku.replaceChildren()
    loginState(false)
    passField.focus()
  }, 'Área de produção bloqueada.')

  element('backup').onclick = () => run(async () => {
    const data = vaultSession?.body
    if (!vaultSession || !data) throw new Error('Desbloqueia primeiro os registos.')
    const url = URL.createObjectURL(new Blob([data], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = 'printastic360-cifrado-' + today() + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'Cópia preparada.')

  function api(path = '', data) {
    return browserData(path, data)
  }

  function node(tag, content) {
    const item = document.createElement(tag)
    item.textContent = content
    return item
  }

  function list(id, items, empty, render) {
    element(id).replaceChildren(...(items.length ? items.map(render) : [node('p', empty)]))
  }

  function edit(id, data) {
    if (id === 'product') clearProductLookup()
    const form = element(id)
    for (const field of form.elements) {
      if (Object.hasOwn(data, field.name)) field.value = data[field.name]
    }
    if (id === 'product' && fields.sell.value) {
      pricingSource = 'price'
      updateSuggested()
    }
    form.closest('details').open = true
    form.querySelector('input').focus()
  }

  function button(label, action) {
    const control = node('button', label)
    control.type = 'button'
    control.onclick = action
    return control
  }

  let editingSale
  const salesForm = element('sales-form')

  function cents(value) {
    const string = String(value).trim().replace(',', '.')
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(string)) throw new Error('Indica um preço válido com até duas casas decimais.')
    const [units, decimals = ''] = string.split('.')
    return Number(units) * 100 + Number(decimals.padEnd(2, '0'))
  }

  function validQuantity(value, unit) {
    return Number.isFinite(value) && value > 0 && value <= 1000000 &&
      (unit === 'meter' ? roundQuantity(value) === value : Number.isInteger(value))
  }

  function saleQuantity(row) {
    const product = (row.originalProduct?.sku === row.querySelector('[name=sku]').value ? row.originalProduct : undefined) ?? catalogue.find(item => item.sku === row.querySelector('[name=sku]').value)
    const input = Number(row.querySelector('[name=quantity]').value)
    return { quantity: product?.unit === 'meter' ? input / 100 : input, unit: product?.unit ?? 'piece' }
  }

  function formatQuantity(quantity, unit) {
    return unit === 'meter' ? new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2 }).format(quantity) + ' m' :
      new Intl.NumberFormat('pt-PT').format(quantity)
  }

  function saveSale(records, path, data) {
    records.sales ??= []
    const duplicate = records.sales.some(sale => sale.reference === data.reference) ||
      records.orders.some(order => order.reference === data.reference)
    const quote = path === '/convert' ? records.sales.find(sale => sale.reference === data.reference) : null
    if (path === '/convert' && (!quote || quote.kind !== 'quote' || quote.converted))
      throw new Error('Este orçamento já foi convertido ou não está disponível.')
    if (path === '/sales' && duplicate) throw new Error('A referência já foi utilizada.')
    const customerInfo = (records.clients ?? []).find(item => item.name === data.customer)
    const source = quote ?? { ...data, customerInfo }
    if (!source.reference || !source.customer || !/^\d{4}-\d{2}-\d{2}$/.test(source.due) || !source.lines.length)
      throw new Error('Preenche a referência, o cliente, o prazo e pelo menos um produto.')
    const delivery = source.delivery ?? 0
    if (!Number.isSafeInteger(delivery) || delivery < 0) throw new Error('Indica um valor de portes válido.')
    const quantities = new Map()
    for (const line of source.lines) {
      const product = records.products.find(product => product.sku === line.sku)
      if (!product || (product.archived && !quote) || !validQuantity(line.quantity, product.unit) ||
          !Number.isSafeInteger(line.price) || line.price < 0)
        throw new Error('Revê os produtos, as quantidades e os preços.')
      quantities.set(line.sku, roundQuantity((quantities.get(line.sku) ?? 0) + line.quantity))
    }
    const reference = quote ? 'ENC-' + quote.reference : source.reference
    if (quote && (records.sales.some(sale => sale.reference === reference) ||
                  records.orders.some(order => order.reference === reference)))
      throw new Error('A referência da encomenda já existe.')
    if (!quote && source.kind === 'quote') {
      records.sales.push(source)
      return
    }
    records.sales.push({ ...source, reference, kind: 'order', converted: false, createdAt: today() })
    for (const [sku, quantity] of quantities) {
      records.orders.push({ reference, customer: source.customer, due: source.due,
        notes: source.notes, sku, quantity })
    }
    if (quote) quote.converted = true
  }

  function salesTotal() {
    try {
      const total = [...element('sales-lines').children].reduce((sum, row) => {
        return sum + lineAmount({ ...saleQuantity(row), price: cents(row.querySelector('[name=price]').value) })
      }, cents(salesForm.elements.delivery.value.trim() || '0'))
      element('sales-total').textContent = 'Total ' + money.format(total / 100)
    } catch {
      element('sales-total').textContent = 'Total —'
    }
  }

  function addSaleLine(line) {
    const row = element('sales-line').content.firstElementChild.cloneNode(true)
    const select = row.querySelector('select')
    const price = row.querySelector('[name=price]')
    select.append(new Option('Selecionar produto', ''), ...catalogue.map(item => new Option(item.name, item.sku)))
    select.onchange = () => {
      const item = catalogue.find(product => product.sku === select.value)
      const byMeter = item?.unit === 'meter'
      row.querySelector('[data-quantity-label]').textContent = byMeter ? 'Comprimento (cm)' : 'Quantidade'
      row.querySelector('[data-price-label]').textContent = byMeter ? 'Preço por metro (€)' : 'Preço unitário (€)'
      row.querySelector('[name=quantity]').value = byMeter ? '100' : '1'
      price.value = item?.sell === '' || item?.sell == null ? '' : String(item.sell)
      salesTotal()
    }
    if (line) {
      row.originalProduct = { sku: line.sku, unit: line.unit }
      if (!catalogue.some(item => item.sku === line.sku)) select.add(new Option(line.name, line.sku))
      select.value = line.sku
      select.onchange()
      row.querySelector('[data-quantity-label]').textContent = line.unit === 'meter' ? 'Comprimento (cm)' : 'Quantidade'
      row.querySelector('[data-price-label]').textContent = line.unit === 'meter' ? 'Preço por metro (€)' : 'Preço unitário (€)'
      row.querySelector('[name=quantity]').value = line.unit === 'meter' ? Math.round(line.quantity * 100) : line.quantity
      price.value = (line.price / 100).toFixed(2)
    }
    row.querySelector('[data-remove]').onclick = () => {
      if (element('sales-lines').children.length === 1) return
      row.remove()
      salesTotal()
    }
    element('sales-lines').append(row)
    salesTotal()
  }

  function resetSale(next) {
    const quote = next === 'quotes'
    editingSale = undefined
    salesForm.reset()
    salesForm.elements.reference.readOnly = false
    element('cancel-order-edit').hidden = true
    element('sales-lines').replaceChildren()
    element('legacy-edit').hidden = true
    element('new-order').hidden = quote
    element('sale-editor').hidden = !quote
    element('sale-editor').open = quote
    element('sales-title').textContent = quote ? 'Novo orçamento' : 'Nova encomenda'
    element('sales-list-title').textContent = quote ? 'Orçamentos registados' : 'Encomendas registadas'
    element('save-sales').textContent = quote ? 'Guardar orçamento' : 'Guardar encomenda'
    salesForm.elements.reference.value = (quote ? 'ORC-' : 'ENC-') + today().replaceAll('-', '') + '-' +
      crypto.randomUUID().slice(0, 6).toUpperCase()
    addSaleLine()
  }

  function openOrderEditor(sale) {
    resetSale('orders')
    editingSale = sale
    for (const name of ['reference', 'customer', 'due', 'notes'])
      salesForm.elements[name].value = sale[name] ?? ''
    salesForm.elements.reference.readOnly = true
    salesForm.elements.delivery.value = sale.delivery ? (sale.delivery / 100).toFixed(2) : ''
    element('sales-lines').replaceChildren()
    sale.lines.forEach(addSaleLine)
    element('sales-title').textContent = 'Editar encomenda ' + sale.reference
    element('save-sales').textContent = 'Guardar alterações'
    element('cancel-order-edit').hidden = false
    element('sale-editor').hidden = false
    element('sale-editor').open = true
    salesForm.elements.customer.focus()
  }

  element('cancel-order-edit').onclick = () => resetSale('orders')

  let paymentReference
  const paymentForm = element('payment-form')

  function openPayment(sale) {
    paymentReference = sale.reference
    paymentForm.reset()
    paymentForm.elements.date.value = today()
    paymentForm.elements.amount.value = ((saleTotal(sale) - paidTotal(sale)) / 100).toFixed(2).replace('.', ',')
    element('payment-context').textContent = sale.reference + ' · Saldo por pagar ' + money.format((saleTotal(sale) - paidTotal(sale)) / 100)
    element('payment-dialog').showModal()
  }

  element('cancel-payment').onclick = () => element('payment-dialog').close()
  paymentForm.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      const form = paymentForm.elements
      await api('/payment', { reference: paymentReference, amount: cents(form.amount.value),
        method: form.method.value, date: form.date.value })
      element('payment-dialog').close()
      await refresh()
    }, 'Pagamento registado.')
  }

  function printSale(sale) {
    const printWindow = window.open('', '_blank')
    if (!printWindow) throw new Error('Permite abrir a janela do documento.')
    printWindow.opener = null
    const doc = printWindow.document
    doc.title = 'Printastic 360 · ' + sale.reference
    doc.documentElement.lang = 'pt-PT'
    const style = doc.createElement('style')
    style.textContent = `
      :root{color:#182747;font:15px system-ui,sans-serif}
      *{box-sizing:border-box}
      body{max-width:820px;margin:32px auto;padding:0 28px}
      p,h1,h2{margin:0}
      header{display:flex;align-items:center;justify-content:space-between;gap:24px;
        border-bottom:4px solid #bc4387;padding-bottom:18px}
      .brand{display:grid;place-items:center;width:122px;min-width:102px;padding:12px;
        background:#11489e;border-radius:12px;print-color-adjust:exact}
      .brand img{display:block;width:100%;height:auto}
      .identity{text-align:right;min-width:0}
      h1{font-size:clamp(1.35rem,4vw,2rem);letter-spacing:-.035em;line-height:1.15}
      .reference{font-size:.85rem;font-weight:650;color:#52617a;overflow-wrap:anywhere;margin-top:6px}
      .customer{margin:24px 0;line-height:1.55;overflow-wrap:anywhere}
      .customer h2{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#52617a}
      .customer p:first-of-type{font-size:1.1rem;font-weight:700}
      table{border-collapse:collapse;width:100%}
      th,td{padding:10px 8px;border-bottom:1px solid #d6e1ef;text-align:left}
      th{font-size:.78rem;background:#edf4ff;color:#164580;print-color-adjust:exact}
      th:not(:first-child),td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
      td:not(:first-child){white-space:nowrap}
      td:first-child{overflow-wrap:anywhere}
      tr{break-inside:avoid}
      .amounts{margin:18px 0 0 auto;width:min(100%,285px);break-inside:avoid}
      .amount-row{display:flex;justify-content:space-between;gap:14px;padding:7px 0}
      .grand{border-top:2px solid #164580;margin-top:5px;padding-top:10px;font-size:1.3rem;font-weight:750}
      footer{margin-top:32px;border-top:1px solid #d6e1ef;padding-top:10px;color:#52617a;font-size:.8rem}
      button{font:inherit;font-weight:700;background:#11489e;color:white;border:0;border-radius:8px;padding:10px 14px;margin-top:20px;cursor:pointer}
      @page{size:A4;margin:14mm}
      @media print{body{margin:0;padding:0;max-width:none}button{display:none}}
      @media screen and (max-width:460px){body{padding:0 14px}header{gap:12px}th,td{padding:8px 4px}table{font-size:.85rem}}
    `
    doc.head.append(style)
    const add = (root, tag, value = '', className) => {
      const item = doc.createElement(tag)
      item.textContent = value
      if (className) item.className = className
      root.append(item)
      return item
    }
    const header = add(doc.body, 'header')
    const logo = add(add(header, 'div', '', 'brand'), 'img')
    logo.alt = 'Printastic_AL'
    logo.src = new URL('./logo-printastic-al.png', location.href).href
    const identity = add(header, 'div', '', 'identity')
    add(identity, 'h1', sale.kind === 'quote' ? 'Orçamento' : 'Nota de encomenda')
    add(identity, 'p', sale.reference, 'reference')
    const customerBlock = add(doc.body, 'section', '', 'customer')
    add(customerBlock, 'h2', 'Cliente')
    add(customerBlock, 'p', sale.customer)
    const customer = sale.customerInfo
    if (customer?.tax) add(customerBlock, 'p', 'NIF ' + customer.tax)
    if (customer?.address) add(customerBlock, 'p', customer.address)
    if (customer?.email || customer?.phone)
      add(customerBlock, 'p', [customer.email, customer.phone].filter(Boolean).join(' · '))

    const table = add(doc.body, 'table')
    const headings = add(add(table, 'thead'), 'tr')
    for (const value of ['Produto', 'Quantidade', 'Preço unitário', 'Total'])
      add(headings, 'th', value).scope = 'col'
    const rows = add(table, 'tbody')
    for (const line of sale.lines) {
      const row = add(rows, 'tr')
      const unitPrice = money.format(line.price / 100) + (line.unit === 'meter' ? '/m' : '')
      for (const value of [line.name, formatQuantity(line.quantity, line.unit), unitPrice,
        money.format(lineAmount(line) / 100)]) add(row, 'td', value)
    }

    const amounts = add(doc.body, 'section', '', 'amounts')
    const total = saleTotal(sale)
    const amountRow = (label, cents, grand = false) => {
      const row = add(amounts, 'p', '', grand ? 'amount-row grand' : 'amount-row')
      add(row, 'span', label)
      add(row, 'strong', money.format(cents / 100))
    }
    if (sale.delivery) {
      amountRow('Subtotal', total - sale.delivery)
      amountRow('Portes de envio', sale.delivery)
    }
    amountRow('Total', total, true)
    add(doc.body, 'footer', 'Documento comercial sem valor de fatura.')
    const print = add(doc.body, 'button', 'Imprimir ou guardar em PDF')
    print.onclick = () => printWindow.print()
  }

  const currentOrderState = sale => orderState(sale, productionLines.filter(line => line.reference === sale.reference))

  function badge(label, state) {
    const item = node('span', label)
    item.className = 'order-badge ' + state
    return item
  }

  function orderAction(sale, label, action, message) {
    return button(label, () => run(async () => {
      await api('/order-state', { reference: sale.reference, action })
      await refresh()
    }, message))
  }

  const orderSearchKey = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-PT')

  function sortOrders(a, b, sort) {
    const deadline = () => (a.due || '9999').localeCompare(b.due || '9999')
    const recent = () => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    const client = () => a.customer.localeCompare(b.customer, 'pt-PT', { sensitivity: 'base' })
    if (sort === 'client') return client() || deadline() || a.reference.localeCompare(b.reference)
    if (sort === 'recent') return recent() || deadline() || a.reference.localeCompare(b.reference)
    return Number(Boolean(a.closedAt)) - Number(Boolean(b.closedAt)) ||
      (a.closedAt && b.closedAt ? b.closedAt.localeCompare(a.closedAt) : deadline()) ||
      client() || a.reference.localeCompare(b.reference)
  }

  function renderSales(next) {
    if (next !== 'quotes' && next !== 'orders') return
    const quote = next === 'quotes'
    const clients = new Set([...savedClients.map(client => client.name), ...savedSales.map(sale => sale.customer)])
    element('clients').replaceChildren(...[...clients].sort().map(client => new Option(client)))
    element('order-tools').hidden = quote
    const count = element('order-count')
    count.hidden = quote
    const filter = element('order-filter').value
    const terms = orderSearchKey(element('order-search').value).trim().split(/\s+/).filter(Boolean)
    const openOrders = new Set([...element('sales-list').children]
      .filter(card => card.querySelector('.order-details[open]')).map(card => card.dataset.orderReference))
    const sales = savedSales.filter(sale => sale.kind === (quote ? 'quote' : 'order') &&
      (quote || filter === 'all' || (filter === 'active' ? !sale.closedAt : currentOrderState(sale) === filter))).reverse()
    if (!quote) {
      const sort = element('order-sort').value
      sales.sort((a, b) => sortOrders(a, b, sort))
      if (terms.length) {
        const matches = sales.filter(sale => {
          const text = orderSearchKey([sale.customer, sale.reference, sale.invoiceNumber,
            ...sale.lines.flatMap(line => [line.name, line.sku])].join(' '))
          return terms.every(term => text.includes(term))
        })
        sales.splice(0, sales.length, ...matches)
      }
      count.textContent = sales.length + (sales.length === 1 ? ' encomenda' : ' encomendas')
    }
    const totals = element('order-totals')
    totals.hidden = quote
    if (!quote) {
      const { total, paid, outstanding } = orderTotals(sales)
      const profitBox = element('order-profit')
      if (profitBox) {
        const profit = estimatedOrderProfit(sales, productsForProfit)
        profitBox.textContent = profit === null ? '—' : money.format(profit / 100)
        element('order-profit-note').textContent = profit === null
          ? 'Faltam custos no catálogo.'
          : 'Custos atuais do catálogo. Exclui portes cobrados à parte.'
      }
      for (const [name, amount] of Object.entries({ total, paid, outstanding })) {
        totals.querySelector('[data-total="' + name + '"]').textContent = money.format(amount / 100)
      }
    }
    list('sales-list', sales, quote ? 'Ainda não há orçamentos.' : 'Nenhuma encomenda corresponde à pesquisa e ao estado selecionados.', sale => {
      const card = node('article', '')
      if (!quote) {
        card.dataset.orderReference = sale.reference
        card.tabIndex = -1
      }
      const total = saleTotal(sale)
      if (quote) card.append(node('strong', sale.reference + ' · ' + sale.customer),
        node('p', 'Prazo ' + dateLabel.format(new Date(sale.due)) + ' · ' + money.format(total / 100)))
      let actions = card
      if (!quote) {
        const disclosure = node('details', '')
        disclosure.className = 'order-details'
        disclosure.open = openOrders.has(sale.reference)
        const summary = node('summary', '')
        summary.className = 'order-summary'
        const identity = node('span', '')
        identity.className = 'order-identity'
        identity.append(node('strong', sale.customer), node('small', sale.reference))
        const due = sale.due ? dateLabel.format(new Date(sale.due)) : 'Sem prazo'
        const deadline = node('span', due)
        deadline.className = 'order-deadline'
        const current = today()
        if (sale.due && !sale.closedAt && sale.due <= current) {
          deadline.textContent += sale.due < current ? ' · Em atraso' : ' · Hoje'
          if (sale.due < current) deadline.classList.add('late')
        }
        const value = node('span', money.format(total / 100))
        value.append(node('span', ''))
        value.lastChild.className = 'order-expand'
        summary.append(identity, deadline, value)
        actions = node('div', '')
        actions.className = 'order-panel'
        disclosure.append(summary, actions)
        card.append(disclosure)
      }
      const details = node(quote ? 'details' : 'div', '')
      details.append(node(quote ? 'summary' : 'h3', 'Produtos e histórico'))
      for (const line of sale.lines) details.append(node('p', formatQuantity(line.quantity, line.unit) + ' × ' + line.name))
      if (sale.delivery) details.append(node('p', 'Portes de envio · ' + money.format(sale.delivery / 100)))
      if (!quote && !sale.closedAt && sale.lines.some(isDeliveryLine) && sale.lines.some(line => !isDeliveryLine(line))) {
        details.append(button('Mover linha de portes para Portes de envio', () => run(async () => {
          await api('/move-delivery', { reference: sale.reference })
          await refresh()
        }, 'Portes separados. O total da encomenda foi mantido.')))
      }
      if (sale.notes) details.append(node('p', sale.notes))
      if (!quote) {
        const paid = paidTotal(sale)
        const state = currentOrderState(sale)
        const payment = paymentState(sale)
        const badges = node('div', '')
        badges.className = 'order-badges'
        badges.append(badge(states[state], state), badge(paymentLabels[payment], payment))
        badges.append(badge(sale.invoiceIssued ? 'Fatura emitida' : 'Fatura por emitir',
          sale.invoiceIssued ? 'paid' : 'pending'))
        const invoice = node('form', '')
        invoice.className = 'invoice-toggle'
        const label = node('label', '')
        const checkbox = node('input', '')
        checkbox.type = 'checkbox'
        checkbox.checked = Boolean(sale.invoiceIssued)
        label.append(checkbox, node('span', 'Fatura emitida'))
        const numberLabel = node('label', 'N.º da fatura')
        numberLabel.hidden = !checkbox.checked
        const number = node('input', '')
        number.type = 'text'
        number.maxLength = 120
        number.value = sale.invoiceNumber ?? ''
        numberLabel.append(number)
        const saveInvoice = node('button', 'Guardar fatura')
        saveInvoice.type = 'submit'
        saveInvoice.hidden = true
        checkbox.onchange = () => {
          numberLabel.hidden = !checkbox.checked
          saveInvoice.hidden = false
          if (checkbox.checked) number.focus()
        }
        number.oninput = () => { saveInvoice.hidden = false }
        invoice.onsubmit = event => {
          event.preventDefault()
          run(async () => {
            await api('/invoice-status', { reference: sale.reference, issued: checkbox.checked, number: number.value })
            await refresh()
          }, 'Estado da fatura guardado.')
        }
        invoice.append(label, numberLabel, saveInvoice)
        card.querySelector('.order-summary').append(badges)
        actions.append(invoice, node('p', 'Pago ' + money.format(paid / 100) + ' · Por pagar ' + money.format((total - paid) / 100)))
        for (const item of sale.payments ?? []) {
          details.append(node('p', item.date + ' · ' + item.method + ' · ' + money.format(item.amount / 100)))
        }
        if (sale.closedAt) details.append(node('p', 'Fechada em ' + dateLabel.format(new Date(sale.closedAt))))
        if (state === 'pending') actions.append(orderAction(sale, 'Iniciar produção', 'start', 'Encomenda em produção.'))
        if (state === 'pending' || state === 'producing') actions.append(orderAction(sale, 'Marcar como pronta', 'ready', 'Encomenda pronta. Stock atualizado.'))
        if (state !== 'closed' && paid < total) actions.append(button('Registar pagamento', () => openPayment(sale)))
        if (state === 'ready' && payment === 'paid') actions.append(orderAction(sale, 'Fechar encomenda', 'close', 'Encomenda fechada. Disponível no histórico e nos relatórios.'))
      }
      if (!quote && !(sale.closedAt && paymentState(sale) === 'paid'))
        actions.append(button('Editar encomenda', () => openOrderEditor(sale)))
      actions.append(details)
      actions.append(button(quote ? 'Abrir orçamento' : 'Abrir nota de encomenda', () => {
        try { printSale(sale) } catch (error) { element('status').textContent = error.message }
      }))
      if (quote && sale.converted) card.append(node('p', 'Convertido em encomenda'))
      if (quote && !sale.converted) card.append(button('Converter em encomenda', () => run(async () => {
        await api('/convert', { reference: sale.reference })
        await refresh()
        selectView('orders')
      }, 'Encomenda criada e enviada para a fila de produção.')))
      return card
    })
  }

  element('new-order').onclick = () => {
    const editor = element('sale-editor')
    if (editor.hidden || editingSale) resetSale('orders')
    editor.hidden = false
    editor.open = true
    salesForm.elements.customer.focus()
  }

  element('order-filter').onchange = () => renderSales('orders')
  element('order-sort').onchange = () => renderSales('orders')
  element('order-search').oninput = () => renderSales('orders')
  element('add-line').onclick = () => addSaleLine()
  salesForm.addEventListener('input', salesTotal)
  salesForm.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      const form = salesForm.elements
      const lines = [...element('sales-lines').children].map(row => {
        const sku = row.querySelector('[name=sku]').value
        return { sku, name: catalogue.find(item => item.sku === sku)?.name ?? editingSale?.lines.find(item => item.sku === sku)?.name ?? sku,
          ...saleQuantity(row),
          price: cents(row.querySelector('[name=price]').value) }
      })
      await api(editingSale ? '/edit-order' : '/sales', { kind: view === 'quotes' ? 'quote' : 'order',
        reference: form.reference.value.trim(), customer: form.customer.value.trim(),
        due: form.due.value, notes: form.notes.value.trim(),
        delivery: cents(form.delivery.value.trim() || '0'), lines })
      await refresh()
      resetSale(view)
    }, editingSale ? 'Alterações guardadas.' : view === 'quotes' ? 'Orçamento guardado.' : 'Encomenda guardada e enviada para produção.')
  }

  const clientKey = value => value.trim().normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('pt')
  const importForm = element('odoo-form')

  function readCsvRows(text) {
    text = text.replace(/^\uFEFF/, '')
    const header = text.split(/\r?\n/, 1)[0]
    const delimiter = header.split(';').length > header.split(',').length ? ';' : ','
    const rows = []
    let row = []
    let cell = ''
    let quoted = false
    for (let i = 0; i <= text.length; i++) {
      const char = text[i]
      if (quoted && char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"' && (quoted || !cell)) {
        quoted = !quoted
      } else if (i === text.length || (!quoted && (char === delimiter || char === '\n' || char === '\r'))) {
        if (quoted) throw new Error('O CSV contém aspas por fechar.')
        row.push(cell)
        cell = ''
        if (char !== delimiter) {
          if (row.some(value => value.trim())) rows.push(row)
          row = []
          if (char === '\r' && text[i + 1] === '\n') i++
        }
      } else cell += char
    }
    return rows
  }

  function parseOdooCsv(text) {
    const rows = readCsvRows(text)
    const columns = rows.shift()?.map(value => value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()) ?? []
    const column = names => columns.findIndex(name => names.includes(name))
    const name = column(['nome', 'nome exibido', 'name', 'display name'])
    if (name < 0) throw new Error('O CSV precisa de uma coluna Nome.')
    if (rows.length > 10000) throw new Error('Divide o ficheiro em lotes até 10 000 registos.')
    const get = (row, names) => (row[column(names)] ?? '').trim()
    return rows.map(row => ({
      name: (row[name] ?? '').trim(),
      email: get(row, ['e-mail', 'email']),
      phone: get(row, ['telefone', 'phone']) || get(row, ['telemovel','mobile']),
      tax: get(row, ['nif', 'vat']),
      address: ['morada', 'rua', 'rua 2', 'codigo postal', 'cidade', 'pais'].map(key => get(row, [key])).filter(Boolean).join(', '),
      notes: get(row, ['notas', 'observacoes'])
    }))
  }

  importForm.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      const file = importForm.elements.csv.files[0]
      if (!file || file.size > 5000000) throw new Error('Escolhe um CSV de até 5 MB.')
      const rows = parseOdooCsv(await file.text())
      const result = await api('/import-clients', { rows })
      element('odoo-result').textContent =
        result.imported + ' importados · ' + result.duplicates + ' já existentes ou repetidos · ' + result.invalid + ' sem nome'
      importForm.reset()
      await refresh()
    }, 'Importação concluída.')
  }

  const clientForm = element('client-form')
  clientForm.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      await api('/clients', Object.fromEntries(new FormData(clientForm)))
      clientForm.reset()
      await refresh()
    }, 'Ficha de cliente guardada.')
  }

  function renderClients() {
    list('client-list', [...savedClients].sort((a, b) => a.name.localeCompare(b.name, 'pt')), 'Ainda não há clientes.', client => {
      const card = node('article', '')
      card.tabIndex = -1
      card.dataset.clientId = String(client.id)
      card.append(node('strong', client.name))
      for (const value of [client.email, client.phone, client.tax && 'NIF ' + client.tax, client.address])
        if (value) card.append(node('p', value))
      card.append(button('Editar ficha', () => {
        for (const name of ['id', 'name', 'email', 'phone', 'tax', 'address', 'notes']) clientForm.elements[name].value = client[name]
        clientForm.elements.name.focus()
      }))
      return card
    })
  }

  async function productPhoto(file) {
    if (file.size > 15 * 1024 * 1024) throw new Error('Escolhe uma imagem até 15 MB.')
    const image = await createImageBitmap(file)
    try {
      const scale = Math.min(1, 640 / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      let encoded = canvas.toDataURL('image/jpeg', 0.75)
      if (encoded.length > 110000) encoded = canvas.toDataURL('image/jpeg', 0.48)
      if (encoded.length > 110000) throw new Error('Escolhe uma fotografia menos detalhada ou mais pequena.')
      return encoded
    } finally {
      image.close()
    }
  }

  function reportRows() {
    const form = element('report-filter').elements
    return savedSales.filter(sale => sale.kind === 'order' &&
      (!form.from.value || sale.due >= form.from.value) && (!form.to.value || sale.due <= form.to.value) &&
      (!form.state.value || currentOrderState(sale) === form.state.value) &&
      (!form.payment.value || paymentState(sale) === form.payment.value) &&
      (!form.invoice.value || Boolean(sale.invoiceIssued) === (form.invoice.value === 'issued')) &&
      sale.customer.toLocaleLowerCase('pt').includes(form.customer.value.trim().toLocaleLowerCase('pt')))
      .map(sale => {
        const total = saleTotal(sale)
        const paid = (sale.payments ?? []).reduce((sum, item) => sum + item.amount, 0)
        return { sale, total, paid, outstanding: total - paid }
      })
  }

  function renderReport() {
    const rows = reportRows()
    const totals = rows.reduce((sum, row) => ({
      total: sum.total + row.total, paid: sum.paid + row.paid, outstanding: sum.outstanding + row.outstanding
    }), { total: 0, paid: 0, outstanding: 0 })
    element('report-metrics').replaceChildren(...[
      ['Encomendas', rows.length], ['Total de encomendas', money.format(totals.total / 100)],
      ['Recebido', money.format(totals.paid / 100)], ['Por receber', money.format(totals.outstanding / 100)]
    ].map(([label, value]) => {
      const item = node('div', '')
      item.className = 'metric'
      item.append(node('span', label), node('strong', value))
      return item
    }))
    list('report-list', rows, 'Nenhuma encomenda no período selecionado.', ({ sale, total, paid, outstanding }) => {
      const item = node('article', '')
      item.append(node('strong', sale.reference + ' · ' + sale.customer),
        node('p', sale.due + ' · ' + states[currentOrderState(sale)] + ' · ' + paymentLabels[paymentState(sale)] + ' · Fatura ' + (sale.invoiceIssued ? 'emitida' + (sale.invoiceNumber ? ' · ' + sale.invoiceNumber : '') : 'por emitir')),
        node('p', 'Total ' + money.format(total / 100) + ' · Recebido ' + money.format(paid / 100) + ' · Por receber ' + money.format(outstanding / 100)))
      return item
    })
  }

  element('report-filter').oninput = renderReport
  element('report-filter').onsubmit = event => event.preventDefault()
  element('export-report').onclick = () => {
    const cell = value => {
      const string = String(value)
      return '"' + (/^\s*[=+@-]/.test(string) ? "'" : '') + string.replaceAll('"', '""') + '"'
    }
    const table = [['Referência', 'Cliente', 'Prazo', 'Estado', 'Pagamento', 'Fatura', 'N.º da fatura', 'Total (€)', 'Pago (€)', 'Saldo (€)']]
    for (const { sale, total, paid, outstanding } of reportRows())
      table.push([sale.reference, sale.customer, sale.due, states[currentOrderState(sale)], paymentLabels[paymentState(sale)], sale.invoiceIssued ? 'Emitida' : 'Por emitir', sale.invoiceNumber ?? '', ...[total, paid, outstanding].map(value => (value / 100).toFixed(2).replace('.', ','))])
    const csv = '\uFEFF' + table.map(row => row.map(cell).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = node('a', '')
    link.href = url
    link.download = 'printastic360-relatorio-' + today() + '.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function renderDeliveryAlerts(currentDate) {
    const upcoming = new Date(currentDate)
    upcoming.setUTCDate(upcoming.getUTCDate() + 2)
    const lastDate = upcoming.toISOString().slice(0, 10)
    const alerts = savedSales
      .filter(sale => sale.kind === 'order' && !sale.closedAt &&
        /^\d{4}-\d{2}-\d{2}$/.test(sale.due) && sale.due <= lastDate)
      .map(sale => ({ sale, state: currentOrderState(sale) }))
      .filter(({ sale, state }) => state !== 'closed' &&
        (sale.due <= currentDate || state === 'pending' || state === 'producing'))
      .sort((a, b) => a.sale.due.localeCompare(b.sale.due))

    element('delivery-alerts').hidden = alerts.length === 0
    element('delivery-alert-list').replaceChildren(...alerts.map(({ sale, state }) => {
      const card = node('article', '')
      const label = sale.due < currentDate ? 'Entrega em atraso'
        : sale.due === currentDate ? 'Entrega hoje' : 'Entrega próxima'
      const title = node('strong', state === 'ready' ? label + ' · Por entregar' : label)
      if (sale.due < currentDate) title.className = 'late'
      card.append(title, node('p', sale.reference + ' · ' + sale.customer + ' · ' +
        dateLabel.format(new Date(sale.due))), button('Ver encomenda', () => {
        element('order-filter').value = 'active'
        element('order-search').value = ''
        selectView('orders')
        const orderCard = [...element('sales-list').children]
          .find(item => item.dataset.orderReference === sale.reference)
        if (orderCard) {
          orderCard.querySelector('.order-details').open = true
          orderCard.querySelector('summary').focus()
        }
      }))
      return card
    }))
  }

  const customerAlertDays = element('customer-alert-days')
  const customerAlertSetting = 'printastic360-customer-alert-days'
  const savedAlertDays = localStorage.getItem(customerAlertSetting)
  if ([...customerAlertDays.options].some(option => option.value === savedAlertDays))
    customerAlertDays.value = savedAlertDays
  customerAlertDays.onchange = () => {
    localStorage.setItem(customerAlertSetting, customerAlertDays.value)
    renderCustomerAlerts(today())
  }

  const commercialStates = ['Contactado', 'Adiado', 'Orçamento enviado', 'Encomenda ganha']
  const dayMs = 86400000
  const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  const addDays = (date, days) => new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10)

  function renderCustomerAlerts(currentDate) {
    const byClient = new Map()
    const sales = new Map([...savedOrderHistory, ...savedSales.filter(sale => sale.kind === 'order')]
      .map(sale => [clientKey(sale.reference), sale]))
    const idsByName = new Map(savedClients.map(client => [clientKey(client.name), client.id]))
    for (const sale of sales.values()) {
      const date = String(sale.createdAt ?? '').slice(0, 10)
      if (!validDay(date) || date > currentDate) continue
      const id = sale.customerInfo?.id || idsByName.get(clientKey(sale.customer))
      if (!id) continue
      if (!byClient.has(id)) byClient.set(id, [])
      byClient.get(id).push({ sale, date })
    }

    const alerts = []
    for (const client of savedClients) {
      const history = (byClient.get(client.id) ?? []).sort((a, b) => b.date.localeCompare(a.date))
      if (!history.length) continue
      const latest = history[0]
      const dates = [...new Set(history.map(order => order.date))]
      const gaps = dates.slice(1).map((date, i) => (Date.parse(dates[i]) - Date.parse(date)) / dayMs)
        .sort((a, b) => a - b)
      const middle = Math.floor(gaps.length / 2)
      const interval = gaps.length >= 2 ? Math.round((gaps[middle] + gaps[Math.floor((gaps.length - 1) / 2)]) / 2) : 0
      const predictable = interval >= 14 && gaps.at(-1) <= gaps[0] * 2
      const typical = predictable ? interval : Number(customerAlertDays.value)
      const lead = predictable ? Math.min(30, Math.ceil(typical / 4)) : 0
      const days = (Date.parse(currentDate) - Date.parse(latest.date)) / dayMs
      const key = latest.sale.reference
      const followups = (client.commercial ?? []).filter(item => item.key === key)
      const lastFollowup = followups.at(-1)
      if (lastFollowup?.next > currentDate || (!lastFollowup && days < typical - lead)) continue
      const score = days - typical + (lastFollowup ? 1000 : 0)
      alerts.push({ client, history, latest, days, typical, predictable, key, followups, score })
    }
    alerts.sort((a, b) => b.score - a.score || a.client.name.localeCompare(b.client.name, 'pt'))
    element('customer-alert-summary').textContent = 'Inteligência Comercial · ' + alerts.length + ' clientes a contactar'
    list('customer-alert-list', alerts.slice(0, 5), 'Sem contactos sugeridos para hoje.', alert => {
      const { client, history, latest, days, typical, predictable, key, followups } = alert
      const card = node('article', '')
      const description = predictable
        ? 'Compras a cada ~' + typical + ' dias. Próxima compra estimada para ' + dateLabel.format(new Date(addDays(latest.date, typical))) + '.'
        : 'Prazo de seguimento configurado: ' + typical + ' dias.'
      const items = (latest.sale.lines ?? []).filter(line => !isDeliveryLine(line)).slice(0, 3).map(line => line.name)
      card.append(node('strong', client.name),
        node('p', 'Última compra há ' + days + ' dias · ' + history.length + ' encomendas conhecidas. ' + description))
      if (items.length) card.append(node('p', 'Últimos artigos: ' + items.join(', ')))
      const details = node('details', '')
      details.append(node('summary', 'Histórico e seguimento'))
      for (const { sale, date } of history.slice(0, 8))
        details.append(node('p', sale.reference + ' · ' + dateLabel.format(new Date(date))))
      for (const item of followups.slice(-4))
        details.append(node('p', item.date + ' · ' + item.state + ' · Seguimento em ' + item.next))
      const label = node('label', 'Mensagem editável')
      const draft = node('textarea', '')
      draft.rows = 3
      draft.value = 'Olá, falo da Printastic. ' + (items.length
        ? 'Na última encomenda fizemos ' + items.join(', ') + '. Precisam de alguma reposição ou querem atualizar as quantidades?'
        : 'Gostava de saber se precisam de repor algum artigo da última encomenda ou têm uma nova personalização em vista.')
      label.append(draft)
      details.append(label)
      const state = node('select', '')
      for (const value of commercialStates) state.add(new Option(value))
      const stateLabel = node('label', 'Resultado do contacto')
      stateLabel.append(state)
      const date = node('input', '')
      date.type = 'date'
      date.min = addDays(currentDate, 1)
      date.value = addDays(currentDate, 7)
      const dateField = node('label', 'Voltar a contactar em')
      dateField.append(date)
      details.append(stateLabel, dateField, button('Guardar seguimento', () => run(async () => {
        await api('/commercial-followup', { id: client.id, key, state: state.value, next: date.value })
        await refresh()
      }, 'Seguimento guardado.')))
      card.append(details)
      if (items.length) card.append(button('Preparar orçamento', () => {
        selectView('quotes')
        salesForm.elements.customer.value = client.name
        salesForm.elements.notes.value = latest.sale.notes ?? ''
        const lines = latest.sale.lines.filter(line => !isDeliveryLine(line) && catalogue.some(product => product.sku === line.sku))
        if (lines.length) {
          element('sales-lines').replaceChildren()
          for (const line of lines) {
            addSaleLine(line)
            const row = element('sales-lines').lastElementChild
            const price = catalogue.find(product => product.sku === line.sku).sell
            row.querySelector('[name=price]').value = price ?? ''
          }
          salesTotal()
        }
        salesForm.elements.due.focus()
      }))
      return card
    })
  }

  async function refresh() {
    const { products, orders, sales, clients, orderHistory, productionLines: lines } = await api()
    productionLines = lines
    productsForProfit = products
    catalogue = products.filter(product => !product.archived)
    savedSales = sales
    savedClients = clients
    savedOrderHistory = orderHistory
    if (view === 'clients') renderClients()
    if (view === 'reports') renderReport()
    renderSales(view)
    const { queue, purchases } = plan(products, orders)
    const currentDate = today()
    renderDeliveryAlerts(currentDate)
    renderCustomerAlerts(currentDate)
    const number = new Intl.NumberFormat('pt-PT')
    const totalUnits = purchases.length
    const totalCost = purchases.reduce((total, item) => total + item.quantity * Number(item.product.cost), 0)
    element('metric-orders').textContent = number.format(new Set(queue.map(item => item.reference)).size)
    element('metric-late').textContent = number.format(new Set(
      queue.filter(item => item.due < currentDate).map(item => item.reference)
    ).size)
    element('metric-units').textContent = number.format(totalUnits)
    element('metric-cost').textContent = money.format(totalCost)
    const select = element('order').elements.sku
    const selected = select.value
    select.replaceChildren(...products.filter(product => !product.archived || product.sku === selected).map(product => new Option(product.name, product.sku)))
    if (products.some(product => product.sku === selected)) select.value = selected

    list('queue', queue, 'Sem trabalho pendente.', order => {
      const card = node('article', '')
      const deadline = node('p', 'Prazo ' + dateLabel.format(new Date(order.due)) +
        (order.due < currentDate ? ' · Em atraso' : ''))
      if (order.due < currentDate) deadline.className = 'late'
      card.append(node('strong', order.reference + ' · ' + order.customer), deadline,
        node('p', formatQuantity(order.quantity, order.product.unit) + ' × ' + order.product.name),
        node('p', formatQuantity(order.reserved, order.product.unit) + ' em stock · ' + formatQuantity(order.missing, order.product.unit) + ' por comprar'))
      if (order.notes) card.append(node('p', order.notes))
      card.append(button('Editar', () => {
          selectView('orders')
          element('legacy-edit').hidden = false
          if (order.product.archived && ![...select.options].some(option => option.value === order.sku))
            select.add(new Option(order.product.name, order.sku))
          edit('order', order)
        }), ' ',
        button('Concluir', () => run(async () => {
          await api('/close', { reference: order.reference, sku: order.sku })
          await refresh()
        }, 'Linha concluída.')))
      return card
    })

    list('purchases', purchases, 'Stock suficiente para a fila de produção.', purchase => {
      const { product, quantity, due } = purchase
      const card = node('article', '')
      const link = node(product.url ? 'a' : 'span', product.supplier)
      if (product.url) link.href = product.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      card.append(node('strong', formatQuantity(quantity, product.unit) + ' × ' + product.name),
        node('p', money.format(quantity * Number(product.cost)) + ' de custo estimado · Prazo ' +
          dateLabel.format(new Date(due))), link)
      return card
    })

    list('catalog', products, 'Nenhum produto registado.', product => {
      const card = node('article', '')
      if (product.photo?.startsWith('data:image/jpeg;base64,') || httpsUrl(product.photoUrl)) {
        const image = node('img', '')
        image.referrerPolicy = 'no-referrer'
        image.src = product.photo || product.photoUrl
        image.alt = product.name
        image.className = 'product-photo'
        image.loading = 'lazy'
        card.append(image)
      }
      card.append(node('strong', product.name + ' · ' + product.sku),
        node('p', product.supplier + ' · ' + money.format(Number(product.cost)) + (product.unit === 'meter' ? ' por metro · ' : ' por unidade · ') +
          formatQuantity(product.stock, product.unit) + ' em stock'), button('Editar ficha', () => edit('product', product)), ' ',
        button('Criar publicidade', () => {
          sessionStorage.setItem('printastic360-mockup-product', product.name)
          if (product.photo) sessionStorage.setItem('printastic360-mockup-photo', product.photo)
          else sessionStorage.removeItem('printastic360-mockup-photo')
          selectView('studio', true)
        }))
      if (product.archived) {
        card.append(badge('Arquivado', 'closed'), button('Reativar', () => run(async () => {
          await api('/restore-product', { sku: product.sku })
          await refresh()
        }, 'Produto reativado.')))
      } else {
        const used = productionLines.some(line => line.sku === product.sku) ||
          savedSales.some(sale => sale.lines.some(line => line.sku === product.sku))
        card.append(button(used ? 'Arquivar produto' : 'Eliminar produto', () => {
          if (!window.confirm(used ? 'Arquivar este produto? Os registos existentes serão mantidos.'
            : 'Eliminar definitivamente este produto do catálogo?')) return
          run(async () => {
            const { archived } = await api('/remove-product', { sku: product.sku })
            await refresh()
            return archived ? 'Produto arquivado.' : 'Produto eliminado.'
          })
        }))
      }
      return card
    })
  }

  async function run(task, success) {
    if (busy) return
    busy = true
    element('status').textContent = 'A processar…'
    try {
      const message = await task()
      element('status').textContent = success ?? message ?? ''
    } catch (error) {
      element('status').textContent = error.message
    } finally {
      busy = false
    }
  }

  const productForm = element('product')
  const fields = productForm.elements
  const priceInfo = element('product-lookup')
  const fieldsFromLookup = new Map()
  let candidatePhoto = ''
  let lookupRun = 0
  let lookupTimer
  let recommended = ''
  let pricingSource = 'margin'

  function httpsUrl(value, base) {
    try {
      if (!value) return ''
      const url = new URL(value, base)
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
    } catch {
      return ''
    }
  }

  function clearProductLookup() {
    lookupRun++
    clearTimeout(lookupTimer)
    candidatePhoto = ''
    recommended = ''
    pricingSource = 'margin'
    fieldsFromLookup.clear()
    priceInfo.textContent = ''
  }

  function cataloguePrice(text) {
    if (!text?.includes('€') || /a partir|desde|entre|[-–]/i.test(text)) return ''
    const values = text.match(/\d[\d .\u00a0]*[,.]\d{2}(?!\d)/g)
    if (values?.length !== 1) return ''
    const amount = values[0].replace(/[ \u00a0]/g, '')
    return amount.includes(',') ? amount.replaceAll('.', '').replace(',', '.') : amount
  }

  function partOfPack(name) {
    return /\b(pack|lote|conjunto|caja|caixa|set|kit)\b|\bx\s*\d+\b|\b\d+\s*(unidades|unid|uds)\b/i.test(name ?? '')
  }

  function pageProduct(html, link) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const meta = key => doc.querySelector('meta[property="' + key + '"]')?.content
    const nodes = []
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent)
        for (const entry of [value].flat()) nodes.push(entry, ...(entry?.['@graph'] ?? []))
      } catch {}
    }
    const products = nodes.filter(entry => [entry?.['@type']].flat().includes('Product'))
    const product = products.length === 1 ? products[0] : undefined
    const offer = [product?.offers].flat()
    const price = offer.length === 1 && offer[0]?.priceCurrency === 'EUR'
      && /^\d+(?:\.\d{1,2})?$/.test(String(offer[0].price)) ? String(offer[0].price) : ''
    const image = [product?.image].flat()[0]
    return {
      name: product?.name || meta('og:title') || '',
      sku: product?.sku || '',
      supplier: meta('og:site_name') || '',
      photoUrl: httpsUrl(typeof image === 'string' ? image : image?.url || meta('og:image'), link),
      baseCost: price
    }
  }

  function updateSuggested() {
    try {
      if (fields.baseCost.value.trim()) {
        fields.cost.value = (Math.round(cents(fields.baseCost.value) * 123 / 100) / 100).toFixed(2)
      }
      if (!fields.cost.value.trim()) return
      const total = [fields.cost, fields.personalization, fields.packing, fields.shipping]
        .reduce((sum, field) => sum + cents(field.value || '0'), 0)
      if (pricingSource === 'price') {
        const price = fields.sell.value.trim() ? cents(fields.sell.value) : 0
        fields.margin.value = price > 0 ? ((price - total) * 100 / price).toFixed(2) : ''
        return
      }
      if (!fields.margin.value.trim()) return
      const basisPoints = Math.round(Number(fields.margin.value) * 100)
      if (!Number.isFinite(basisPoints) || basisPoints >= 10000) return
      const saleCents = Math.ceil(total * 10000 / (10000 - basisPoints))
      fields.sell.value = (saleCents / 100).toFixed(2)
      recommended = fields.sell.value
    } catch {}
  }

  async function lookupProduct() {
    const current = ++lookupRun
    const link = httpsUrl(fields.url.value.trim())
    if (!link) return
    const parsed = new URL(link)
    const source = parsed.hostname.replace(/^www\./, '')
    const suppliers = {
      'brildor.com': 'Brildor', 'sublimet.com': 'Sublimet',
      'printepoupe.com': 'Print e Poupe', 'colame.net': 'Cola-me',
      'impressive-world.pt': 'Impressive World'
    }
    priceInfo.textContent = 'A consultar os dados do fornecedor…'
    const get = url => fetch(url, {signal: AbortSignal.timeout(4500), credentials: 'omit', referrerPolicy: 'no-referrer'})
    const canonical = url => {
      const value = new URL(url)
      return value.hostname.replace(/^www\./, '') + value.pathname.replace(/\/$/, '')
    }
    const [direct, daily] = await Promise.allSettled([
      get(link).then(response => response.ok ? response.text() : '').then(html => pageProduct(html, link)),
      suppliers[source] ? get('https://raw.githubusercontent.com/jaca000/printastic-360/main/oportunidades-diarias.json')
        .then(response => response.json()).then(report => {
          if ([...parsed.searchParams.keys()].some(key => !key.startsWith('utm_'))) return {}
          const row = Object.entries(report.catalogue ?? {}).find(([url]) => canonical(url) === canonical(link))?.[1] ??
            report.items?.find(item => canonical(item.url) === canonical(link))
          return row ? { ...row, baseCost: cataloguePrice(row.buyPrice) } : {}
        }) : {}
    ])
    if (current !== lookupRun || !vaultSession || link !== httpsUrl(fields.url.value.trim())) return
    const live = direct.value ?? {}
    const cached = daily.value ?? {}
    const found = {
      name: live.name || cached.name,
      supplier: live.supplier || cached.supplier || suppliers[source],
      sku: live.sku || cached.sku,
      baseCost: live.baseCost || cached.baseCost
    }
    if (partOfPack(found.name)) found.baseCost = ''
    const changed = []
    for (const [name, value] of Object.entries(found)) {
      if (!value) continue
      const field = fields[name]
      if (!field.value || field.value === fieldsFromLookup.get(name)) {
        field.value = String(value).slice(0, field.maxLength > 0 ? field.maxLength : undefined)
        fieldsFromLookup.set(name, field.value)
        changed.push(name)
      }
    }
    candidatePhoto = httpsUrl(live.photoUrl || cached.photoUrl, link)
    updateSuggested()
    const missing = [['sku','referência'],['name','produto'],['supplier','fornecedor'],['cost','custo']]
      .filter(([key]) => !fields[key].value).map(([, label]) => label)
    const sourceLabel = live.baseCost ? '' : cached.baseCost && cached.date ? ' Preço consultado em ' + cached.date + '.' : ''
    const explanation = partOfPack(found.name) ? ' O artigo parece ser vendido em pack. Indica o preço por unidade.' : ''
    priceInfo.textContent = (changed.length || candidatePhoto ? 'Dados disponíveis preenchidos.' : 'Não consegui preencher novos dados deste link.') +
      (missing.length ? ' Completa: ' + missing.join(', ') + '.' : '') + sourceLabel + explanation +
      (candidatePhoto ? ' Fotografia do fornecedor disponível.' : '')
  }

  element('read-product').onclick = lookupProduct
  productForm.addEventListener('input', event => {
    if (event.target === fields.url) {
      lookupRun++
      candidatePhoto = ''
      for (const [name, value] of fieldsFromLookup) {
        if (fields[name].value === value) fields[name].value = ''
      }
      if (!fields.baseCost.value && fieldsFromLookup.has('baseCost')) {
        fields.cost.value = ''
        if (fields.sell.value === recommended) fields.sell.value = ''
      }
      fieldsFromLookup.clear()
      clearTimeout(lookupTimer)
      lookupTimer = setTimeout(lookupProduct, 550)
      return
    }
    if (event.target === fields.sell) {
      recommended = ''
      pricingSource = 'price'
      updateSuggested()
      return
    }
    if (event.target === fields.margin) pricingSource = 'margin'
    if (['baseCost', 'cost', 'margin', 'personalization', 'packing', 'shipping'].includes(event.target.name))
      updateSuggested()
  })

  for (const [id, path, quantity] of [['product', '/products', 'stock'], ['order', '/orders', 'quantity']]) {
    element(id).onsubmit = event => {
      event.preventDefault()
      const form = event.currentTarget
      run(async () => {
        const data = Object.fromEntries(new FormData(form))
        data[quantity] = Number(data[quantity])
        if (id === 'product') {
          data.photoUrl = candidatePhoto
          const file = element('product-photo').files[0]
          if (file) data.photo = await productPhoto(file)
        }
        await api(path, data)
        form.reset()
        if (id === 'product') clearProductLookup()
        await refresh()
        form.closest('details').open = false
      }, 'Registo guardado.')
    }
  }

  const remembered = tabSession()
  if (remembered?.expires > Date.now()) {
    run(async () => {
      try {
        await unlock({ remembered })
      } catch {
        tabSession(null)
        return 'Desbloqueia a sessão para continuar.'
      }
      return 'Sessão retomada.'
    })
  } else if (remembered) {
    tabSession(null)
  }

}
