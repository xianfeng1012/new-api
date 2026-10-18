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
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  FPS_OPTIONS,
  OUTPUT_RESOLUTION_OPTIONS,
  SUPPORTED_TOOL_VERSIONS,
  isSupportedToolVersion,
} from '../api'
import type { EnhanceModelRule } from '../types'

type RulesEditorProps = {
  rules: EnhanceModelRule[]
  modelOptions: string[]
  onChange: (rules: EnhanceModelRule[]) => void
  disabled?: boolean
}

const emptyRule = (): EnhanceModelRule => ({
  models: [],
  tool_version: 'standard',
  resolution: 'auto',
  fps: 0,
  scene: 'aigc',
})

export function RulesEditor(props: RulesEditorProps) {
  const { t } = useTranslation()
  const { rules, modelOptions, onChange, disabled } = props
  const options = modelOptions.map((model) => ({ label: model, value: model }))

  const update = (index: number, patch: Partial<EnhanceModelRule>) => {
    onChange(
      rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    )
  }

  const move = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= rules.length) return
    const next = [...rules]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onChange(next)
  }

  return (
    <div className='space-y-3'>
      {rules.length === 0 && (
        <p className='text-muted-foreground text-sm'>
          {t('No rule matches any model, so nothing is enhanced.')}
        </p>
      )}
      {rules.map((rule, index) => (
        <div
          key={`${rule.models.join('|')}#${rule.tool_version}#${rule.resolution}#${rule.fps}#${rule.scene}`}
          className='rounded-md border p-3'
          data-testid={`enhance-rule-${index}`}
        >
          <div className='mb-3 flex items-center justify-between gap-2'>
            <span className='text-muted-foreground text-xs font-medium'>
              {t('Rule')} #{index + 1}
            </span>
            <div className='flex items-center gap-1'>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                aria-label={t('Move up')}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className='h-4 w-4' />
              </Button>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                aria-label={t('Move down')}
                disabled={disabled || index === rules.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className='h-4 w-4' />
              </Button>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                aria-label={t('Remove')}
                disabled={disabled}
                onClick={() => onChange(rules.filter((_, i) => i !== index))}
              >
                <Trash2 className='h-4 w-4' />
              </Button>
            </div>
          </div>
          <div className='grid gap-3 lg:grid-cols-2'>
            <div className='space-y-1.5 lg:col-span-2'>
              <Label>{t('Models')}</Label>
              <MultiSelect
                options={options}
                selected={rule.models}
                allowCreate
                disabled={disabled}
                placeholder={t('Select models, or type a name and press Enter')}
                onChange={(models) => update(index, { models })}
              />
            </div>
            <div className='space-y-1.5'>
              <Label>{t('Tool version')}</Label>
              <Select
                value={rule.tool_version || 'standard'}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value) update(index, { tool_version: value })
                }}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_TOOL_VERSIONS.map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!isSupportedToolVersion(rule.tool_version) && (
                <p className='text-destructive text-xs'>
                  {t(
                    'MediaKit only accepts standard or professional; this value falls back to standard.'
                  )}
                </p>
              )}
            </div>
            <div className='space-y-1.5'>
              <Label>{t('Output resolution')}</Label>
              <Select
                value={rule.resolution || 'auto'}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value) update(index, { resolution: value })
                }}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTPUT_RESOLUTION_OPTIONS.map((resolution) => (
                    <SelectItem key={resolution} value={resolution}>
                      {resolution === 'auto'
                        ? t('Auto (MediaKit default)')
                        : resolution}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label>{t('Frame rate')}</Label>
              <Select
                value={String(rule.fps ?? 0)}
                disabled={disabled}
                onValueChange={(value) => update(index, { fps: Number(value) })}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FPS_OPTIONS.map((fps) => (
                    <SelectItem key={fps} value={String(fps)}>
                      {fps === 0
                        ? t('Keep source frame rate')
                        : `${fps} fps`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-1.5'>
              <Label>{t('Scene')}</Label>
              <Input
                value={rule.scene ?? ''}
                disabled={disabled}
                placeholder='aigc'
                onChange={(event) => update(index, { scene: event.target.value })}
              />
            </div>
          </div>
        </div>
      ))}
      <Button
        type='button'
        variant='outline'
        disabled={disabled}
        onClick={() => onChange([...rules, emptyRule()])}
      >
        <Plus className='mr-1 h-4 w-4' />
        {t('Add rule')}
      </Button>
    </div>
  )
}
