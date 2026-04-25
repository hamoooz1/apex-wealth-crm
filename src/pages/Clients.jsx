import { useEffect, useMemo, useState } from 'react'
import { fetchClientsPageData } from '../lib/queries.js'

function formatCurrency(n) {
  const v = Number(n || 0)
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function statusLabel(s) {
  if (s === 'active') return 'Active'
  if (s === 'at_risk') return 'At Risk'
  if (s === 'inactive') return 'Inactive'
  return String(s || '')
}

function statusClass(s) {
  if (s === 'active') return 'active'
  if (s === 'at_risk') return 'at-risk'
  if (s === 'inactive') return 'inactive'
  return ''
}

export default function Clients() {
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let mounted = true
    async function load() {
      setState({ loading: true, error: null, data: null })
      try {
        const data = await fetchClientsPageData()
        if (!mounted) return
        setState({ loading: false, error: null, data })
      } catch (e) {
        if (!mounted) return
        setState({ loading: false, error: e, data: null })
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  const computed = useMemo(() => {
    const clients = state.data?.clients || []
    const profiles = state.data?.profiles || []
    const profilesMap = new Map(profiles.map((p) => [p.id, p]))
    const advisorName = (profileId) => {
      const p = profilesMap.get(profileId)
      return p ? p.full_name : 'Unknown'
    }
    return { clients, advisorName }
  }, [state.data, state.loading, state.error])

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="pageTitle">Clients</h1>
          <div className="pageSubtitle">Client roster and AUM</div>
        </div>
      </div>

      <div className="card tableWrap">
        <table className="crmTable">
          <thead>
            <tr>
              <th>Client</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Advisor</th>
              <th>AUM</th>
              <th>Status</th>
              <th>Next Review Date</th>
            </tr>
          </thead>
          <tbody>
            {state.loading ? (
              <tr>
                <td colSpan={7} className="muted">
                  Loading clients…
                </td>
              </tr>
            ) : state.error ? (
              <tr>
                <td colSpan={7} className="muted">
                  Failed to load clients.
                </td>
              </tr>
            ) : computed.clients.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No clients yet.
                </td>
              </tr>
            ) : (
              computed.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="clientName">
                    <div className="avatar" aria-hidden="true" />
                    {c.first_name} {c.last_name}
                  </div>
                </td>
                <td className="muted">{c.email}</td>
                <td className="muted">{c.phone}</td>
                <td className="muted">{computed.advisorName(c.advisor_id)}</td>
                <td>{formatCurrency(c.aum)}</td>
                <td>
                  <span className={['statusPill', statusClass(c.status)].join(' ')}>
                    {statusLabel(c.status)}
                  </span>
                </td>
                <td className="muted">{c.next_review_date}</td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

