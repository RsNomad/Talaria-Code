import { describe, it, expect } from 'vitest';
import { AGENT_METHODS, PROTOCOL_VERSION, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

/**
 * Audit C-1 (Critical). The extension shipped three calls through the SDK's
 * `extMethod`, whose 0.4.5 implementation prepends an underscore:
 * `sendRequest(\`_${method}\`, params)`. Hermes has NO underscore/extension
 * dispatch in `acp_adapter/` at all — every one of them died with -32601, so
 * the Sessions panel could never load and every model switch failed.
 *
 * The claim "extMethod sends the method verbatim" was written into
 * `acpClient.ts` as documented fact and was false. That is why this file
 * asserts the BYTES ON THE WIRE rather than trusting any doc or any version
 * number: it drives a real `ClientSideConnection` into a fake ndJSON stream and
 * reads what came out.
 */
function fakeStream(): { stream: ReturnType<typeof ndJsonStream>; written: string[] } {
  const written: string[] = [];
  const decoder = new TextDecoder();
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(decoder.decode(chunk));
    },
  });
  const input = new ReadableStream<Uint8Array>({
    start() {
      /* never emits: every request stays pending, which is all we need */
    },
  });
  return { stream: ndJsonStream(output, input), written };
}

function connect(): { conn: ClientSideConnection; written: string[] } {
  const { stream, written } = fakeStream();
  const conn = new ClientSideConnection(
    () => ({
      async sessionUpdate() {
        /* unused */
      },
      async requestPermission() {
        return { outcome: { outcome: 'cancelled' as const } };
      },
    }),
    stream,
  );
  return { conn, written };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('ACP wire names — what actually goes out on stdout', () => {
  it('the SDK method map holds the BARE names Hermes registers', () => {
    // Hermes' own map: Main Agent(harness)/…/acp/meta.py — session_list:
    // "session/list", session_set_model: "session/set_model",
    // session_close: "session/close". No underscores anywhere.
    expect(AGENT_METHODS.session_list).toBe('session/list');
    expect(AGENT_METHODS.session_set_model).toBe('session/set_model');
    expect(AGENT_METHODS.session_close).toBe('session/close');
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('listSessions writes "session/list" — NOT "_session/list"', async () => {
    const { conn, written } = connect();
    void conn.listSessions({});
    await flush();
    const wire = written.join('');
    expect(wire).toContain('"method":"session/list"');
    expect(wire).not.toContain('_session/list');
  });

  it('unstable_setSessionModel writes "session/set_model" — NOT "_session/set_model" and NOT "session_set_mode"', async () => {
    const { conn, written } = connect();
    void conn.unstable_setSessionModel({ sessionId: 's1', modelId: 'm1' });
    await flush();
    const wire = written.join('');
    expect(wire).toContain('"method":"session/set_model"');
    expect(wire).not.toContain('_session/set_model');
    // 0.4.5's native setSessionModel sent `session_set_mode` — a second,
    // independent bug (fabrication G-5). Assert it is gone.
    expect(wire).not.toContain('session_set_mode');
  });

  it('unstable_closeSession writes "session/close" — NOT "_session/close"', async () => {
    const { conn, written } = connect();
    void conn.unstable_closeSession({ sessionId: 's1' });
    await flush();
    const wire = written.join('');
    expect(wire).toContain('"method":"session/close"');
    expect(wire).not.toContain('_session/close');
  });

  it('extMethod itself no longer prepends an underscore (the 0.4.5 defect, gone)', async () => {
    const { conn, written } = connect();
    void conn.extMethod('some/custom_method', {});
    await flush();
    const wire = written.join('');
    expect(wire).toContain('"method":"some/custom_method"');
    expect(wire).not.toContain('_some/custom_method');
  });
});
