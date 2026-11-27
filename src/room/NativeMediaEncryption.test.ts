import type { NativeMediaEncryption } from '../e2ee';
import { Encryption_Type, TrackInfo } from '../proto/livekit_models';
import type PCTransport from './PCTransport';
import Room from './Room';
import { ParticipantEvent } from './events';
import RemoteParticipant from './participant/RemoteParticipant';
import type LocalTrack from './track/LocalTrack';
import RemoteTrackPublication from './track/RemoteTrackPublication';
import { Track } from './track/Track';

function makeEncryption(): NativeMediaEncryption {
  return {
    hasKey: true,
    bindRoom: jest.fn(),
    configureSubscriber: jest.fn(),
    attachSender: jest.fn(async () => {}),
    activateSender: jest.fn(async () => {}),
    attachReceiver: jest.fn(async () => {}),
    releaseTransport: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
  };
}

function publisher(room: Room) {
  const track = { kind: 'audio', id: 'mic' } as MediaStreamTrack;
  const sender = { track };
  const transceiver = { sender, direction: 'inactive', stop: jest.fn() };
  const pc = { addTransceiver: jest.fn(() => transceiver), signalingState: 'stable' };
  room.engine.publisher = { pc } as unknown as PCTransport;
  return { pc, sender, track, transceiver };
}

it('keeps the real capture track inactive until its encryptor is ready', async () => {
  const encryption = makeEncryption();
  const room = new Room({ nativeEncryption: encryption });
  const { pc, sender, track, transceiver } = publisher(room);
  let release!: () => void;
  const attaching = new Promise<void>((resolve) => {
    (encryption.attachSender as jest.Mock).mockImplementation(() => {
      resolve();
      return new Promise<void>((ready) => {
        release = ready;
      });
    });
  });
  const publication = room.engine.createSender(
    { mediaStreamTrack: track } as LocalTrack,
    {},
    undefined,
    'alice',
  );
  await attaching;
  expect(pc.addTransceiver).toHaveBeenCalledWith(
    track,
    expect.objectContaining({ direction: 'inactive' }),
  );
  expect(encryption.attachSender).toHaveBeenCalledWith(pc, sender, 'alice');
  expect(encryption.activateSender).not.toHaveBeenCalled();
  release();
  await expect(publication).resolves.toBe(sender);
  expect(encryption.activateSender).toHaveBeenCalledWith(transceiver);
});

it.each(['attachSender', 'activateSender'] as const)(
  'abandons the sender if %s fails',
  async (operation) => {
    const encryption = makeEncryption();
    (encryption[operation] as jest.Mock).mockRejectedValue(new Error('unavailable'));
    const room = new Room({ nativeEncryption: encryption });
    const { track, transceiver } = publisher(room);
    await expect(
      room.engine.createSender({ mediaStreamTrack: track } as LocalTrack, {}, undefined, 'alice'),
    ).rejects.toThrow('unavailable');
    if (operation === 'attachSender') expect(encryption.activateSender).not.toHaveBeenCalled();
    expect(transceiver.stop).toHaveBeenCalled();
  },
);

it('starts playout and emits subscription only after receiver protection resolves', async () => {
  const encryption = makeEncryption();
  const room = new Room({ nativeEncryption: encryption });
  const participant = new RemoteParticipant(room.engine.client, 'PA', 'bob');
  const pub = new RemoteTrackPublication(
    Track.Kind.Audio,
    TrackInfo.fromPartial({
      sid: 'TR_1',
      encryption: Encryption_Type.GCM,
    }),
    true,
  );
  participant.tracks.set(pub.trackSid, pub);
  const media = {
    id: 'TR_1',
    kind: 'audio',
    enabled: false,
    readyState: 'live',
  } as MediaStreamTrack;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = {} as MediaStream;
  participant.addSubscribedMediaTrack(
    media,
    pub.trackSid,
    stream,
    undefined,
    undefined,
    undefined,
    () => ready,
  );
  expect(media.enabled).toBe(false);
  expect(pub.track).toBeUndefined();
  finish();
  await ready;
  expect(pub.track?.mediaStreamTrack).toBe(media);
  expect(media.enabled).toBe(true);
  pub.track?.stop();
});

it('keeps an unprotected receiver muted on failure', async () => {
  const room = new Room({ nativeEncryption: makeEncryption() });
  const participant = new RemoteParticipant(room.engine.client, 'PA', 'bob');
  const pub = new RemoteTrackPublication(
    Track.Kind.Audio,
    TrackInfo.fromPartial({ sid: 'TR_1' }),
    true,
  );
  participant.tracks.set(pub.trackSid, pub);
  const media = {
    id: 'TR_1',
    kind: 'audio',
    enabled: false,
    readyState: 'live',
  } as MediaStreamTrack;
  const rejected = new Promise<void>((resolve) =>
    participant.once(ParticipantEvent.TrackSubscriptionFailed, () => resolve()),
  );
  participant.addSubscribedMediaTrack(
    media,
    pub.trackSid,
    {} as MediaStream,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('missing protection');
    },
  );
  await rejected;
  expect(media.enabled).toBe(false);
  expect(pub.track).toBeUndefined();
});

it('releases keys on cancellation before the first connection and forbids downgrade', async () => {
  const encryption = makeEncryption();
  const room = new Room({ nativeEncryption: encryption });
  await expect(room.setE2EEEnabled(false)).rejects.toThrow('required');
  await room.disconnect();
  expect(encryption.dispose).toHaveBeenCalled();
});
