/*
 * P7-N6 (UI-I2a), superseded by ARCH-1 (final review, UI I-1 / T2): ModelsPanel
 * used to read the active model ONLY from the panel's own payload
 * (`data.currentModelId`) — but a model pick already updates the composer
 * chip OPTIMISTICALLY via `local.setModel` onto `tab.currentModelId`
 * (P7-N2N5's `useHostActions.setModel`; `App.tsx`'s `modelLabel` reads the
 * same field for the chip). `resolveEffectiveModelId` is the ONE selector
 * both the header and the row highlight read from, so they can never
 * disagree with each other or with the chip: prefer the tab's pick, falling
 * back to the (possibly stale) panel payload only when the tab has never
 * picked/bound a model yet (`null`).
 *
 * `tabModelId ?? payloadModelId` was the aggravator ONLY because, before
 * ARCH-1, nothing could ever overwrite `tab.currentModelId` after a failed
 * pick — the optimistic value was permanently authoritative, so a refused
 * switch left the UI lying forever (UI I-1). Under ARCH-1 the tab's pick is
 * optimistic-UNTIL-confirmed: `SessionController.setModel`
 * (`src/host/backend/session/SessionController.ts`) emits an authoritative
 * `model.state` push on EVERY terminal transition of a switch attempt —
 * confirm (`modelId` = the new id) or corrective snap-back (`modelId` = the
 * previous id, possibly `null`, on RPC reject or no live client) — and the
 * webview's `model.state` fold (`state/transcript.ts`) OVERWRITES
 * `tab.currentModelId` with it. A snap-back to `null` makes this selector
 * correctly fall through to `payloadModelId` (the pre-switch truth). Chip,
 * panel header, and row highlight all read this same field, so one
 * corrective push snaps all three back at once — the legality condition
 * this selector now relies on, not merely the absence of a re-push.
 */
export function resolveEffectiveModelId(
  tabModelId: string | null,
  payloadModelId: string,
): string {
  return tabModelId ?? payloadModelId;
}
