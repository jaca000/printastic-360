export function connectVault(origin, token, request = fetch) {
  const endpoint = new URL('/vault', origin)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('A ligação ao servidor precisa de HTTPS.')
  }

  async function call(method, headers = {}, body) {
    return request(endpoint, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
  }

  function revision(response) {
    const tag = response.headers.get('ETag')
    if (!tag || !/^"[a-f0-9]{64}"$/.test(tag)) {
      throw new Error('O servidor não confirmou a versão dos registos.')
    }
    return tag
  }

  return {
    async read() {
      const response = await call('GET')
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error('Não foi possível ler os registos no servidor.')
      return { body: await response.text(), revision: revision(response) }
    },

    async write(body, previous) {
      const condition = previous ? { 'If-Match': previous } : { 'If-None-Match': '*' }
      const response = await call('PUT', { 'Content-Type': 'application/json', ...condition }, body)
      if (response.status === 412) {
        throw new Error('Os registos mudaram noutro computador. O servidor rejeitou esta gravação.')
      }
      if (response.status !== 204) throw new Error('A gravação no servidor falhou.')
      return revision(response)
    }
  }
}
