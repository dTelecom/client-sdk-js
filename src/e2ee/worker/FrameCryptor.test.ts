/**
 * @jest-environment node
 */
import { KEY_PROVIDER_DEFAULTS } from '../constants';
import { FrameCryptor, isFrameServerInjected } from './FrameCryptor';
import { ParticipantKeyHandler } from './ParticipantKeyHandler';

describe('FrameCryptor', () => {
  it('identifies server injected frame correctly', () => {
    const frameTrailer = new TextEncoder().encode('LKROCKS');
    const frameData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...frameTrailer]).buffer;

    expect(isFrameServerInjected(frameData, frameTrailer)).toBe(true);
  });
  it('identifies server non server injected frame correctly', () => {
    const frameTrailer = new TextEncoder().encode('LKROCKS');
    const frameData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...frameTrailer, 10]);

    expect(isFrameServerInjected(frameData.buffer, frameTrailer)).toBe(false);
    frameData.fill(0);
    expect(isFrameServerInjected(frameData.buffer, frameTrailer)).toBe(false);
  });
});

describe('receiver lifecycle', () => {
  function receiver() {
    const keys = new ParticipantKeyHandler('speaker', true, KEY_PROVIDER_DEFAULTS);
    return {
      keys,
      cryptor: new FrameCryptor({
        keys,
        participantId: 'speaker',
        keyProviderOptions: KEY_PROVIDER_DEFAULTS,
      }),
    };
  }

  it('forwards only the exact SFU Opus silence packet without consulting the key ring', async () => {
    const { keys, cryptor } = receiver();
    const lookup = jest.spyOn(keys, 'getKeySet');
    const enqueue = jest.fn();
    const destination = { enqueue } as unknown as TransformStreamDefaultController;
    const silence = new Uint8Array(80);
    silence.set([0xf8, 0xff, 0xfe]);
    const frame = { data: silence.buffer } as RTCEncodedAudioFrame;

    await cryptor.decodeFunction(frame, destination);
    expect(lookup).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(frame);

    await cryptor.decodeFunction({ ...frame, type: 'key' } as RTCEncodedVideoFrame, destination);
    await cryptor.decodeFunction({ ...frame, data: silence.slice(0, 79).buffer }, destination);
    silence[79] = 1;
    await cryptor.decodeFunction(frame, destination);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('ignores InvalidStateError only for a removed or superseded receiver stream', async () => {
    const { cryptor, keys } = receiver();
    const onError = jest.fn();
    cryptor.on('cryptorError', onError);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    function attach() {
      let source!: ReadableStreamDefaultController;
      const readable = new ReadableStream({
        start(controller) {
          source = controller;
        },
      });
      cryptor.setupTransform('decode', readable, new WritableStream(), 'track');
      return async (name: string) => {
        source.error(new DOMException('test stream ended', name));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };
    }
    try {
      const removed = attach();
      cryptor.unsetParticipant();
      await removed('InvalidStateError');
      expect(onError).not.toHaveBeenCalled();

      cryptor.setParticipant('speaker', keys);
      const replaced = attach();
      const active = attach();
      await replaced('InvalidStateError');
      expect(onError).not.toHaveBeenCalled();
      await active('InvalidStateError');
      expect(onError).toHaveBeenCalledTimes(1);

      const failed = attach();
      cryptor.unsetParticipant();
      await failed('OperationError');
      expect(onError).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });
});
