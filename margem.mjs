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

if (typeof document !== 'undefined') start()

function start() {
  const element = id => document.getElementById(id)
  const money = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' })
  const dateLabel = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeZone: 'Europe/Lisbon' })
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Lisbon' }).format()
  let connection
  let busy = false
  const storageKey = 'printastic360-production-v1'

  const vaultKey = 'printastic360-production-vault-v1'
  const localLogin = element('local-login')
  const passField = localLogin.elements.password
  const encode = bytes => btoa(String.fromCharCode(...bytes))
  const decode = string => Uint8Array.from(atob(string), char => char.charCodeAt(0))
  const encoder = new TextEncoder()
  const empty = () => ({ products: [], orders: [] })
  let vaultSession

  const menu = element('app-menu')
  const frame = element('app-view')
  const tabs = [...menu.querySelectorAll('[data-view]')]
  const screens = {
    opportunities: { url: './oportunidades.html?panel=1', title: 'Oportunidades' },
    studio: { url: './mockup.html?panel=1', title: 'Estúdio de mockups' }
  }
  let view
  let catalogue = []
  let savedSales = []
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

  function loginState(open) {
    menu.hidden = !open
    element('access-copy').hidden = open
    if (open) {
      selectView('production')
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
    element('backup').hidden = !open
    element('lock').hidden = !open
    const exists = localStorage.getItem(vaultKey) !== null
    element('confirm-wrap').hidden = exists
    localLogin.elements.confirmPassword.required = !exists
    passField.autocomplete = exists ? 'current-password' : 'new-password'
    element('local').textContent = exists ? 'Desbloquear' : 'Criar palavra-passe local'
  }

  async function derive(password, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    )
  }

  async function readVault(session) {
    const record = JSON.parse(localStorage.getItem(vaultKey))
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
    localStorage.setItem(vaultKey, JSON.stringify({ salt: session.salt, iv: encode(iv), data: btoa(binary) }))
  }

  async function access(password) {
    return navigator.locks.request(vaultKey, async () => {
      const stored = JSON.parse(localStorage.getItem(vaultKey))
      const salt = stored ? decode(stored.salt) : crypto.getRandomValues(new Uint8Array(16))
      const session = { salt: encode(salt), key: await derive(password, salt) }
      if (stored) {
        try {
          await readVault(session)
        } catch {
          throw new Error('Palavra-passe incorreta ou ficheiro de dados inválido.')
        }
      } else {
        const previous = JSON.parse(localStorage.getItem(storageKey)) ?? empty()
        await saveVault(session, previous)
        await readVault(session)
      }
      if (!stored) localStorage.removeItem(storageKey)
      return session
    })
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
      clients: records.clients ?? [],
      orders: records.orders.filter(order => !order.completed).sort((a, b) =>
        a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference) || a.sku.localeCompare(b.sku))
    }
    for (const key of ['sku', 'name', 'supplier', 'reference', 'customer', 'notes']) {
      if (typeof data[key] === 'string') data[key] = data[key].trim()
    }
    if (path === '/import-clients') {
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
      else records.clients[index] = data
    } else if (path === '/payment') {
      const sale = (records.sales ?? []).find(item => item.reference === data.reference && item.kind === 'order')
      const method = ['MB WAY', 'Transferência', 'Numerário'].includes(data.method)
      if (!sale || !method || !Number.isSafeInteger(data.amount) || data.amount <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('Revê os dados do pagamento.')
      sale.payments ??= []
      const outstanding = saleTotal(sale) - sale.payments.reduce((sum, item) => sum + item.amount, 0)
      if (data.amount > outstanding) throw new Error('O pagamento ultrapassa o saldo da encomenda.')
      sale.payments.push({ amount: data.amount, method: data.method, date: data.date })
    } else if (path === '/sales' || path === '/convert') {
      saveSale(records, path, data)
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
      if (data.photo) delete data.photoUrl
      if (index < 0) records.products.push(data)
      else records.products[index] = data
    } else {
      const product = records.products.find(item => item.sku === data.sku)
      if (!product || !data.reference) throw new Error('Indica a encomenda e um produto do catálogo.')
      const index = records.orders.findIndex(item => item.reference === data.reference && item.sku === data.sku)
      const previous = records.orders[index]
      if (path === '/close') {
        if (previous && !previous.completed) {
          previous.completed = true
          product.stock = Math.max(0, roundQuantity(product.stock - previous.quantity))
        }
      } else {
        if (!validQuantity(data.quantity, product.unit)) throw new Error('Indica a quantidade na unidade de venda.')
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
        if (localStorage.getItem(vaultKey) === null && passField.value !== localLogin.elements.confirmPassword.value) {
          throw new Error('As duas palavras-passe têm de ser iguais.')
        }
        vaultSession = await access(passField.value)
        connection = { local: true }
        await refresh()
        loginState(true)
        element('workspace').hidden = false
      } finally {
        localLogin.reset()
      }
    }, 'Área de produção desbloqueada.')
  }

  element('lock').onclick = () => run(async () => {
    vaultSession = undefined
    connection = undefined
    element('workspace').hidden = true
    catalogue = []
    savedSales = []
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
    const data = localStorage.getItem(vaultKey)
    if (!vaultSession || !data) throw new Error('Desbloqueia primeiro os registos.')
    const url = URL.createObjectURL(new Blob([data], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = 'printastic360-cifrado-' + today() + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'Cópia preparada.')

  async function api(path = '', data) {
    if (connection.local) return browserData(path, data)
    const response = await fetch(connection.endpoint + '/production' + path, {
      headers: {
        Authorization: 'Bearer ' + connection.token,
        ...(data ? { 'Content-Type': 'application/json' } : {})
      },
      method: data ? 'POST' : 'GET',
      body: data ? JSON.stringify(data) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'Erro na API.')
    return result
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
    const product = catalogue.find(item => item.sku === row.querySelector('[name=sku]').value)
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
    const quantities = new Map()
    for (const line of source.lines) {
      const product = records.products.find(product => product.sku === line.sku)
      if (!product || !validQuantity(line.quantity, product.unit) ||
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
    records.sales.push({ ...source, reference, kind: 'order', converted: false })
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
      }, 0)
      element('sales-total').textContent = 'Total ' + money.format(total / 100)
    } catch {
      element('sales-total').textContent = 'Total —'
    }
  }

  function addSaleLine() {
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
    salesForm.reset()
    element('sales-lines').replaceChildren()
    element('legacy-edit').hidden = true
    element('sales-title').textContent = quote ? 'Novo orçamento' : 'Nova encomenda'
    element('sales-list-title').textContent = quote ? 'Orçamentos registados' : 'Encomendas registadas'
    element('save-sales').textContent = quote ? 'Guardar orçamento' : 'Guardar encomenda'
    salesForm.elements.reference.value = (quote ? 'ORC-' : 'ENC-') + today().replaceAll('-', '') + '-' +
      crypto.randomUUID().slice(0, 6).toUpperCase()
    addSaleLine()
  }

  let paymentReference
  const paymentForm = element('payment-form')
  const saleTotal = sale => sale.lines.reduce((sum, line) => sum + lineAmount(line), 0)

  function openPayment(sale) {
    paymentReference = sale.reference
    paymentForm.reset()
    paymentForm.elements.date.value = today()
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
    const style = doc.createElement('style')
    style.textContent = 'body{font:16px system-ui;color:#182747;margin:45px}header{background:#11489e;padding:22px;border-radius:12px}img{width:140px}table{border-collapse:collapse;width:100%;margin:22px 0}td,th{padding:10px;border-bottom:1px solid #bfd2eb;text-align:left}@media print{header{print-color-adjust:exact}}'
    doc.head.append(style)
    const add = (root, tag, value) => {
      const item = doc.createElement(tag)
      item.textContent = value
      root.append(item)
      return item
    }
    const header = add(doc.body, 'header', '')
    const logo = add(header, 'img', '')
    logo.alt = 'Printastic_AL'
    const title = sale.kind === 'quote' ? 'Orçamento' : 'Nota de encomenda'
    add(doc.body, 'h1', title + ' · ' + sale.reference)
    add(doc.body, 'p', 'Cliente · ' + sale.customer)
    const customer = sale.customerInfo
    if (customer?.tax) add(doc.body, 'p', 'NIF · ' + customer.tax)
    if (customer?.address) add(doc.body, 'p', customer.address)
    if (customer?.email || customer?.phone) add(doc.body, 'p', [customer.email, customer.phone].filter(Boolean).join(' · '))
    add(doc.body, 'p', 'Prazo · ' + dateLabel.format(new Date(sale.due)))
    const table = add(doc.body, 'table', '')
    const headings = add(table, 'tr', '')
    for (const value of ['Produto', 'Quantidade', 'Preço unitário', 'Total']) add(headings, 'th', value)
    for (const line of sale.lines) {
      const row = add(table, 'tr', '')
      for (const value of [line.name, formatQuantity(line.quantity, line.unit), money.format(line.price / 100) + (line.unit === "meter" ? "/m" : ""), money.format(lineAmount(line) / 100)])
        add(row, 'td', value)
    }
    add(doc.body, 'h2', 'Total · ' + money.format(saleTotal(sale) / 100))
    if (sale.notes) add(doc.body, 'p', sale.notes)
    add(doc.body, 'p', 'Documento comercial sem valor de fatura.')
    const print = add(doc.body, 'button', 'Imprimir ou guardar em PDF')
    print.onclick = () => { print.hidden = true; printWindow.print(); print.hidden = false }
    logo.src = new URL('./logo-printastic-al.png', location.href).href
  }

  function renderSales(next) {
    if (next !== 'quotes' && next !== 'orders') return
    const quote = next === 'quotes'
    const clients = new Set([...savedClients.map(client => client.name), ...savedSales.map(sale => sale.customer)])
    element('clients').replaceChildren(...[...clients].sort().map(client => new Option(client)))
    const sales = savedSales.filter(sale => sale.kind === (quote ? 'quote' : 'order')).reverse()
    list('sales-list', sales, quote ? 'Ainda não há orçamentos.' : 'Ainda não há encomendas registadas neste ecrã.', sale => {
      const card = node('article', '')
      const total = saleTotal(sale)
      card.append(node('strong', sale.reference + ' · ' + sale.customer),
        node('p', 'Prazo ' + dateLabel.format(new Date(sale.due)) + ' · ' + money.format(total / 100)))
      for (const line of sale.lines) card.append(node('p', formatQuantity(line.quantity, line.unit) + ' × ' + line.name))
      if (!quote) {
        const paid = (sale.payments ?? []).reduce((sum, item) => sum + item.amount, 0)
        card.append(node('p', 'Pago ' + money.format(paid / 100) + ' · Por pagar ' + money.format((total - paid) / 100)))
        for (const payment of sale.payments ?? []) {
          card.append(node('p', payment.date + ' · ' + payment.method + ' · ' + money.format(payment.amount / 100)))
        }
        if (paid < total) card.append(button('Registar pagamento', () => openPayment(sale)))
      }
      card.append(button(quote ? 'Abrir orçamento' : 'Abrir nota de encomenda', () => {
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

  element('add-line').onclick = addSaleLine
  salesForm.addEventListener('input', salesTotal)
  salesForm.onsubmit = event => {
    event.preventDefault()
    run(async () => {
      const form = salesForm.elements
      const lines = [...element('sales-lines').children].map(row => {
        const sku = row.querySelector('[name=sku]').value
        return { sku, name: catalogue.find(item => item.sku === sku)?.name ?? sku,
          ...saleQuantity(row),
          price: cents(row.querySelector('[name=price]').value) }
      })
      await api('/sales', { kind: view === 'quotes' ? 'quote' : 'order',
        reference: form.reference.value.trim(), customer: form.customer.value.trim(),
        due: form.due.value, notes: form.notes.value.trim(), lines })
      await refresh()
      resetSale(view)
    }, view === 'quotes' ? 'Orçamento guardado.' : 'Encomenda guardada e enviada para produção.')
  }

  const clientKey = value => value.trim().normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('pt')
  const importForm = element('odoo-form')

  function parseOdooCsv(text) {
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
      (!form.from.value || sale.due >= form.from.value) && (!form.to.value || sale.due <= form.to.value))
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
    list('report-list', rows, 'Nenhuma encomenda no período selecionado.', ({ sale, outstanding }) => {
      const item = node('article', '')
      item.append(node('strong', sale.reference + ' · ' + sale.customer),
        node('p', sale.due + ' · Por receber ' + money.format(outstanding / 100)))
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
    const table = [['Referência', 'Cliente', 'Prazo', 'Total (€)', 'Pago (€)', 'Saldo (€)']]
    for (const { sale, total, paid, outstanding } of reportRows())
      table.push([sale.reference, sale.customer, sale.due, ...[total, paid, outstanding].map(value => (value / 100).toFixed(2).replace('.', ','))])
    const csv = '\uFEFF' + table.map(row => row.map(cell).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = node('a', '')
    link.href = url
    link.download = 'printastic360-relatorio-' + today() + '.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function refresh() {
    const { products, orders, sales, clients } = await api()
    catalogue = products
    savedSales = sales
    savedClients = clients
    if (view === 'clients') renderClients()
    if (view === 'reports') renderReport()
    renderSales(view)
    const { queue, purchases } = plan(products, orders)
    const currentDate = today()
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
    select.replaceChildren(...products.map(product => new Option(product.name, product.sku)))
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
      return card
    })
  }

  async function run(task, success) {
    if (busy) return
    busy = true
    element('status').textContent = 'A processar…'
    try {
      await task()
      element('status').textContent = success
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
}
