import type { AppSettings } from '../../shared/contracts'

type Preferences = Pick<
  AppSettings,
  'preventSleepDuringRequests' | 'sleepReleaseDelaySeconds' | 'sleepOnlyOnAC'
>
interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): boolean
}

/** One system assertion for all concurrent requests, including the idle grace period. */
export class RequestSleepBlocker {
  private count = 0
  private id: number | undefined
  private idleSince: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private onBatteryPower = false

  constructor(
    private readonly power: PowerBlocker,
    private preferences: Preferences
  ) {}

  configure(preferences: Preferences): void {
    this.preferences = preferences
    this.reconcile()
  }

  setOnBatteryPower(value: boolean): void {
    this.onBatteryPower = value
    this.reconcile()
  }

  setActiveRequests(count: number): void {
    if (this.count > 0 && count === 0) this.idleSince = Date.now()
    if (count > 0) this.idleSince = undefined
    this.count = count
    this.reconcile()
  }

  private reconcile(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (
      this.disposed ||
      !this.preferences.preventSleepDuringRequests ||
      (this.preferences.sleepOnlyOnAC && this.onBatteryPower)
    ) {
      this.release()
      return
    }
    if (this.count > 0) {
      if (this.id === undefined) {
        // OS failures must never interrupt a gateway request or its cleanup.
        try {
          this.id = this.power.start('prevent-app-suspension')
        } catch (error) {
          console.warn('无法阻止系统休眠：', error)
        }
      }
      return
    }
    if (this.id === undefined || this.idleSince === undefined) return
    const remaining =
      this.preferences.sleepReleaseDelaySeconds * 1000 - (Date.now() - this.idleSince)
    if (remaining <= 0) this.release()
    else {
      this.timer = setTimeout(() => this.reconcile(), remaining)
      this.timer.unref()
    }
  }

  private release(): void {
    if (this.id === undefined) return
    try {
      this.power.stop(this.id)
      this.id = undefined
    } catch (error) {
      console.warn('无法释放系统休眠阻止：', error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.reconcile()
  }
}
