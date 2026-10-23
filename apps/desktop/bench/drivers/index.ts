// apps/desktop/bench/drivers/index.ts

import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { dshDriver } from './dsh'
import type { Driver } from './types'

export const DRIVERS: Readonly<Record<string, Driver>> = {
  [claudeDriver.name]: claudeDriver,
  [codexDriver.name]: codexDriver,
  [dshDriver.name]: dshDriver,
}

export function driverNamed(name: string): Driver {
  const d = DRIVERS[name]
  if (!d) throw new Error(`unknown driver '${name}' (have: ${Object.keys(DRIVERS).join(', ')})`)
  return d
}
