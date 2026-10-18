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
import { api } from '@/lib/api'
import { createServerError } from '@/lib/server-error-message'

import type {
  EnhanceFieldEntry,
  EnhanceFpsMultiplier,
  EnhanceModelRule,
  EnhanceSecretDraft,
  EnhanceSetting,
  EnhanceSnapshot,
} from './types'

export const ENHANCE_OPTION_PREFIX = 'task_enhance_setting.'

export const TOOL_VERSION_OPTIONS = [
  'standard',
  'professional',
  'fast',
  'generative',
] as const

/**
 * MediaKit's enhance-video endpoint only accepts these tiers. Rules may hold a
 * stale value from an earlier config, so the editor flags it and the backend
 * downgrades it to "standard" instead of failing every job.
 */
export const SUPPORTED_TOOL_VERSIONS = ['standard', 'professional'] as const

export function isSupportedToolVersion(version: string | undefined): boolean {
  const value = (version ?? '').trim().toLowerCase()
  return value === '' || (SUPPORTED_TOOL_VERSIONS as readonly string[]).includes(value)
}

export const RESOLUTION_TIER_OPTIONS = [
  '480p',
  '720p',
  '1080p',
  '2k',
  '4k',
] as const

export const OUTPUT_RESOLUTION_OPTIONS = [
  'auto',
  '720p',
  '1080p',
  '2k',
  '4k',
] as const

export const FPS_OPTIONS = [0, 30, 60, 120] as const

export const ON_FAILURE_OPTIONS = ['deliver_original'] as const

/**
 * Mirrors the backend defaults in setting/task_enhance_setting/config.go so an
 * unset option group still renders a complete form.
 */
export const ENHANCE_DEFAULTS: EnhanceSetting = {
  enabled: false,
  exclude_models: [],
  rules: [{ models: ['*'], tool_version: 'standard', resolution: 'auto', fps: 0, scene: 'aigc' }],
  base_url: 'https://mediakit.cn-beijing.volces.com',
  channel_id: 0,
  output_bucket: '',
  public_base_url: '',
  tos_region: 'cn-beijing',
  presign_ttl_seconds: 604800,
  base_price_per_minute: {
    standard: 0.75,
    professional: 0.75,
    fast: 0.2,
    generative: 2.5,
  },
  resolution_coefficients: {
    standard: { '480p': 1, '720p': 1, '1080p': 2, '2k': 4, '4k': 8 },
    professional: { '480p': 10, '720p': 10, '1080p': 20, '2k': 40, '4k': 80 },
    fast: { '480p': 1, '720p': 1, '1080p': 2, '2k': 4, '4k': 8 },
    generative: { '480p': 1, '720p': 1, '1080p': 2, '2k': 4, '4k': 8 },
  },
  fps_multipliers: [
    { max_fps: 30, multiplier: 1 },
    { max_fps: 60, multiplier: 2 },
    { max_fps: 120, multiplier: 4 },
  ],
  markup: 1.15,
  timeout_minutes: 30,
  max_retries: 2,
  on_failure: 'deliver_original',
}

const JSON_FIELDS = new Set([
  'rules',
  'exclude_models',
  'base_price_per_minute',
  'resolution_coefficients',
  'fps_multipliers',
])

/**
 * Fields the page owns. "enabled" is intentionally excluded: the switch saves
 * on its own so an accidental form submit can never flip the whole feature.
 */
const MANAGED_FIELDS = [
  'rules',
  'exclude_models',
  'markup',
  'base_price_per_minute',
  'resolution_coefficients',
  'fps_multipliers',
  'output_bucket',
  'public_base_url',
  'tos_region',
  'presign_ttl_seconds',
  'channel_id',
  'base_url',
  'timeout_minutes',
  'max_retries',
  'on_failure',
] as const

type OptionRow = { key: string; value: string }
type OptionListResponse = {
  success?: boolean
  message?: string
  data?: OptionRow[]
}
type MutationResponse = { success?: boolean; message?: string }

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toText(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value
}

