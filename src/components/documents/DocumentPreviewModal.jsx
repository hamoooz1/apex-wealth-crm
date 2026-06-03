import { Download, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatFileSize, getDocumentDownloadUrl, getDocumentPreviewKind } from '../../lib/documents.js'

const TEXT_PREVIEW_LIMIT = 512 * 1024

export default function DocumentPreviewModal({ doc, open, onClose }) {
  const [url, setUrl] = useState(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const kind = doc ? getDocumentPreviewKind(doc) : 'none'

  useEffect(() => {
    if (!open) return
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!open || !doc?.storage_path) {
        setUrl(null)
        setText('')
        setError(null)
        return
      }
      setLoading(true)
      setError(null)
      setUrl(null)
      setText('')
      try {
        const signed = await getDocumentDownloadUrl(doc.storage_path)
        if (!mounted) return
        setUrl(signed)
        if (kind === 'text' && signed) {
          if (doc.file_size && doc.file_size > TEXT_PREVIEW_LIMIT) {
            setText('')
          } else {
            const res = await fetch(signed)
            if (!res.ok) throw new Error('Could not load file for preview.')
            const body = await res.text()
            if (mounted) setText(body)
          }
        }
      } catch (e) {
        if (mounted) setError(e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [open, doc?.storage_path, doc?.file_size, kind])

  if (!open || !doc) return null

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modalCard docPreviewModal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">{doc.file_name}</div>
            <div className="modalSub">
              {formatFileSize(doc.file_size)}
              {kind === 'none' ? ' · Preview not available for this file type' : ''}
            </div>
          </div>
          <div className="docPreviewActions">
            {url ? (
              <a className="btnSecondary" href={url} target="_blank" rel="noreferrer" download={doc.file_name}>
                <Download size={16} /> Download
              </a>
            ) : null}
            <button className="iconBtn" type="button" onClick={onClose} aria-label="Close preview">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="modalBody docPreviewBody">
          {loading ? <div className="docPreviewEmpty">Loading preview…</div> : null}
          {!loading && error ? (
            <div className="inlineError">{error.message || 'Failed to load preview.'}</div>
          ) : null}

          {!loading && !error && kind === 'pdf' && url ? (
            <iframe className="docPreviewFrame" src={url} title={doc.file_name} />
          ) : null}

          {!loading && !error && kind === 'image' && url ? (
            <div className="docPreviewImageWrap">
              <img className="docPreviewImage" src={url} alt={doc.file_name} />
            </div>
          ) : null}

          {!loading && !error && kind === 'text' && url ? (
            doc.file_size && doc.file_size > TEXT_PREVIEW_LIMIT ? (
              <div className="docPreviewEmpty">
                File is too large to preview inline. Use Download instead.
              </div>
            ) : (
              <pre className="docPreviewText">{text || '(empty file)'}</pre>
            )
          ) : null}

          {!loading && !error && kind === 'none' ? (
            <div className="docPreviewEmpty">
              Word, Excel, and other Office files cannot be previewed in the browser yet. Download the
              file to open it locally.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
