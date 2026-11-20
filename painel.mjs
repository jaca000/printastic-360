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

  function selectView(next, reload = false) {
    if (!vaultSession || menu.hidden) return
    for (const tab of tabs) {
      const active = tab.dataset.view === next
      tab.classList.toggle('active', active)
      if (active) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
    element('workspace').hidden = next !== 'production'
    frame.hidden = next === 'production'
    if (next !== 'production' && (view !== next || reload)) {
      frame.title = screens[next].title
      frame.src = screens[next].url
    } else if (next === 'production') {
      frame.removeAttribute('src')
    }
    view = next
  }

  for (const tab of tabs) {
    tab.onclick = event => {
      event.preventDefault()
      if (tab.dataset.view === 'studio' && view !== 'studio') {
        sessionStorage.removeItem('printastic360-mockup-product')
      }
      selectView(tab.dataset.view)
    }
  }

  function loginState(open) {
    menu.hidden = !open
    element('connection').hidden = !open
    if (open) {
      selectView('production')
    } else {
      frame.hidden = true
      frame.removeAttribute('src')
      sessionStorage.removeItem('printastic360-mockup-product')
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
    const currentDate = today()
    const number = new Intl.NumberFormat('pt-PT')
    const totalUnits = purchases.reduce((total, item) => total + item.quantity, 0)
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
          product.stock + ' em stock'), button('Editar ficha', () => edit('product', product)), ' ',
        button('Criar publicidade', () => {
          sessionStorage.setItem('printastic360-mockup-product', product.name)
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

  element('login').onsubmit = event => {
    event.preventDefault()
    const form = event.currentTarget
    run(async () => {
      if (!vaultSession) throw new Error('Desbloqueia primeiro o Printastic 360.')
      const values = Object.fromEntries(new FormData(form))
      const endpoint = new URL(values.endpoint)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
          endpoint.search || endpoint.hash) throw new Error('Indica um endereço HTTPS da API.')
      const original = connection
      connection = { endpoint: endpoint.href.replace(/\/$/, ''), token: values.token }
      try {
        await refresh()
      } catch (error) {
        connection = original
        throw error
      } finally {
        form.elements.token.value = ''
      }
      element('connection').open = false
      selectView('production')
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
