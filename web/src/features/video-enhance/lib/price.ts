/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { EnhanceFpsMultiplier, EnhanceSetting } from '../types'

/** Mirrors common.QuotaPerUnit (500 * 1000) used by the backend. */
export const QUOTA_PER_UNIT = 500 * 1000

/** Mirrors operation_setting.USDExchangeRate default. */
export const DEFAULT_USD_EXCHANGE_RATE = 7.3

/**
 * Same normalization as the backend: tiers MediaKit does not name explicitly
 * are billed one tier up rather than undercharged.
 */
export function normalizeResolutionTier(resolution: string): string {
  const value = (resolution || '').toLowerCase().replaceAll(/\s+/g, '')
  switch (value) {
    case '480p':
    case '540p':
    case 'sd':
      return '480p'
    case '720p':
    case 'hd':
      return '720p'
    case '1080p':
    case 'fhd':
    case '1080i':
      return '1080p'
    case '2k':
    case '1440p':
    case 'qhd':
      return '2k'
    case '4k':
    case '2160p':
    case 'uhd':
      return '4k'
    default:
      return '1080p'
  }
}

export function fpsMultiplier(
  fps: number,
  table: EnhanceFpsMultiplier[]
): number {
  if (!Number.isFinite(fps) || fps <= 0) return 1
  let last = 0
  for (const entry of table ?? []) {
    if (!entry || entry.max_fps <= 0 || entry.multiplier <= 0) continue
    if (fps <= entry.max_fps) return entry.multiplier
    last = entry.multiplier
  }
  return last > 0 ? last : 1
}

export function enhanceCoefficient(
  setting: EnhanceSetting,
  toolVersion: string,
  resolution: string,
  fps: number
): number {
  const table = setting.resolution_coefficients?.[toolVersion]
  if (!table) return 0
  const coefficient = table[normalizeResolutionTier(resolution)]
  if (!coefficient || coefficient <= 0) return 0
  return coefficient * fpsMultiplier(fps, setting.fps_multipliers)
}

/** Raw upstream cost in CNY for one finished enhance job. */
export function enhanceCostCNY(
  setting: EnhanceSetting,
  toolVersion: string,
  resolution: string,
  fps: number,
  seconds: number
): number {
  const price = setting.base_price_per_minute?.[toolVersion] ?? 0
  const coefficient = enhanceCoefficient(
    setting,
    toolVersion,
    resolution,
    fps
  )
  if (price <= 0 || coefficient <= 0 || seconds <= 0) return 0
  return (seconds / 60) * coefficient * price
}

/** Local quota charged to the customer, including the configured markup. */
export function enhanceQuotaForUsage(
  setting: EnhanceSetting,
  toolVersion: string,
  resolution: string,
  fps: number,
  seconds: number,
  exchangeRate: number = DEFAULT_USD_EXCHANGE_RATE
): number {
  const cost = enhanceCostCNY(setting, toolVersion, resolution, fps, seconds)
  if (cost <= 0) return 0
  const markup = setting.markup > 0 ? setting.markup : 1
  const rate =
    exchangeRate > 0 ? exchangeRate : DEFAULT_USD_EXCHANGE_RATE
  const quota = ((cost * markup) / rate) * QUOTA_PER_UNIT
  if (!Number.isFinite(quota) || quota <= 0) return 0
  // The backend converts the float quota by truncation, so the estimator must
  // truncate too or it would disagree with the billed amount by one unit.
  return Math.max(1, Math.floor(quota))
}
