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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  FPS_OPTIONS,
  RESOLUTION_TIER_OPTIONS,
  TOOL_VERSION_OPTIONS,
} from '../api'
import {
  DEFAULT_USD_EXCHANGE_RATE,
  enhanceCostCNY,
  enhanceQuotaForUsage,
} from '../lib/price'
import type { EnhanceSetting } from '../types'

type PricingSectionProps = {
  setting: EnhanceSetting
  onChange: (patch: Partial<EnhanceSetting>) => void
  disabled?: boolean
}

function NumberField(props: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  step?: string
  className?: string
  ariaLabel?: string
}) {
  return (
    <Input
      type='number'
      inputMode='decimal'
      step={props.step ?? 'any'}
      aria-label={props.ariaLabel}
      className={props.className}
      value={Number.isFinite(props.value) ? String(props.value) : ''}
      disabled={props.disabled}
      onChange={(event) => {
        const parsed = Number(event.target.value)
        props.onChange(Number.isFinite(parsed) ? parsed : 0)
      }}
    />
  )
}

export function PricingSection(props: PricingSectionProps) {
  const { t } = useTranslation()
  const { setting, onChange, disabled } = props
  const [estimate, setEstimate] = useState({
    toolVersion: 'standard',
    resolution: '720p',
    fps: 30,
    seconds: 5,
  })

  const cost = enhanceCostCNY(
    setting,
    estimate.toolVersion,
    estimate.resolution,
    estimate.fps,
    estimate.seconds
  )
  const quota = enhanceQuotaForUsage(
    setting,
    estimate.toolVersion,
    estimate.resolution,
    estimate.fps,
    estimate.seconds
  )

  const priceTable = { ...setting.base_price_per_minute }
  const coefficientTable = { ...setting.resolution_coefficients }

  return (
    <div className='space-y-5'>
      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='enhance-markup'>{t('Markup')}</Label>
          <NumberField
            value={setting.markup}
            step='0.01'
            disabled={disabled}
            ariaLabel={t('Markup')}
            onChange={(markup) => onChange({ markup })}
          />
          <p className='text-muted-foreground text-xs'>
            {t('1.15 charges the customer 15% above the upstream cost.')}
          </p>
        </div>
      </div>

      <Separator />

      <div className='space-y-2'>
        <Label>{t('Upstream price (CNY per minute)')}</Label>
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {TOOL_VERSION_OPTIONS.map((version) => (
            <div key={version} className='space-y-1'>
              <span className='text-muted-foreground text-xs'>{version}</span>
              <NumberField
                value={priceTable[version] ?? 0}
                step='0.01'
                disabled={disabled}
                ariaLabel={version}
                onChange={(value) =>
                  onChange({
                    base_price_per_minute: { ...priceTable, [version]: value },
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div className='space-y-2'>
        <Label>{t('Resolution coefficients')}</Label>
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[560px] text-sm'>
            <thead>
              <tr className='text-muted-foreground text-xs'>
                <th className='px-1 py-1 text-start font-medium'>
                  {t('Tool version')}
                </th>
                {RESOLUTION_TIER_OPTIONS.map((tier) => (
                  <th key={tier} className='px-1 py-1 text-start font-medium'>
                    {tier}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TOOL_VERSION_OPTIONS.map((version) => (
                <tr key={version}>
                  <td className='text-muted-foreground px-1 py-1 text-xs'>
                    {version}
                  </td>
                  {RESOLUTION_TIER_OPTIONS.map((tier) => (
                    <td key={tier} className='px-1 py-1'>
                      <NumberField
                        value={coefficientTable[version]?.[tier] ?? 0}
                        disabled={disabled}
                        ariaLabel={`${version} ${tier}`}
                        className='h-8 w-20'
                        onChange={(value) =>
                          onChange({
                            resolution_coefficients: {
                              ...coefficientTable,
                              [version]: {
                                ...coefficientTable[version],
                                [tier]: value,
                              },
                            },
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className='space-y-2'>
        <Label>{t('Frame rate multipliers')}</Label>
        <div className='grid gap-3 sm:grid-cols-3'>
          {setting.fps_multipliers.map((entry, index) => (
            <div key={entry.max_fps} className='space-y-1'>
              <span className='text-muted-foreground text-xs'>
                {`<= ${entry.max_fps} fps`}
              </span>
              <NumberField
                value={entry.multiplier}
                disabled={disabled}
                ariaLabel={`multiplier ${entry.max_fps}`}
                onChange={(value) =>
                  onChange({
                    fps_multipliers: setting.fps_multipliers.map((item, i) =>
                      i === index ? { ...item, multiplier: value } : item
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>

      <Separator />

      <div className='space-y-3'>
        <Label>{t('Cost estimator')}</Label>
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <Select
            value={estimate.toolVersion}
            onValueChange={(toolVersion) => {
              if (toolVersion) {
                setEstimate((previous) => ({ ...previous, toolVersion }))
              }
            }}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOOL_VERSION_OPTIONS.map((version) => (
                <SelectItem key={version} value={version}>
                  {version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={estimate.resolution}
            onValueChange={(resolution) => {
              if (resolution) {
                setEstimate((previous) => ({ ...previous, resolution }))
              }
            }}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_TIER_OPTIONS.map((tier) => (
                <SelectItem key={tier} value={tier}>
                  {tier}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(estimate.fps)}
            onValueChange={(fps) =>
              setEstimate((previous) => ({ ...previous, fps: Number(fps) }))
            }
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FPS_OPTIONS.filter((fps) => fps > 0).map((fps) => (
                <SelectItem key={fps} value={String(fps)}>
                  {`${fps} fps`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className='space-y-1'>
            <span className='text-muted-foreground text-xs'>
              {t('Duration (seconds)')}
            </span>
            <NumberField
              value={estimate.seconds}
              step='0.1'
              ariaLabel={t('Duration (seconds)')}
              onChange={(seconds) =>
                setEstimate((previous) => ({ ...previous, seconds }))
              }
            />
          </div>
        </div>
        <p className='text-sm'>
          {t('Upstream cost')}: <strong>¥{cost.toFixed(4)}</strong>
          <span className='text-muted-foreground'>
            {' · '}
            {t('Local charge')}: <strong>{quota.toLocaleString()}</strong>{' '}
            {t('quota')}
          </span>
        </p>
        <p className='text-muted-foreground text-xs'>
          {t('Estimated with exchange rate {{rate}}.', {
            rate: DEFAULT_USD_EXCHANGE_RATE,
          })}
        </p>
      </div>
    </div>
  )
}
