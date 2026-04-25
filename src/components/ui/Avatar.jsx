function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return 'A'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

export default function Avatar({ name, src, size = 'md', className }) {
  const cls = ['uiAvatar', `uiAvatar-${size}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls} aria-label={name ? `Avatar for ${name}` : 'Avatar'}>
      {src ? (
        <img className="uiAvatarImg" src={src} alt="" />
      ) : (
        <span className="uiAvatarText" aria-hidden="true">
          {initials(name)}
        </span>
      )}
    </div>
  )
}

