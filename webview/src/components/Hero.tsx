/*
 * Centered Talaria hero — the empty chat state, shown before the first turn.
 * The Talaria mark, one direct question, and a few starter chips that submit on
 * click. Flex-centered and responsive; it yields to the transcript the moment a
 * turn starts streaming (per the writing guidance: an empty screen invites an
 * action, it doesn't set a mood).
 */
import { Icon } from './Icon';

interface HeroProps {
  onStarter: (text: string) => void;
  /** M1: mirrors the Composer's `disabled={tab.binding !== 'bound'}` — a
   * starter chip posts a prompt exactly like the composer's submit button,
   * so it must be gated the same way (a pending/unbound tab has no session
   * for the host to attach the prompt to; the message is silently dropped,
   * which otherwise reads as a dead click next to the greyed-out composer). */
  disabled?: boolean;
}

const STARTERS = [
  { icon: 'search', text: 'Explain what this project does' },
  { icon: 'bug', text: 'Find and fix the failing test' },
  { icon: 'git-pull-request', text: 'Refactor the auth module to async' },
];

export function Hero({ onStarter, disabled }: HeroProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-8 text-center">
      <div className="flex flex-col items-center gap-2.5">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-accent-fg">
          <Icon name="hubot" size={24} />
        </span>
        <span className="h-eyebrow">Talaria Code</span>
        <h1 className="text-[15px] font-semibold tracking-tight text-fg">What should Talaria do?</h1>
      </div>

      <div className="flex w-full max-w-[380px] flex-wrap justify-center gap-2">
        {STARTERS.map((s) => (
          <button
            key={s.text}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              onStarter(s.text);
            }}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-2xs text-muted transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted"
          >
            <Icon name={s.icon} size={13} className="flex-none text-accent" />
            <span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
