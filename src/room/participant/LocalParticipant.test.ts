import { Encryption_Type } from '../../proto/livekit_models';
import Room from '../Room';
import MockMediaStreamTrack from '../../test/MockMediaStreamTrack';

describe('audio publication RED policy', () => {
  const originalTrack = globalThis.MediaStreamTrack;
  const originalStream = globalThis.MediaStream;

  beforeAll(() => {
    Object.assign(globalThis, { MediaStreamTrack: MockMediaStreamTrack, MediaStream: jest.fn() });
  });

  afterAll(() => {
    Object.assign(globalThis, { MediaStreamTrack: originalTrack, MediaStream: originalStream });
  });

  it.each([
    { encrypted: true, red: undefined, disableRed: true },
    { encrypted: true, red: true, disableRed: true },
    { encrypted: true, red: false, disableRed: true },
    { encrypted: false, red: undefined, disableRed: false },
    { encrypted: false, red: true, disableRed: false },
    { encrypted: false, red: false, disableRed: true },
  ])('signals disableRed=$disableRed for E2EE=$encrypted, red=$red', async (policy) => {
    const room = new Room();
    await room.localParticipant.setE2EEEnabled(policy.encrypted);
    jest.spyOn(room.engine, 'isClosed', 'get').mockReturnValue(false);
    const endAtSignaling = new Error('captured addTrack');
    const addTrack = jest.spyOn(room.engine, 'addTrack').mockRejectedValue(endAtSignaling);

    const mic = new MockMediaStreamTrack();
    mic.kind = 'audio';
    mic.getConstraints = () => ({});
    mic.getSettings = () => ({ channelCount: 1 });
    mic.addEventListener = jest.fn();
    mic.removeEventListener = jest.fn();

    const options = policy.red === undefined ? {} : { red: policy.red };
    await expect(room.localParticipant.publishTrack(mic, options)).rejects.toBe(endAtSignaling);
    expect(addTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        encryption: policy.encrypted ? Encryption_Type.GCM : Encryption_Type.NONE,
        disableRed: policy.disableRed,
      }),
    );
  });
});
