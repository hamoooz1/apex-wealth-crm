import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

function cn(...xs) {
  return xs.filter(Boolean).join(' ')
}

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  size = 'md', // sm | md
  className,
  menuClassName,
  align = 'left', // left | right
}) {
  const id = useId()
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const selected = useMemo(() => {
    return options.find((o) => String(o.value) === String(value)) || null
  }, [options, value])

  useEffect(() => {
    function onDoc(e) {
      if (!open) return
      const t = e.target
      if (btnRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) return
    // focus first selected option or first item
    const idx = Math.max(
      0,
      options.findIndex((o) => String(o.value) === String(value)),
    )
    setActiveIndex(idx)
  }, [open])

  function commit(val) {
    onChange?.(val)
    setOpen(false)
    btnRef.current?.focus?.()
  }

  function onKeyDown(e) {
    if (disabled) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen((o) => !o)
      return
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(options.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = options[activeIndex]
      if (opt) commit(opt.value)
    }
  }

  return (
    <div className={cn('uiSelect', `uiSelect-${size}`, className)}>
      <button
        ref={btnRef}
        type="button"
        className={cn('uiSelectBtn', disabled && 'isDisabled')}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        disabled={disabled}
      >
        <span className={cn('uiSelectValue', !selected && 'isPlaceholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className={cn('uiSelectChevron', open && 'isOpen')} />
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="listbox"
          className={cn('uiSelectMenu', `align-${align}`, menuClassName)}
        >
          {options.map((o, idx) => {
            const isSelected = String(o.value) === String(value)
            const isActive = idx === activeIndex
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={cn(
                  'uiSelectOption',
                  isSelected && 'isSelected',
                  isActive && 'isActive',
                )}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => commit(o.value)}
              >
                <span>{o.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

