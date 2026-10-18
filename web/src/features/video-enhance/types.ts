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
export type EnhanceModelRule = {
  models: string[]
  tool_version: string
  resolution: string
  fps: number
  scene: string
}

export type EnhanceFpsMultiplier = {
  max_fps: number
  multiplier: number
}

export type EnhanceSetting = {
  enabled: boolean
  exclude_models: string[]
  rules: EnhanceModelRule[]
  base_url: string
  channel_id: number
  output_bucket: string
  public_base_url: string
  tos_region: string
  presign_ttl_seconds: number
  base_price_per_minute: Record<string, number>
  resolution_coefficients: Record<string, Record<string, number>>
  fps_multipliers: EnhanceFpsMultiplier[]
  markup: number
  timeout_minutes: number
  max_retries: number
  on_failure: string
}

export type EnhanceSecrets = {
  hasTosAccessKey: boolean
  hasTosSecretKey: boolean
}

export type EnhanceSecretDraft = {
  accessKey: string
  secretKey: string
  clear: boolean
}

export type EnhanceSnapshot = {
  setting: EnhanceSetting
  secrets: EnhanceSecrets
  raw: Record<string, string>
}

export type EnhanceFieldEntry = {
  field: string
  value: string
}
