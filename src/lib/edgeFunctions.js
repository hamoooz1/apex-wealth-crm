/** Extract a readable message from a Supabase edge function invoke failure. */
export async function parseInvokeError(error, data) {
  if (data?.error) return new Error(String(data.error))
  if (!error) return null

  let message = error.message || 'Request failed'

  if (error.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.json()
      if (body?.error) message = String(body.error)
    } catch {
      // ignore JSON parse errors
    }
  }

  return new Error(message)
}
