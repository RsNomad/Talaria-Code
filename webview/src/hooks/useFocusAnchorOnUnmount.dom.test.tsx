import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { useFocusAnchorOnUnmount } from './useFocusAnchorOnUnmount';

function Harness() {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const arm = useFocusAnchorOnUnmount(anchorRef);
  const [done, setDone] = useState(false);
  return (
    <div ref={anchorRef} tabIndex={-1} data-testid="anchor">
      {!done && (
        <button type="button" onClick={(e) => { arm(e.currentTarget); setDone(true); }}>
          Act
        </button>
      )}
      {done && <span>done</span>}
    </div>
  );
}

describe('A11Y-01: useFocusAnchorOnUnmount', () => {
  it('moves focus to the anchor when the activated control unmounts (instead of <body>)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Act' }));
    expect(document.activeElement).toBe(screen.getByTestId('anchor'));
  });
});
