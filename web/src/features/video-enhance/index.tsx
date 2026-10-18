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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SectionPageLayout } from '@/components/layout'
import { MultiSelect } from '@/components/multi-select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { handleServerError } from '@/lib/handle-server-error'

import {
  buildEnhanceDiff,
  fetchEnhanceSnapshot,
  fetchModelSuggestions,
  isSupportedToolVersion,
  updateEnhanceFields,
} from './api'
import { AdvancedSection } from './components/advanced-section'
import { OutputSection } from './components/output-section'
import { PricingSection } from './components/pricing-section'
import { RulesEditor } from './components/rules-editor'
import type { EnhanceSecretDraft, EnhanceSetting } from './types'

const EMPTY_SECRET_DRAFT: EnhanceSecretDraft = {
  accessKey: '',
  secretKey: '',
  clear: false,
}

export function VideoEnhance() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<EnhanceSetting | null>(null)
  const [secretDraft, setSecretDraft] =
    useState<EnhanceSecretDraft>(EMPTY_SECRET_DRAFT)
  const [confirmDisable, setConfirmDisable] = useState(false)

  const snapshotQuery = useQuery({
    queryKey: ['video-enhance-settings'],
    queryFn: fetchEnhanceSnapshot,
  })
  const modelsQuery = useQuery({
    queryKey: ['video-enhance-models'],
    queryFn: fetchModelSuggestions,
  })

  useEffect(() => {
    if (snapshotQuery.data) setDraft(snapshotQuery.data.setting)
  }, [snapshotQuery.data])

  const entries = useMemo(() => {
    if (!draft || !snapshotQuery.data) return []
    return buildEnhanceDiff(snapshotQuery.data.setting, draft, secretDraft)
  }, [draft, secretDraft, snapshotQuery.data])

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['video-enhance-settings'] })

  const reportMismatch = (mismatched: string[]) => {
    if (mismatched.length === 0) return false
    toast.error(
      t('These fields were not saved: {{fields}}', {
        fields: mismatched.join(', '),
      })
    )
    return true
  }

  const saveMutation = useMutation({
    mutationFn: () => updateEnhanceFields(entries),
    onSuccess: async (mismatched) => {
      setSecretDraft(EMPTY_SECRET_DRAFT)
      await invalidate()
      if (!reportMismatch(mismatched)) toast.success(t('Enhance setting updated'))
    },
    onError: (error) => handleServerError(error),
  })

  const switchMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      updateEnhanceFields([
        { field: 'enabled', value: enabled ? 'true' : 'false' },
      ]),
    onSuccess: async (mismatched) => {
      await invalidate()
      if (!reportMismatch(mismatched)) {
        toast.success(t('Enhance switch updated'))
      }
    },
    onError: (error) => handleServerError(error),
  })

  const setting = draft
  const enabled = snapshotQuery.data?.setting.enabled ?? false
  const busy = saveMutation.isPending || switchMutation.isPending
  const mentionsAllModels = (setting?.rules ?? []).some((rule) =>
    rule.models.includes('*')
  )
  const hasEmptyRule = (setting?.rules ?? []).some(
    (rule) => rule.models.length === 0
  )
  const hasUnsupportedToolVersion = (setting?.rules ?? []).some(
    (rule) => !isSupportedToolVersion(rule.tool_version)
  )
  const markupPercent = setting
    ? Math.round(((setting.markup > 0 ? setting.markup : 1) - 1) * 100)
    : 0

  const patchDraft = (patch: Partial<EnhanceSetting>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous))

  return (
    <>
      <SectionPageLayout stackActionsOnMobile>
        <SectionPageLayout.Title>{t('Video Enhance')}</SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <div className='flex flex-wrap items-center justify-end gap-2'>
            <div className='flex items-center gap-2'>
              <Switch
                id='enhance-master-switch'
                checked={enabled}
                disabled={snapshotQuery.isLoading || switchMutation.isPending}
                onCheckedChange={(checked) => {
                  if (checked) switchMutation.mutate(true)
                  else setConfirmDisable(true)
                }}
              />
              <Label htmlFor='enhance-master-switch'>
                {t('Enhance switch')}
              </Label>
            </div>
            <Button
              variant='outline'
              disabled={entries.length === 0 || busy}
              onClick={() => {
                setDraft(snapshotQuery.data?.setting ?? null)
                setSecretDraft(EMPTY_SECRET_DRAFT)
              }}
            >
              {t('Discard changes')}
            </Button>
            <Button
              disabled={entries.length === 0 || busy}
              onClick={() => saveMutation.mutate()}
            >
              {entries.length === 0
                ? t('Save changes')
                : t('Save changes ({{count}})', { count: entries.length })}
            </Button>
          </div>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          {snapshotQuery.isLoading || !setting ? (
            <div className='space-y-4'>
              <Skeleton className='h-24 w-full' />
              <Skeleton className='h-64 w-full' />
            </div>
          ) : (
            <div className='space-y-4'>
              <Card>
                <CardHeader>
                  <CardTitle>{t('Current status')}</CardTitle>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <div className='flex flex-wrap items-center gap-2 text-sm'>
                    <Badge variant={enabled ? 'default' : 'outline'}>
                      {enabled ? t('Enabled') : t('Disabled')}
                    </Badge>
                    <Badge variant='secondary'>
                      {t('Rules: {{count}}', {
                        count: setting.rules.length,
                      })}
                    </Badge>
                    <Badge variant='secondary'>
                      {t('Markup +{{percent}}%', { percent: markupPercent })}
                    </Badge>
                    <Badge variant='secondary'>
                      {setting.output_bucket
                        ? setting.output_bucket
                        : t('24h temporary links')}
                    </Badge>
                  </div>
                  <p className='text-muted-foreground text-xs'>
                    {t(
                      'Changes are applied immediately - no restart needed. Rules are evaluated in order, and the first rule that matches a model wins.'
                    )}
                  </p>
                  {mentionsAllModels && (
                    <Alert>
                      <AlertDescription>
                        {t(
                          'A rule with "*" matches every video model, so every generated video is enhanced and charged with the markup.'
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  {hasUnsupportedToolVersion && (
                    <Alert variant='destructive'>
                      <AlertDescription>
                        {t(
                          'A rule uses a tool version MediaKit rejects, so those tasks only get the original video. Fix the tool version below.'
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  {hasEmptyRule && (
                    <Alert variant='destructive'>
                      <AlertDescription>
                        {t(
                          'A rule without any model never matches. Select at least one model or remove the rule.'
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('Trigger rules')}</CardTitle>
                </CardHeader>
                <CardContent className='space-y-4'>
                  <RulesEditor
                    rules={setting.rules}
                    modelOptions={modelsQuery.data ?? []}
                    disabled={busy}
                    onChange={(rules) => patchDraft({ rules })}
                  />
                  <div className='space-y-1.5'>
                    <Label>{t('Excluded models')}</Label>
                    <MultiSelect
                      options={(modelsQuery.data ?? []).map((model) => ({
                        label: model,
                        value: model,
                      }))}
                      selected={setting.exclude_models}
                      allowCreate
                      disabled={busy}
                      maxVisibleChips={8}
                      placeholder={t('Select models to exclude')}
                      onChange={(exclude_models) =>
                        patchDraft({ exclude_models })
                      }
                    />
                    <p className='text-muted-foreground text-xs'>
                      {t(
                        'Excluded models are never enhanced, even when a rule matches.'
                      )}
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('Pricing')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <PricingSection
                    setting={setting}
                    disabled={busy}
                    onChange={patchDraft}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('Output')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <OutputSection
                    setting={setting}
                    secrets={snapshotQuery.data?.secrets ?? {
                      hasTosAccessKey: false,
                      hasTosSecretKey: false,
                    }}
                    secretDraft={secretDraft}
                    disabled={busy}
                    onChange={patchDraft}
                    onSecretChange={(patch) =>
                      setSecretDraft((previous) => ({ ...previous, ...patch }))
                    }
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('Advanced')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <AdvancedSection
                    setting={setting}
                    disabled={busy}
                    onChange={patchDraft}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t('Disable the enhance switch?')}
        desc={t(
          'Turning it off stops all automatic enhance jobs for every model. Finished videos are delivered untouched and nothing extra is charged.'
        )}
        confirmText={t('Disable')}
        destructive
        isLoading={switchMutation.isPending}
        handleConfirm={() => {
          switchMutation.mutate(false, {
            onSettled: () => setConfirmDisable(false),
          })
        }}
      />
    </>
  )
}
