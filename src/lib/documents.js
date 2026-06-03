import { supabase } from './supabaseClient.js'

const BUCKET = 'client-documents'

function safeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

export async function getClientDocuments(clientId) {
  if (!clientId) return []
  const { data, error } = await supabase
    .from('client_documents')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function uploadClientDocument({ clientId, userId, file }) {
  if (!clientId || !userId || !file) throw new Error('Missing upload details.')
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
  const path = `${clientId}/${crypto.randomUUID()}${ext}`
  const storagePath = path

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  })
  if (upErr) throw upErr

  const { data, error } = await supabase
    .from('client_documents')
    .insert({
      client_id: clientId,
      uploaded_by: userId,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type || null,
      file_size: file.size || null,
    })
    .select('*')
    .maybeSingle()
  if (error) {
    await supabase.storage.from(BUCKET).remove([path])
    throw error
  }
  return data
}

export async function getDocumentDownloadUrl(storagePath, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, expiresIn)
  if (error) throw error
  return data?.signedUrl || null
}

export async function deleteClientDocument(doc) {
  if (!doc?.id || !doc?.storage_path) throw new Error('Missing document.')
  const { error: storageErr } = await supabase.storage.from(BUCKET).remove([doc.storage_path])
  if (storageErr) throw storageErr
  const { error } = await supabase.from('client_documents').delete().eq('id', doc.id)
  if (error) throw error
  return true
}

export function formatFileSize(bytes) {
  const n = Number(bytes || 0)
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function getDocumentPreviewKind(doc) {
  const mime = String(doc?.mime_type || '').toLowerCase()
  const name = String(doc?.file_name || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (
    mime.startsWith('text/') ||
    mime === 'application/csv' ||
    /\.(txt|csv|md|json|log)$/i.test(name)
  ) {
    return 'text'
  }
  return 'none'
}
