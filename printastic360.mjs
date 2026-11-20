export function plan(products, orders) {
  const bySku = new Map(products.map(product => [product.sku, product]))
  const stock = new Map(products.map(product => [product.sku, product.stock]))
  const purchases = new Map()
  const queue = orders.map(order => {
    const product = bySku.get(order.sku)
    const reserved = Math.min(stock.get(order.sku), order.quantity)
    stock.set(order.sku, stock.get(order.sku) - reserved)
    const missing = order.quantity - reserved
    if (missing > 0) {
      const purchase = purchases.get(order.sku) ?? { product, quantity: 0, due: order.due }
      purchase.quantity += missing
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

  function browserData(path, data) {
    const records = JSON.parse(localStorage.getItem(storageKey)) ?? { products: [], orders: [] }
    if (!data) return {
      products: records.products,
      orders: records.orders.filter(order => !order.completed).sort((a, b) =>
        a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference) || a.sku.localeCompare(b.sku))
    }
    for (const key of ['sku', 'name', 'supplier', 'reference', 'customer', 'notes']) {
      if (typeof data[key] === 'string') data[key] = data[key].trim()
    }
    if (path === '/products') {
      const url = new URL(data.url)
      if (!data.sku || !data.name || !data.supplier || url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Preenche a ficha e indica o link HTTPS do fornecedor.')
      data.cost = data.cost.trim().replace(',', '.')
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(data.cost))
        throw new Error('Indica um custo válido com até duas casas decimais.')
      const index = records.products.findIndex(product => product.sku === data.sku)
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
          product.stock = Math.max(0, product.stock - previous.quantity)
        }
      } else {
        if (!data.customer) throw new Error('Indica o cliente.')
        if (previous?.completed) throw new Error('Esta linha já está concluída.')
        if (index < 0) records.orders.push(data)
        else records.orders[index] = data
      }
    }
    localStorage.setItem(storageKey, JSON.stringify(records))
    return { ok: true }
  }

  element('local').onclick = () => run(async () => {
    connection = { local: true }
    await refresh()
    element('backup').hidden = false
    element('workspace').hidden = false
  }, 'Modo navegador ativo.')

  element('backup').onclick = () => run(async () => {
    const data = localStorage.getItem(storageKey) ?? '{"products":[],"orders":[]}'
    const url = URL.createObjectURL(new Blob([data], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = 'printastic360-' + today() + '.json'
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
    const form = element(id)
    for (const field of form.elements) {
      if (Object.hasOwn(data, field.name)) field.value = data[field.name]
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

  async function refresh() {
    const { products, orders } = await api()
    const { queue, purchases } = plan(products, orders)
    const select = element('order').elements.sku
    const selected = select.value
    select.replaceChildren(...products.map(product => new Option(product.name, product.sku)))
    if (products.some(product => product.sku === selected)) select.value = selected

    list('queue', queue, 'Sem trabalho pendente.', order => {
      const card = node('article', '')
      const deadline = node('p', 'Prazo ' + dateLabel.format(new Date(order.due)) +
        (order.due < today() ? ' · Em atraso' : ''))
      if (order.due < today()) deadline.className = 'late'
      card.append(node('strong', order.reference + ' · ' + order.customer), deadline,
        node('p', order.quantity + ' × ' + order.product.name),
        node('p', order.reserved + ' em stock · ' + order.missing + ' por comprar'))
      if (order.notes) card.append(node('p', order.notes))
      card.append(button('Editar', () => edit('order', order)), ' ',
        button('Concluir', () => run(async () => {
          await api('/close', { reference: order.reference, sku: order.sku })
          await refresh()
        }, 'Linha concluída.')))
      return card
    })

    list('purchases', purchases, 'Stock suficiente para a fila de produção.', purchase => {
      const { product, quantity, due } = purchase
      const card = node('article', '')
      const link = node('a', product.supplier)
      link.href = product.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      card.append(node('strong', quantity + ' × ' + product.name),
        node('p', money.format(quantity * Number(product.cost)) + ' de custo estimado · Prazo ' +
          dateLabel.format(new Date(due))), link)
      return card
    })

    list('catalog', products, 'Nenhum produto registado.', product => {
      const card = node('article', '')
      card.append(node('strong', product.name + ' · ' + product.sku),
        node('p', product.supplier + ' · ' + money.format(Number(product.cost)) + ' por unidade · ' +
          product.stock + ' em stock'), button('Editar ficha', () => edit('product', product)))
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

  element('login').onsubmit = event => {
    event.preventDefault()
    const form = event.currentTarget
    run(async () => {
      const values = Object.fromEntries(new FormData(form))
      const endpoint = new URL(values.endpoint)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
          endpoint.search || endpoint.hash) throw new Error('Indica um endereço HTTPS da API.')
      element('workspace').hidden = true
      connection = { endpoint: endpoint.href.replace(/\/$/, ''), token: values.token }
      await refresh()
      form.elements.token.value = ''
      element('backup').hidden = true
      element('connection').open = false
      element('workspace').hidden = false
    }, 'Ligação estabelecida.')
  }

  for (const [id, path, quantity] of [['product', '/products', 'stock'], ['order', '/orders', 'quantity']]) {
    element(id).onsubmit = event => {
      event.preventDefault()
      const form = event.currentTarget
      run(async () => {
        const data = Object.fromEntries(new FormData(form))
        data[quantity] = Number(data[quantity])
        await api(path, data)
        form.reset()
        await refresh()
        form.closest('details').open = false
      }, 'Registo guardado.')
    }
  }
}
