export class WaitHub {
  private readonly waiters = new Map<string, Set<(instructionId: string | null) => void>>()

  wait(sessionId: string, timeoutMs: number | null): Promise<{ notified: boolean; instructionId: string | null }> {
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      const done = (notified: boolean, instructionId: string | null) => {
        if (timeout) {
          clearTimeout(timeout)
        }
        listeners.delete(notify)
        if (listeners.size === 0) {
          this.waiters.delete(sessionId)
        }
        resolve({ notified, instructionId })
      }

      const notify = (instructionId: string | null) => done(true, instructionId)
      if (timeoutMs !== null) {
        timeout = setTimeout(() => done(false, null), timeoutMs)
      }
      const listeners = this.waiters.get(sessionId) ?? new Set<(instructionId: string | null) => void>()
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