function parseSetting(raw: Record<string, string>): EnhanceSetting {
  return {
    enabled: raw.enabled === 'true',
    exclude_models: parseJson<string[]>(
      raw.exclude_models,
      ENHANCE_DEFAULTS.exclude_models
    ),
    rules: parseJson<EnhanceModelRule[]>(raw.rules, ENHANCE_DEFAULTS.rules),
    base_url: toText(raw.base_url, ENHANCE_DEFAULTS.base_url),
    channel_id: toNumber(raw.channel_id, ENHANCE_DEFAULTS.channel_id),
    output_bucket: toText(raw.output_bucket, ENHANCE_DEFAULTS.output_bucket),
    public_base_url: toText(
      raw.public_base_url,
      ENHANCE_DEFAULTS.public_base_url
    ),
    tos_region: toText(raw.tos_region, ENHANCE_DEFAULTS.tos_region),
    presign_ttl_seconds: toNumber(
      raw.presign_ttl_seconds,
      ENHANCE_DEFAULTS.presign_ttl_seconds
    ),
    base_price_per_minute: parseJson<Record<string, number>>(
      raw.base_price_per_minute,
      ENHANCE_DEFAULTS.base_price_per_minute
    ),
    resolution_coefficients: parseJson<Record<string, Record<string, number>>>(
      raw.resolution_coefficients,
      ENHANCE_DEFAULTS.resolution_coefficients
    ),
    fps_multipliers: parseJson<EnhanceFpsMultiplier[]>(
      raw.fps_multipliers,
      ENHANCE_DEFAULTS.fps_multipliers
    ),
    markup: toNumber(raw.markup, ENHANCE_DEFAULTS.markup),
    timeout_minutes: toNumber(
      raw.timeout_minutes,
      ENHANCE_DEFAULTS.timeout_minutes
    ),
    max_retries: toNumber(raw.max_retries, ENHANCE_DEFAULTS.max_retries),
    on_failure: toText(raw.on_failure, ENHANCE_DEFAULTS.on_failure),
  }
}

/** The layered settings live as individual "group.field" option rows. */
export async function fetchEnhanceSnapshot(): Promise<EnhanceSnapshot> {
  const res = await api.get<OptionListResponse>('/api/option/')
  if (res.data?.success === false) throw createServerError(res.data)
  const rows = res.data?.data ?? []
  const raw: Record<string, string> = {}
  for (const row of rows) {
    if (typeof row?.key !== 'string') continue
    if (!row.key.startsWith(ENHANCE_OPTION_PREFIX)) continue
    raw[row.key.slice(ENHANCE_OPTION_PREFIX.length)] = row.value ?? ''
  }
  return {
    setting: parseSetting(raw),
    secrets: {
      hasTosAccessKey: Boolean(raw.tos_access_key),
      hasTosSecretKey: Boolean(raw.tos_secret_key),
    },
    raw,
  }
}

export function serializeEnhanceValue(field: string, value: unknown): string {
  if (JSON_FIELDS.has(field)) return JSON.stringify(value ?? null)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return String(value ?? '')
}

function serializeSettingField(
  setting: EnhanceSetting,
  field: (typeof MANAGED_FIELDS)[number]
): string {
  return serializeEnhanceValue(field, setting[field])
}

/**
 * Dirty-diff: only changed fields are submitted, so browsing this page can
 * never rewrite (or reset) untouched settings.
 */
export function buildEnhanceDiff(
  saved: EnhanceSetting,
  draft: EnhanceSetting,
  secretDraft: EnhanceSecretDraft
): EnhanceFieldEntry[] {
  const entries: EnhanceFieldEntry[] = []
  for (const field of MANAGED_FIELDS) {
    const next = serializeSettingField(draft, field)
    const current = serializeSettingField(saved, field)
    if (next !== current) entries.push({ field, value: next })
  }
  if (secretDraft.clear) {
    entries.push({ field: 'tos_access_key', value: '' })
    entries.push({ field: 'tos_secret_key', value: '' })
  } else {
    if (secretDraft.accessKey) {
      entries.push({ field: 'tos_access_key', value: secretDraft.accessKey })
    }
    if (secretDraft.secretKey) {
      entries.push({ field: 'tos_secret_key', value: secretDraft.secretKey })
    }
  }
  return entries
}

/**
 * Writes one field at a time (immediate, no restart) and then reads the values
 * back, returning any field the server did not persist verbatim.
 */
export async function updateEnhanceFields(
  entries: EnhanceFieldEntry[]
): Promise<string[]> {
  for (const entry of entries) {
    const res = await api.put<MutationResponse>('/api/option/', {
      key: ENHANCE_OPTION_PREFIX + entry.field,
      value: entry.value,
    })
    if (res.data?.success === false) throw createServerError(res.data)
  }
  if (entries.length === 0) return []
  const { raw } = await fetchEnhanceSnapshot()
  return entries
    .filter((entry) => (raw[entry.field] ?? '') !== entry.value)
    .map((entry) => entry.field)
}

/** Model names used as suggestions for the rule editor (free text still allowed). */
export async function fetchModelSuggestions(): Promise<string[]> {
  try {
    const res = await api.get<{ success?: boolean; data?: string[] }>(
      '/api/user/models'
    )
    const models = res.data?.data ?? []
    return [...new Set(models)].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}
