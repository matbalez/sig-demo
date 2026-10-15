// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { useId } from 'react';
import type { JSX } from 'react';
import { Select } from 'radix-ui';
import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { AxoSymbol } from '../axo/AxoSymbol.dom.tsx';
import { AxoTheme } from '../axo/AxoTheme.dom.tsx';
import { AxoItem } from '../axo/items/AxoItem.dom.tsx';
import { tw } from '../axo/tw.dom.tsx';
import type { LocalizerType } from '../types/Util.std.ts';
import type {
  SigDemoMeshCatalogType,
  SigDemoMeshOptionType,
} from '../types/SigDemoMesh.std.ts';

export type PropsType = Readonly<{
  i18n: LocalizerType;
  catalog?: SigDemoMeshCatalogType;
  selectionId?: string;
  isLoading: boolean;
  isSaving: boolean;
  error?: 'catalog' | 'selection';
  onRefresh: () => void;
  onSelectionChange: (selectionId: string) => void;
}>;

const AUTOMATIC_VALUE = '__sig_demo_mesh_automatic__';

export function PreferencesSigDemoMeshInference({
  i18n,
  catalog,
  selectionId,
  isLoading,
  isSaving,
  error,
  onRefresh,
  onSelectionChange,
}: PropsType): JSX.Element {
  const selectId = useId();
  const formatter = new Intl.NumberFormat(i18n.getLocale(), {
    maximumFractionDigits: 0,
  });
  const options = catalog?.options ?? [];
  const selected = options.find(
    option => option.id === (selectionId || catalog?.activeId)
  );
  const missingSelection = Boolean(
    selectionId && !options.some(option => option.id === selectionId)
  );
  const formatAmount = (amountMsat: number): string => {
    const units = amountMsat / 1000;
    const amount = `₿${formatter.format(Math.ceil(units))}`;
    return Number.isInteger(units)
      ? amount
      : i18n('icu:SigDemoMesh--approximate-amount', { amount });
  };
  const optionLabel = (option: SigDemoMeshOptionType): string => {
    const node = option.label
      ? `${option.label} (${option.nodeId.slice(0, 8)})`
      : option.nodeId.slice(0, 12);
    return `${option.model} — ${node}${option.hosting === 'phala' ? ' · Phala' : ''}`;
  };
  const optionPrice = (option: SigDemoMeshOptionType): string => {
    let price = i18n('icu:SigDemoMesh--free');
    if (option.paid) {
      price = i18n('icu:SigDemoMesh--price-unavailable');
      if (
        option.inputMsatPerMillionTokens !== undefined ||
        option.outputMsatPerMillionTokens !== undefined
      ) {
        price = i18n('icu:SigDemoMesh--option-pricing', {
          inputPrice:
            option.inputMsatPerMillionTokens === undefined
              ? i18n('icu:SigDemoMesh--price-unavailable')
              : formatAmount(option.inputMsatPerMillionTokens),
          outputPrice:
            option.outputMsatPerMillionTokens === undefined
              ? i18n('icu:SigDemoMesh--price-unavailable')
              : formatAmount(option.outputMsatPerMillionTokens),
        });
      }
    }
    return price;
  };
  const entries: Array<Readonly<{ label: string; value: string }>> = [];
  if (selected) {
    entries.push({
      label: i18n('icu:SigDemoMesh--model'),
      value: selected.model,
    });
    entries.push({
      label: i18n('icu:SigDemoMesh--node'),
      value: selected.label
        ? `${selected.label} · ${selected.nodeId}`
        : selected.nodeId,
    });
    if (selected.hostname) {
      entries.push({
        label: i18n('icu:SigDemoMesh--hostname'),
        value: selected.hostname,
      });
    }
    if (selected.version) {
      entries.push({
        label: i18n('icu:SigDemoMesh--version'),
        value: selected.version,
      });
    }
    if (selected.latencyMs !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--latency'),
        value: i18n('icu:SigDemoMesh--latency-ms', {
          milliseconds: formatter.format(selected.latencyMs),
        }),
      });
    }
    if (
      selected.releaseAttestation &&
      selected.releaseAttestation !== 'unavailable'
    ) {
      entries.push({
        label: i18n('icu:SigDemoMesh--release-signature'),
        value:
          selected.releaseAttestation === 'verified'
            ? i18n('icu:SigDemoMesh--verified')
            : i18n('icu:SigDemoMesh--unverified'),
      });
    }
    entries.push({
      label: i18n('icu:SigDemoMesh--cost'),
      value: selected.paid
        ? i18n('icu:SigDemoMesh--paid')
        : i18n('icu:SigDemoMesh--free'),
    });
    if (selected.inputMsatPerMillionTokens !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--input-price'),
        value: formatAmount(selected.inputMsatPerMillionTokens),
      });
    }
    if (selected.outputMsatPerMillionTokens !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--output-price'),
        value: formatAmount(selected.outputMsatPerMillionTokens),
      });
    }
    if (selected.minimumInvoiceMsat !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--minimum-payment'),
        value: formatAmount(selected.minimumInvoiceMsat),
      });
    }
    if (selected.contextWindowTokens !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--context'),
        value: i18n('icu:SigDemoMesh--context-tokens', {
          tokens: formatter.format(selected.contextWindowTokens),
        }),
      });
    }
    if (selected.hardware) {
      entries.push({
        label: i18n('icu:SigDemoMesh--hardware'),
        value: selected.hardware,
      });
    }
    if (selected.hosting === 'phala') {
      entries.push({
        label: i18n('icu:SigDemoMesh--hosting'),
        value: i18n('icu:SigDemoMesh--phala-hosting'),
      });
    }
    if (selected.capabilities?.length) {
      entries.push({
        label: i18n('icu:SigDemoMesh--capabilities'),
        value: selected.capabilities.join(', '),
      });
    }
    if (selected.lastSeenSecondsAgo !== undefined) {
      entries.push({
        label: i18n('icu:SigDemoMesh--last-seen'),
        value:
          selected.lastSeenSecondsAgo < 1
            ? i18n('icu:SigDemoMesh--just-now')
            : i18n('icu:SigDemoMesh--seconds-ago', {
                seconds: Math.max(1, Math.round(selected.lastSeenSecondsAgo)),
              }),
      });
    }
  }
  let statusText = i18n('icu:SigDemoMesh--available-count', {
    count: options.filter(option => option.available).length,
  });
  if (isSaving) statusText = i18n('icu:SigDemoMesh--saving');
  else if (isLoading) statusText = i18n('icu:SigDemoMesh--loading');
  let errorText = i18n('icu:SigDemoMesh--unavailable-description');
  if (error === 'selection')
    errorText = i18n('icu:SigDemoMesh--selection-error');
  else if (error === 'catalog') errorText = i18n('icu:SigDemoMesh--load-error');
  let triggerText = i18n('icu:SigDemoMesh--automatic');
  if (selectionId) {
    triggerText = selected
      ? optionLabel(selected)
      : i18n('icu:SigDemoMesh--saved-unavailable');
  }
  return (
    <>
      <AxoItem.Root>
        <AxoItem.Content>
          <AxoItem.Label>
            <label htmlFor={selectId}>
              {i18n('icu:SigDemoMesh--selection')}
            </label>
          </AxoItem.Label>
          <AxoItem.Description>
            {!selectionId && (
              <p className={tw('mt-0 mb-2')}>
                {i18n('icu:SigDemoMesh--automatic-description')}
              </p>
            )}
            <Select.Root
              value={selectionId || AUTOMATIC_VALUE}
              disabled={isSaving}
              onValueChange={value =>
                onSelectionChange(value === AUTOMATIC_VALUE ? '' : value)
              }
            >
              <Select.Trigger
                id={selectId}
                className={tw(
                  'flex w-full max-w-full min-w-0 items-center justify-between gap-2 rounded-lg bg-primary px-3 py-2 text-start type-body-medium text-primary focus-visible:axo-focus-ring disabled:text-disabled'
                )}
              >
                <span className={tw('min-w-0 truncate')}>
                  <Select.Value>{triggerText}</Select.Value>
                </span>
                <Select.Icon>
                  <AxoSymbol.Icon
                    symbol="chevron-down"
                    size={14}
                    label={null}
                  />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <AxoTheme.Inherit>
                  <Select.Content
                    position="popper"
                    align="start"
                    collisionPadding={8}
                    sideOffset={6}
                    className={tw(
                      'legacy-z-index-context-menu max-h-(--radix-select-content-available-height) w-[min(36rem,calc(100vw-1.5rem))] rounded-xl bg-material-tertiary p-1.5 text-primary shadow-elevation-3 backdrop-blur-regular'
                    )}
                  >
                    <Select.Viewport>
                      {[
                        {
                          id: AUTOMATIC_VALUE,
                          label: i18n('icu:SigDemoMesh--automatic'),
                          price: i18n('icu:SigDemoMesh--automatic-description'),
                          disabled: false,
                        },
                        ...(missingSelection
                          ? [
                              {
                                id: selectionId ?? '',
                                label: i18n(
                                  'icu:SigDemoMesh--saved-unavailable'
                                ),
                                price: '',
                                disabled: true,
                              },
                            ]
                          : []),
                        ...options.map(option => ({
                          id: option.id,
                          label: optionLabel(option),
                          price: optionPrice(option),
                          disabled: false,
                        })),
                      ].map(option => (
                        <Select.Item
                          key={option.id}
                          value={option.id}
                          disabled={option.disabled}
                          textValue={option.label}
                          className={tw(
                            'relative rounded-lg px-3 py-2 pe-9 text-start type-body-medium whitespace-normal outline-none data-disabled:text-disabled data-highlighted:bg-primary-pressed'
                          )}
                        >
                          <Select.ItemText>
                            <span
                              className={tw('block font-medium wrap-anywhere')}
                            >
                              {option.label}
                            </span>
                            {option.price && (
                              <span
                                className={tw(
                                  'mt-1 block type-body-small wrap-anywhere text-secondary'
                                )}
                              >
                                {option.price}
                              </span>
                            )}
                          </Select.ItemText>
                          <Select.ItemIndicator
                            className={tw('absolute inset-e-3 top-2.5')}
                          >
                            <AxoSymbol.Icon
                              symbol="check"
                              size={14}
                              label={null}
                            />
                          </Select.ItemIndicator>
                        </Select.Item>
                      ))}
                    </Select.Viewport>
                  </Select.Content>
                </AxoTheme.Inherit>
              </Select.Portal>
            </Select.Root>
          </AxoItem.Description>
        </AxoItem.Content>
      </AxoItem.Root>
      <AxoItem.Root>
        <AxoItem.Content>
          <AxoItem.Label>
            {i18n('icu:SigDemoMesh--network-nodes')}
          </AxoItem.Label>
          <AxoItem.Description>
            <span role="status">{statusText}</span>
          </AxoItem.Description>
          <AxoItem.Accessory>
            <AxoButton.Root
              size="sm"
              variant="subtle-secondary"
              disabled={isLoading || isSaving}
              onClick={onRefresh}
            >
              {i18n('icu:SigDemoMesh--refresh')}
            </AxoButton.Root>
          </AxoItem.Accessory>
        </AxoItem.Content>
      </AxoItem.Root>
      {(error ||
        (!isLoading && missingSelection) ||
        (selected && !selected.available)) && (
        <AxoItem.Root>
          <AxoItem.Content>
            <AxoItem.Description>
              <span role="alert" className={tw('text-destructive')}>
                {errorText}
              </span>
            </AxoItem.Description>
          </AxoItem.Content>
        </AxoItem.Root>
      )}
      {selected && (
        <AxoItem.Root>
          <AxoItem.Content>
            <AxoItem.Label>
              {selectionId
                ? i18n('icu:SigDemoMesh--selected-details')
                : i18n('icu:SigDemoMesh--active-details')}
            </AxoItem.Label>
            <AxoItem.Description>
              <dl className={tw('m-0 grid gap-2')}>
                {entries.map(entry => (
                  <div key={entry.label} className={tw('grid gap-0.5')}>
                    <dt className={tw('font-semibold')}>{entry.label}</dt>
                    <dd className={tw('m-0 wrap-anywhere')}>{entry.value}</dd>
                  </div>
                ))}
              </dl>
              <p className={tw('mb-0')}>
                {i18n('icu:SigDemoMesh--metadata-description')}
              </p>
            </AxoItem.Description>
          </AxoItem.Content>
        </AxoItem.Root>
      )}
    </>
  );
}
