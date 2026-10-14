// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { AxoTextField } from '../axo/fields/AxoTextField.dom.tsx';
import { AxoPasswordField } from '../axo/fields/AxoPasswordField.dom.tsx';
import { tw } from '../axo/tw.dom.tsx';
import { HTTPError } from '../types/HTTPError.std.ts';
import { TitlebarDragArea } from './TitlebarDragArea.dom.tsx';
import { Button, ButtonSize, ButtonVariant } from './Button.dom.tsx';
import type { LocalizerType } from '../types/I18N.std.ts';

export function SigDemoRegistration({
  i18n,
  registerAccount,
  readyForUpdates,
  pendingDisplayName,
}: {
  i18n: LocalizerType;
  registerAccount: (options: {
    inviteCode: string;
    displayName: string;
  }) => Promise<void>;
  readyForUpdates: () => void;
  pendingDisplayName?: string;
}): JSX.Element {
  const [inviteCode, setInviteCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const isResuming = pendingDisplayName != null;
  const effectiveDisplayName = pendingDisplayName ?? displayName;
  let buttonLabel = i18n('icu:SigDemoRegistration--create');
  if (isResuming) {
    buttonLabel = i18n('icu:SigDemoRegistration--resume');
  }
  if (pending) {
    buttonLabel = i18n('icu:SigDemoRegistration--creating');
  }

  useEffect(() => {
    readyForUpdates();
  }, [readyForUpdates]);

  const submit = async () => {
    if (
      pending ||
      (!isResuming && !inviteCode.trim()) ||
      !effectiveDisplayName.trim()
    ) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await registerAccount({ inviteCode, displayName: effectiveDisplayName });
      setInviteCode('');
    } catch (cause) {
      // Error objects can contain transport details; show only safe product text.
      setError(
        cause instanceof HTTPError && [401, 403, 409].includes(cause.code)
          ? i18n('icu:SigDemoRegistration--invalid-invite')
          : i18n('icu:SigDemoRegistration--connection-error')
      );
      setPending(false);
    }
  };

  return (
    <div
      className={tw(
        'flex size-full flex-col bg-surface-secondary text-primary'
      )}
    >
      <TitlebarDragArea />
      <div className={tw('flex grow items-center justify-center p-6')}>
        <form
          className={tw(
            'flex w-90.5 max-w-full flex-col gap-4 rounded-[26px] bg-surface-primary p-6'
          )}
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <h1 className={tw('type-title-large')}>
            {i18n('icu:SigDemoRegistration--title')}
          </h1>
          <p className={tw('type-body-large text-secondary')}>
            {isResuming
              ? i18n('icu:SigDemoRegistration--resume-description')
              : i18n('icu:SigDemoRegistration--description')}
          </p>
          <label className={tw('flex flex-col gap-2 type-body-large')}>
            {i18n('icu:SigDemoRegistration--name')}
            <AxoTextField.Root
              disabled={pending || isResuming}
              maxBytes={128}
              maxGraphemes={64}
              value={effectiveDisplayName}
              onValueChange={setDisplayName}
            >
              <AxoTextField.Input
                autoFocus
                autoComplete="off"
                placeholder={i18n('icu:SigDemoRegistration--name')}
              />
            </AxoTextField.Root>
          </label>
          {!isResuming ? (
            <label className={tw('flex flex-col gap-2 type-body-large')}>
              {i18n('icu:SigDemoRegistration--invite')}
              <AxoPasswordField.Root
                disabled={pending}
                maxBytes={256}
                maxGraphemes={256}
                value={inviteCode}
                onValueChange={setInviteCode}
              >
                <AxoPasswordField.Input
                  placeholder={i18n('icu:SigDemoRegistration--invite')}
                  autoComplete="new-password"
                />
              </AxoPasswordField.Root>
            </label>
          ) : undefined}
          {error ? (
            <p role="alert" className={tw('type-body-large')}>
              {error}
            </p>
          ) : undefined}
          <Button
            type="submit"
            variant={ButtonVariant.Primary}
            size={ButtonSize.Medium}
            disabled={
              pending ||
              (!isResuming && !inviteCode.trim()) ||
              !effectiveDisplayName.trim()
            }
          >
            {buttonLabel}
          </Button>
        </form>
      </div>
    </div>
  );
}
