/* The developer's prompt bubble — right-aligned, accent-filled. */
import type { UserItem } from '../../types';

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-[12px] rounded-br-[3px] bg-accent px-3 py-2 text-[13px] leading-relaxed text-accent-fg whitespace-pre-wrap break-words">
        {item.text}
      </div>
    </div>
  );
}
