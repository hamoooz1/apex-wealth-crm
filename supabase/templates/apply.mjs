#!/usr/bin/env node
/**
 * Push invite + password-reset email templates to the linked Supabase project.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... node supabase/templates/apply.mjs
 *
 * Or after `npx supabase login`, this script reads the CLI token automatically.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_REF = 'aambpahxxymxxgqijude'
const __dirname = dirname(fileURLToPath(import.meta.url))

function loadCliToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN
  const candidates = [
    join(homedir(), '.supabase', 'access-token'),
    join(homedir(), 'AppData', 'Roaming', 'supabase', 'access-token'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf8').trim()
      if (t) return t
    }
  }
  return null
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const token = loadCliToken()
if (!token) {
  console.error('Missing SUPABASE_ACCESS_TOKEN. Run: npx supabase login')
  process.exit(1)
}

const inviteHtml = minifyHtml(readFileSync(join(__dirname, 'invite.html'), 'utf8'))
const recoveryHtml = minifyHtml(readFileSync(join(__dirname, 'recovery.html'), 'utf8'))

const body = {
  mailer_subjects_invite: 'You’re invited to Apex Wealth CRM',
  mailer_templates_invite_content: inviteHtml,
  mailer_subjects_recovery: 'Reset your Apex Wealth password',
  mailer_templates_recovery_content: recoveryHtml,
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

if (!res.ok) {
  const text = await res.text()
  console.error(`Failed to update auth email templates (${res.status}):`, text)
  process.exit(1)
}

console.log('Updated Supabase Auth email templates:')
console.log('  - Invite (onboarding)')
console.log('  - Recovery (password reset)')
console.log(`Dashboard: https://supabase.com/dashboard/project/${PROJECT_REF}/auth/templates`)
