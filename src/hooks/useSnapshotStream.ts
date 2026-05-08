import { useEffect, useState } from 'react'
import { fetchSnapshot } from '../api'
import type { ManagerSnapshot } from '../shared/protocol'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export function useSnapshotStream() {
  const [snapshot, setSnapshot] = useState<ManagerSnapshot | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false

    fetchSnapshot()
      .then((nextSnapshot) => {
        if (!ignore) {
          setSnapshot(nextSnapshot)
        }
      })
      .catch((snapshotError: unknown) => {
        if (!ignore) {
          setError(snapshotError instanceof Error ? snapshotError.message : 'Snapshot request failed')
        }
      })

    const events = new EventSource('/api/events')

    events.onopen = () => {
      if (!ignore) {
        setConnectionState('open')
        setError(null)
      }
    }

    events.onerror = () => {
      if (!ignore) {
        setConnectionState('reconnecting')
        setError(null)
      }
    }

    events.addEventListener('snapshot', (event) => {
      if (!ignore) {
        setSnapshot(JSON.parse(event.data) as ManagerSnapshot)
        setError(null)
      }
    })

    return () => {
      ignore = true
      events.close()
      setConnectionState('closed')
    }
  }, [])

  return {
    snapshot,
    setSnapshot,
    connectionState,
    error,
  }
}
