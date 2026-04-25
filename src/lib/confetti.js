function rand(min, max) {
  return Math.random() * (max - min) + min
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function confettiBurst() {
  const canvas = document.createElement('canvas')
  canvas.className = 'confettiCanvas'
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  document.body.appendChild(canvas)

  const colors = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0f172a']
  const pieces = Array.from({ length: 140 }).map(() => {
    const angle = rand(-Math.PI, 0)
    const speed = rand(7, 13)
    return {
      x: canvas.width * 0.55 + rand(-40, 40),
      y: canvas.height * 0.2 + rand(-10, 10),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      g: rand(0.18, 0.28),
      r: rand(2.2, 4.6),
      w: rand(6, 10),
      h: rand(3, 6),
      rot: rand(0, Math.PI),
      vr: rand(-0.22, 0.22),
      color: pick(colors),
      life: rand(900, 1400),
      born: performance.now(),
    }
  })

  let raf = 0
  const start = performance.now()

  function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }

  const onResize = () => resize()
  window.addEventListener('resize', onResize)

  function tick(now) {
    const elapsed = now - start
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (const p of pieces) {
      const age = now - p.born
      if (age > p.life) continue

      p.vy += p.g
      p.x += p.vx
      p.y += p.vy
      p.rot += p.vr

      const alpha = Math.max(0, Math.min(1, 1 - age / p.life))
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      ctx.restore()
    }

    if (elapsed < 1600) {
      raf = requestAnimationFrame(tick)
      return
    }

    cleanup()
  }

  function cleanup() {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    canvas.remove()
  }

  raf = requestAnimationFrame(tick)
}

