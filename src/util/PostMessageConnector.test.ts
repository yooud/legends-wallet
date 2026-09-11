import { createConnector } from './PostMessageConnector';

type Methods = {
  ping: () => Promise<string>;
};

describe('PostMessageConnector', () => {
  let messageListener: ((event: MessageEvent) => void) | undefined;
  let worker: Worker;
  let postMessage: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    postMessage = jest.fn();
    worker = {
      addEventListener: jest.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'message') messageListener = listener;
      }),
      removeEventListener: jest.fn(),
      postMessage,
    } as unknown as Worker;
  });

  afterEach(() => {
    jest.useRealTimers();
    messageListener = undefined;
  });

  it('rejects a request that exceeds its deadline', async () => {
    const connector = createConnector<Methods>(worker, undefined, undefined, undefined, 100);
    const request = connector.request({ name: 'ping', args: [] });
    const assertion = expect(request).rejects.toThrow('Connector request timed out');

    jest.advanceTimersByTime(100);

    await assertion;
    connector.destroy();
  });

  it('rejects pending requests when it is destroyed', async () => {
    const connector = createConnector<Methods>(worker);
    const request = connector.request({ name: 'ping', args: [] });
    const assertion = expect(request).rejects.toThrow('Connector destroyed');

    connector.destroy();

    await assertion;
  });

  it('resolves a response before its deadline', async () => {
    const connector = createConnector<Methods>(worker, undefined, undefined, undefined, 100);
    const request = connector.request({ name: 'ping', args: [] });
    const { messageId } = postMessage.mock.calls[0][0] as { messageId: string };

    messageListener?.({
      data: { type: 'methodResponse', messageId, response: 'ok' },
    } as MessageEvent);

    await expect(request).resolves.toBe('ok');
    connector.destroy();
  });
});
