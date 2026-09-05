/**
 * WS-AC S1-05: the extension's own identity for ACP `initialize.clientInfo`
 * (`Implementation {name, version, title?}` — the installed SDK's
 * types.gen.d.ts:1413-1441). KEPT IN SYNC WITH package.json BY TEST
 * (`version.test.ts` fails the gate on drift) — bump both together at
 * release time. Lives in shared/ so host code that must stay `vscode`-free
 * (acpClient.ts) can read it.
 */
export const EXTENSION_NAME = 'talaria-code';
export const EXTENSION_TITLE = 'Talaria Code';
export const EXTENSION_VERSION = '0.1.5';
