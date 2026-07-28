import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffCard } from './DiffCard';
import type { ToolDiff } from '../../protocol';

/**
 * B5 (path doc §4 B5, item 2 of 3 remaining): the "open diff in editor"
 * trigger is icon-only — `Icon.tsx` renders its glyph `aria-hidden` when no
 * `title` prop is passed to `Icon` itself (it isn't, here), so the button
 * has NO accessible name from content. It carries only a `title` attribute,
 * which MDN documents as unreliable for keyboard/touch/AT users
 * (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/title,
 * fetched this task). Fix: `aria-label="Open diff in editor"`.
 */
describe('DiffCard — B5: the icon-only "open in editor" button has an accessible name', () => {
  const diff: ToolDiff = {
    path: 'src/example.ts',
    hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ sign: '+', text: 'added line' }] }],
  };

  it('has aria-label="Open diff in editor" while a diff is pending approval', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{}}
        hunkOffset={0}
        onResolve={() => undefined}
        pending
        onOpenDiff={() => undefined}
      />,
    );
    // RED today: the button's only name source is `title`
    // ("Open a read-only diff preview in the editor") — a DIFFERENT string
    // from the required aria-label, so this exact-name query fails either way.
    const button = screen.getByRole('button', { name: 'Open diff in editor' });
    expect(button).toHaveAttribute('aria-label', 'Open diff in editor');
  });

  it('does not render the open-diff button at all when there is nothing pending (no false affordance)', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{}}
        hunkOffset={0}
        onResolve={() => undefined}
        pending={false}
        onOpenDiff={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open diff in editor' })).not.toBeInTheDocument();
  });
});

/**
 * T-A2 (V-7): hunk-level Accept/Reject buttons stay OPERABLE only while the
 * gating approval is genuinely pending (`pending && !resolved`) — mirrors
 * the "Open diff in editor" gating above, which was already `pending`-gated.
 * Before this fix the buttons rendered for ANY unresolved hunk regardless of
 * `pending`, so a diff card that outlived its approval (settled/interrupted)
 * kept offering operable controls for a decision the backend had already
 * made — the same class of lie ARCH-1 closed for tool/message/summary cards.
 */
describe('DiffCard — T-A2: hunk buttons gated on pending && !resolved (V-7)', () => {
  const diff: ToolDiff = {
    path: 'src/example.ts',
    hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ sign: '+', text: 'added line' }] }],
  };

  it('RED today: does not render Accept/Reject for an unresolved hunk when pending=false', () => {
    render(
      <DiffCard diff={diff} resolvedHunks={{}} hunkOffset={0} onResolve={() => undefined} pending={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Accept hunk' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('still renders Accept/Reject for an unresolved hunk when pending=true (unchanged happy path)', () => {
    render(
      <DiffCard diff={diff} resolvedHunks={{}} hunkOffset={0} onResolve={() => undefined} pending />,
    );
    expect(screen.getByRole('button', { name: 'Accept hunk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('does not render Accept/Reject for an already-resolved hunk even when pending=true (unchanged: resolved hunks never re-offer buttons)', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{ 0: 'accept' }}
        hunkOffset={0}
        onResolve={() => undefined}
        pending
      />,
    );
    expect(screen.queryByRole('button', { name: 'Accept hunk' })).not.toBeInTheDocument();
  });
});

/**
 * T-A2-SC2/SC3 (audit-2 wave-3 refinement): the neutral "not applied" pill
 * must key on the approval's EFFECTIVE deny outcome (the `denied` prop,
 * derived in ChatView from `settledOutcome`/`resolvedOptionId` — never from
 * the raw state-level `hunksLocked`, which A1 sets on ANY settle including
 * an ALLOW). Under `denied`, a hunk the user had explicitly ACCEPTED must
 * drop its green "accepted" pill (SC3 — the literal V-7 lie: the edit was
 * denied, nothing was applied) UNLESS that specific hunk carries an explicit
 * `'reject'` entry, which keeps its red "rejected" pill.
 */
describe('DiffCard — T-A2-SC2/SC3: denied-derived "not applied" pill (never from raw hunksLocked)', () => {
  const diff: ToolDiff = {
    path: 'src/example.ts',
    hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ sign: '+', text: 'added line' }] }],
  };

  it('an unresolved hunk under denied=true shows "not applied", not a false affordance', () => {
    render(
      <DiffCard diff={diff} resolvedHunks={{}} hunkOffset={0} onResolve={() => undefined} pending={false} denied />,
    );
    expect(screen.getByText('not applied')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('SC3: a hunk explicitly ACCEPTED but the edit was denied shows "not applied", NOT "accepted" (the V-7 lie)', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{ 0: 'accept' }}
        hunkOffset={0}
        onResolve={() => undefined}
        pending={false}
        denied
      />,
    );
    expect(screen.getByText('not applied')).toBeInTheDocument();
    expect(screen.queryByText('accepted')).not.toBeInTheDocument();
  });

  it('a hunk explicitly REJECTED under denied=true keeps its red "rejected" pill (not "not applied")', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{ 0: 'reject' }}
        hunkOffset={0}
        onResolve={() => undefined}
        pending={false}
        denied
      />,
    );
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect(screen.queryByText('not applied')).not.toBeInTheDocument();
  });

  it('SC2: an ALLOWED (applied) edit never mislabels its accepted hunk "not applied" (denied=false, hunksLocked-equivalent state ignored)', () => {
    render(
      <DiffCard
        diff={diff}
        resolvedHunks={{ 0: 'accept' }}
        hunkOffset={0}
        onResolve={() => undefined}
        pending={false}
        denied={false}
      />,
    );
    expect(screen.getByText('accepted')).toBeInTheDocument();
    expect(screen.queryByText('not applied')).not.toBeInTheDocument();
  });

  it('an unresolved hunk that is neither pending nor denied renders no pill and no buttons (post-apply auto-allowed diff, unresolved sibling)', () => {
    render(
      <DiffCard diff={diff} resolvedHunks={{}} hunkOffset={0} onResolve={() => undefined} pending={false} denied={false} />,
    );
    expect(screen.queryByText('not applied')).not.toBeInTheDocument();
    expect(screen.queryByText('accepted')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
