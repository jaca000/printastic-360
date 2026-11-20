const form = document.querySelector('#controls')
const fields = form.elements
const canvas = document.querySelector('#preview')
const ctx = canvas.getContext('2d')
const message = document.querySelector('#message')
const download = document.querySelector('#download')
const logo = new Image()
const product = sessionStorage.getItem('printastic360-mockup-product') ?? 'O teu produto'
let photo
let art

fields.title.value = product.slice(0, 70)
fields.caption.value = `${product}, personalizado ao teu gosto. Escolhe o nome, a mensagem ou o desenho e envia-nos uma mensagem para encomendar. #PrintasticAL #Personalizados`
logo.onload = draw
logo.src = './logo-printastic-al.png'

function fit(image, box) {
  const scale = Math.min(box.w / image.width, box.h / image.height)
  const w = image.width * scale
  const h = image.height * scale
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

function imageAt(image, box) {
  ctx.drawImage(image, box.x, box.y, box.w, box.h)
}

function mark(box) {
  const w = box.w * Number(fields.size.value) / 100
  const h = w * art.height / art.width
  ctx.save()
  ctx.beginPath()
  ctx.rect(box.x, box.y, box.w, box.h)
  ctx.clip()
  ctx.translate(box.x + box.w * Number(fields.x.value) / 100, box.y + box.h * Number(fields.y.value) / 100)
  ctx.rotate(Number(fields.angle.value) * Math.PI / 180)
  ctx.globalAlpha = 0.95
  if (fields.surface.value === 'flat') {
    ctx.drawImage(art, -w / 2, -h / 2, w, h)
  } else {
    const slices = Math.min(100, art.width)
    const arc = 1.12
    const curve = t => w * Math.sin((t - 0.5) * 2 * arc) / (2 * Math.sin(arc))
    for (let i = 0; i < slices; i++) {
      const left = curve(i / slices)
      const right = curve((i + 1) / slices)
      ctx.drawImage(art, i * art.width / slices, 0, art.width / slices, art.height,
        left, -h / 2, right - left + 0.5, h)
    }
  }
  ctx.restore()
}

function draw() {
  canvas.height = Number(fields.format.value)
  const h = canvas.height
  const gradient = ctx.createLinearGradient(0, 0, 1080, h)
  gradient.addColorStop(0, '#102441')
  gradient.addColorStop(0.72, '#253f61')
  gradient.addColorStop(1, '#684958')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 1080, h)
  ctx.fillStyle = '#a0e3d2'
  ctx.fillRect(62, 69, 92, 7)
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 66px system-ui'
  ctx.fillText(fields.title.value, 62, 154, 956)
  ctx.fillStyle = '#e0ecf7'
  ctx.font = '36px system-ui'
  ctx.fillText(fields.subtitle.value, 62, 209, 956)
  const frame = {x: 62, y: 250, w: 956, h: h - 420}
  ctx.fillStyle = '#0d1b31'
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h)
  if (photo) {
    const box = fit(photo, frame)
    imageAt(photo, box)
    if (art) mark(box)
  } else {
    ctx.fillStyle = '#aebbd2'
    ctx.font = '34px system-ui'
    ctx.fillText('Escolhe a fotografia do produto base', 92, frame.y + frame.h / 2, 896)
  }
  if (logo.naturalWidth) imageAt(logo, fit(logo, {x: 62, y: h - 145, w: 170, h: 112}))
  ctx.fillStyle = '#a0e3d2'
  ctx.font = '700 32px system-ui'
  ctx.textAlign = 'right'
  ctx.fillText('Encomendas por mensagem', 1018, h - 76, 690)
  ctx.textAlign = 'left'
  download.disabled = !(photo && art)
}

form.addEventListener('input', draw)
for (const [key, update] of [['photo', image => { photo = image }], ['art', image => { art = image }]]) {
  fields[key].addEventListener('change', async () => {
    const file = fields[key].files[0]
    update(undefined)
    draw()
    if (!file) return
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('Usa uma imagem até 15 MB.')
      const image = await createImageBitmap(file)
      if (fields[key].files[0] !== file) return image.close()
      update(image)
      message.textContent = ''
      draw()
    } catch (error) {
      message.textContent = error.message || 'Não foi possível abrir a imagem.'
    }
  })
}
document.querySelector('#copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(fields.caption.value)
    message.textContent = 'Legenda copiada.'
  } catch {
    fields.caption.select()
    message.textContent = 'Copia a legenda selecionada.'
  }
}
download.onclick = () => canvas.toBlob(blob => {
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'printastic360-publicidade.png'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}, 'image/png')
draw()
