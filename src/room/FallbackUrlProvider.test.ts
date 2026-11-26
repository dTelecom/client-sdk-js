import { SignalClient } from '../api/SignalClient';
import { FallbackUrlProvider } from './FallbackUrlProvider';
import RTCEngine from './RTCEngine';
import Room from './Room';
import { ConnectionError, ConnectionErrorReason, UnexpectedConnectionState } from './errors';

const primary = 'wss://a.example';
const second = 'wss://b.example';
const third = 'wss://c.example';
const options = { fallbackUrls: [primary + '/', second, second + '/', third] };
const unreachable = new ConnectionError('unreachable', ConnectionErrorReason.ServerUnreachable);

describe('issuer-ranked signaling endpoints', () => {
  it('deduplicates equivalent endpoints, preserves order and prevents a TLS downgrade', () => {
    const list = new FallbackUrlProvider(primary, [
      primary + '/',
      'https://a.example',
      'ws://insecure.example',
      second,
      third,
      second + '/',
    ]);
    expect([list.getNextUrl(), list.getNextUrl(), list.getNextUrl()]).toEqual([
      second,
      third,
      undefined,
    ]);
    list.resetAttempts();
    expect(list.getNextUrl()).toBe(second);
  });

  it('tries alternatives in order using the same grant and retains the primary for future reconnects', async () => {
    const room = new Room();
    const attempt = jest
      .spyOn(room as any, 'attemptConnection')
      .mockRejectedValueOnce(unreachable)
      .mockRejectedValueOnce(unreachable)
      .mockResolvedValue(undefined);
    await room.connect(primary, 'grant', options);
    expect(attempt.mock.calls.map(([url, grant]) => [url, grant])).toEqual([
      [primary, 'grant'],
      [second, 'grant'],
      [third, 'grant'],
    ]);
    expect(attempt.mock.calls[2][2]).toMatchObject({ fallbackUrls: [primary, second, third] });
  });

  it.each([
    new ConnectionError('denied', ConnectionErrorReason.NotAllowed, 401),
    new ConnectionError('forbidden', undefined, 403),
    new ConnectionError('invalid response'),
    new ConnectionError('cancelled', ConnectionErrorReason.Cancelled),
  ])('stops after a definitive join error (%s)', async (error) => {
    const room = new Room();
    const attempt = jest.spyOn(room as any, 'attemptConnection').mockRejectedValue(error);
    await expect(room.connect(primary, 'grant', options)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not open a websocket for an already cancelled grant', async () => {
    const controller = new AbortController();
    controller.abort();
    const socket = jest.spyOn(window, 'WebSocket');
    try {
      await expect(
        new SignalClient().join(
          primary,
          'grant',
          {
            autoSubscribe: true,
            maxRetries: 1,
            e2eeEnabled: false,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ reason: ConnectionErrorReason.Cancelled });
      expect(socket).not.toHaveBeenCalled();
    } finally {
      socket.mockRestore();
    }
  });

  it('does not use stale issuer entries when reusing a room', async () => {
    const room = new Room();
    const attempt = jest.spyOn(room as any, 'attemptConnection').mockRejectedValue(unreachable);
    await expect(room.connect(primary, 'first', options)).rejects.toBe(unreachable);
    attempt.mockClear();
    await expect(room.connect(second, 'next')).rejects.toBe(unreachable);
    expect(attempt.mock.calls.map(([url]) => url)).toEqual([second]);
  });

  function restartingEngine() {
    const engine = new RTCEngine(new Room().options) as any;
    Object.assign(engine, {
      _isClosed: false,
      url: second,
      token: 'grant',
      signalOpts: {},
      fallbackUrlProvider: new FallbackUrlProvider(second, [primary, second, third]),
    });
    jest.spyOn(engine, 'cleanupPeerConnections').mockResolvedValue(undefined);
    jest.spyOn(engine, 'cleanupClient').mockResolvedValue(undefined);
    jest.spyOn(engine, 'waitForPCReconnected').mockResolvedValue(undefined);
    return engine;
  }

  it('restarts on the serving endpoint, then tries the ranked alternatives', async () => {
    const engine = restartingEngine();
    const join = jest
      .spyOn(engine, 'join')
      .mockRejectedValueOnce(unreachable)
      .mockResolvedValue({});
    await engine.restartConnection();
    expect(join.mock.calls.map(([url, grant]) => [url, grant])).toEqual([
      [second, 'grant'],
      [primary, 'grant'],
    ]);
  });

  it.each([
    new ConnectionError('cancelled', ConnectionErrorReason.Cancelled),
    new ConnectionError('denied', undefined, 403),
  ])('does not rotate on a terminal restart (%s)', async (error) => {
    const engine = restartingEngine();
    const join = jest.spyOn(engine, 'join').mockRejectedValue(error);
    await expect(engine.restartConnection()).rejects.toBeInstanceOf(UnexpectedConnectionState);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it('stops both join and restart when the client is offline', async () => {
    const online = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const room = new Room();
      const attempt = jest.spyOn(room as any, 'attemptConnection').mockRejectedValue(unreachable);
      await expect(room.connect(primary, 'grant', options)).rejects.toBe(unreachable);
      expect(attempt).toHaveBeenCalledTimes(1);
      const engine = restartingEngine();
      const join = jest.spyOn(engine, 'join').mockRejectedValue(unreachable);
      await expect(engine.restartConnection()).rejects.toThrow();
      expect(join).toHaveBeenCalledTimes(1);
    } finally {
      online.mockRestore();
    }
  });
});
