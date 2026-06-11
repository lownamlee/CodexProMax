export class WaitHub {
  private readonly waiters = new Map<string, Set<(instructionId: string | null) => void>>()

  wait(
    sessionId: string,
    timeoutMs: number | null,
    signal?: AbortSignal,
  ): Promise<{ notified: boolean; instructionId: string | null; aborted: boolean }> {
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const listeners = this.waiters.get(sessionId) ?? new Set<(instructionId: string | null) => void>()
      const done = (notified: boolean, instructionId: string | null, aborted = false) => {
        if (settled) return
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        signal?.removeEventListener('abort', abort)
        listeners.delete(notify)
        if (listeners.size === 0) {
          this.waiters.delete(sessionId)
        }
        resolve({ notified, instructionId, aborted })
      }

      const notify = (instructionId: string | null) => done(true, instructionId)
      const abort = () => done(false, null, true)
      if (signal?.aborted) {
        abort()
        return
      }
      if (timeoutMs !== null) {
        timeout = setTimeout(() => done(false, null), timeoutMs)
      }
      signal?.addEventListener('abort', abort, { once: true })
      listeners.add(notify)
      this.waiters.set(sessionId, listeners)
    })
  }

  notify(sessionId: string, instructionId: string | null = null): void {
    const listeners = [...(this.waiters.get(sessionId) ?? [])]
    for (const listener of listeners) {
      listener(instructionId)
    }
  }

  close(): void {
    for (const listeners of this.waiters.values()) {
      for (const listener of [...listeners]) {
        listener(null)
      }
    }
    this.waiters.clear()
  }
}
