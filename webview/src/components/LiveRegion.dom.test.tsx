import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LiveRegion } from './LiveRegion';

/**
 * Path doc §2.1 (`af-architecture-path.md`) / memory `hermes-wave2-plan`
 * Finding-7: a live region that mounts TOGETHER with its content is the
 * known-unreliable announcement pattern. MDN Live_regions (fetched live for
 * this task): "Start with an empty live region, then – in a separate step –
 * change the content inside the region."
 * (https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions)
 *
 * So `LiveRegion` must ALWAYS render its element, even when `text` is `''` —
 * that is the mounted-when-empty contract this component exists to make
 * structural (a bare conditionally-mounted `<div role="status">` is exactly
 * the footgun this component replaces).
 *
 * `assertive` renders `role="alert"` with NO extra `aria-live` — MDN, same
 * page: pairing `role="alert"` with `aria-live="assertive"` "causes double
 * speaking issues in VoiceOver on iOS". `role="alert"` is documented to
 * announce content already present at mount, unlike `role="status"`.
 */
describe('LiveRegion', () => {
  it('polite (default): renders role=status with aria-live=polite', () => {
    const { getByRole } = render(<LiveRegion text="Saved" />);

    const region = getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Saved');
  });

  it('assertive: renders role=alert with NO aria-live attribute (avoids VoiceOver double-speak)', () => {
    const { getByRole } = render(<LiveRegion text="Approval required" assertive />);

    const region = getByRole('alert');
    expect(region).not.toHaveAttribute('aria-live');
    expect(region).toHaveTextContent('Approval required');
  });

  it('mounted-when-empty: renders the role=status element even when text is empty', () => {
    const { getByRole } = render(<LiveRegion text="" />);

    const region = getByRole('status');
    expect(region).toHaveTextContent('');
  });

  it('mounted-when-empty: renders the role=alert element even when text is empty', () => {
    const { getByRole } = render(<LiveRegion text="" assertive />);

    const region = getByRole('alert');
    expect(region).toHaveTextContent('');
  });
});
