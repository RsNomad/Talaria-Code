import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentMarkdown } from './AgentMarkdown';

/**
 * Audit G-5. Lists were unsupported (raw dashes in a paragraph), `#` headings
 * rendered as bold <p> (no heading structure for assistive technology), and an
 * unterminated fence during streaming showed raw ``` in the transcript.
 *
 * The no-dangerouslySetInnerHTML design is DELIBERATE (CSP) and stays.
 */
describe('G-5: AgentMarkdown renders the structures agents actually emit', () => {
  it('renders a bullet list as a real list', () => {
    render(<AgentMarkdown text={'Steps:\n\n- first\n- second\n- third'} />);
    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('renders a numbered list as a real ordered list', () => {
    render(<AgentMarkdown text={'1. alpha\n2. beta'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders a heading as a real heading, not a bold paragraph', () => {
    render(<AgentMarkdown text={'## What changed\n\nbody text'} />);
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeInTheDocument();
  });

  it('an UNTERMINATED fence mid-stream renders as code, not as raw backticks', () => {
    render(<AgentMarkdown text={'Here you go:\n\n```ts\nconst x = 1;'} streaming />);
    expect(screen.queryByText(/```/)).not.toBeInTheDocument();
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });

  it('a closed fence still renders as code (non-vacuous)', () => {
    render(<AgentMarkdown text={'```ts\nconst y = 2;\n```'} />);
    expect(screen.getByText(/const y = 2;/)).toBeInTheDocument();
  });

  it('still escapes markup rather than injecting it (the CSP-safe design is preserved)', () => {
    render(<AgentMarkdown text={'<img src=x onerror=alert(1)>'} />);
    expect(document.querySelector('img')).toBeNull();
  });
});

/**
 * C2: fence gate divergence, markdown links (scheme-restricted), deep headings.
 */
describe('C2: fence gate diverges from CommonMark when settled; links; #{4,6} headings', () => {
  it('a SETTLED message that merely mentions ``` does not permanently code-block its tail (deliberate CommonMark divergence)', () => {
    render(<AgentMarkdown text={'type ``` to open'} />);
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.getByText(/type ``` to open/)).toBeInTheDocument();
  });

  it('a STREAMING trailing unterminated fence still renders as code (G-5 behavior preserved)', () => {
    render(<AgentMarkdown text={'Here you go:\n\n```ts\nconst z = 3;'} streaming />);
    expect(screen.queryByText(/```/)).not.toBeInTheDocument();
    expect(screen.getByText(/const z = 3;/)).toBeInTheDocument();
  });

  it('renders a markdown http(s) link as a real anchor', () => {
    render(<AgentMarkdown text={'See [docs](https://example.com) for more.'} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('title', 'https://example.com');
    expect(link).not.toHaveAttribute('target');
  });

  it('does NOT render an anchor for a javascript: scheme link (scheme gate is the regex itself)', () => {
    render(<AgentMarkdown text={'[x](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('does NOT render an anchor for a data: scheme link either', () => {
    render(<AgentMarkdown text={'[x](data:text/html,<script>alert(1)</script>)'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders #### (4 hashes) as h6', () => {
    render(<AgentMarkdown text={'#### deep'} />);
    const heading = screen.getByRole('heading', { name: 'deep' });
    expect(heading.tagName).toBe('H6');
  });

  it('renders ###### (6 hashes) as h6 too (the 4+ branch generalizes)', () => {
    render(<AgentMarkdown text={'###### deepest'} />);
    const heading = screen.getByRole('heading', { name: 'deepest' });
    expect(heading.tagName).toBe('H6');
  });
});
