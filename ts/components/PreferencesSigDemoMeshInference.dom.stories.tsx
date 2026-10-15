// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from '@storybook/test';
import { AxoList } from '../axo/items/AxoList.dom.tsx';
import { AxoItem } from '../axo/items/AxoItem.dom.tsx';
import { PreferencesSigDemoMeshInference } from './PreferencesSigDemoMeshInference.dom.tsx';
import type { SigDemoMeshOptionType } from '../types/SigDemoMesh.std.ts';

const { i18n } = window.SignalContext;
const free: SigDemoMeshOptionType = {
  id: 'free-option',
  model: 'Gemma-4-E2B',
  nodeId: 'a'.repeat(64),
  label: 'Community node',
  paid: false,
  available: true,
  hardware: 'Apple M4 Max',
  contextWindowTokens: 32768,
  capabilities: ['text', 'tools'],
  lastSeenSecondsAgo: 2,
  latencyMs: 42,
  version: '0.78.1',
};
const paid: SigDemoMeshOptionType = {
  id: 'paid-phala-option',
  model: 'Qwen3.6-27B-Q6_K',
  nodeId: 'b'.repeat(64),
  label: 'Phala demo node',
  paid: true,
  available: true,
  hosting: 'phala',
  hardware: 'NVIDIA H200 · Intel TDX (operator reported)',
  contextWindowTokens: 131072,
  capabilities: ['text', 'tools'],
  lastSeenSecondsAgo: 0,
  inputMsatPerMillionTokens: 1250,
  outputMsatPerMillionTokens: 5000,
  minimumInvoiceMsat: 1000,
  hostname: 'phala-demo-node',
  version: '0.78.1',
  latencyMs: 87,
  releaseAttestation: 'verified',
};

export default {
  title: 'Components/PreferencesSigDemoMeshInference',
  component: PreferencesSigDemoMeshInference,
  decorators: [
    Story => (
      <div style={{ maxWidth: 640 }}>
        <AxoList.Root>
          <AxoList.Body>
            <AxoItem.Group>
              <Story />
            </AxoItem.Group>
          </AxoList.Body>
        </AxoList.Root>
      </div>
    ),
  ],
  args: {
    i18n,
    catalog: { options: [free], activeId: free.id },
    selectionId: undefined,
    isLoading: false,
    isSaving: false,
    error: undefined,
    onRefresh: fn(),
    onSelectionChange: fn(),
  },
} satisfies Meta<typeof PreferencesSigDemoMeshInference>;

type Story = StoryObj<typeof PreferencesSigDemoMeshInference>;

export const Automatic: Story = {};
export const PaidPhala: Story = {
  args: {
    catalog: { options: [paid], selectionId: paid.id },
    selectionId: paid.id,
  },
};
export const Loading: Story = { args: { catalog: undefined, isLoading: true } };
export const Empty: Story = { args: { catalog: { options: [] } } };
export const FailedRefresh: Story = { args: { error: 'catalog' } };
export const SavedUnavailable: Story = {
  args: { selectionId: 'missing-option' },
};
export const SelectedOffline: Story = {
  args: {
    catalog: { options: [{ ...free, available: false }] },
    selectionId: free.id,
  },
};
export const Saving: Story = { args: { isSaving: true } };
export const SelectionFailed: Story = { args: { error: 'selection' } };

export const ChooseNode: Story = {
  args: { catalog: { options: [free, paid] } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      page.getByRole('option', { name: /Qwen3\.6-27B-Q6_K — Phala demo node/ })
    );
    await expect(args.onSelectionChange).toHaveBeenCalledWith(paid.id);
  },
};

export const ConfiguredUnadvertisedNode: Story = {
  args: { catalog: { options: [{ ...paid, available: false }] } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    const page = within(canvasElement.ownerDocument.body);
    const option = page.getByRole('option', { name: /Qwen3\.6-27B-Q6_K/ });
    await expect(option).not.toHaveAttribute('aria-disabled', 'true');
    await expect(option).toHaveTextContent(
      /Input .*₿2.*Output .*₿5.*per 1M tokens/
    );
    await userEvent.click(option);
    await expect(args.onSelectionChange).toHaveBeenCalledWith(paid.id);
  },
};

export const ClearUnavailableSelection: Story = {
  args: { selectionId: 'missing-option' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole('option', {
        name: name => name.startsWith(i18n('icu:SigDemoMesh--automatic')),
      })
    );
    await expect(args.onSelectionChange).toHaveBeenCalledWith('');
  },
};
