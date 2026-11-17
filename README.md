# dTelecom JavaScript/TypeScript client SDK

`@dtelecom/livekit-client` connects a browser to dTelecom rooms: join, publish camera, microphone and screen, and receive other participants' tracks and data. It is dTelecom's build of the LiveKit client and works with dTelecom Cloud.

Your backend creates the participant token with the server SDK ([`@dtelecom/server-sdk-js`](https://github.com/dTelecom/server-sdk-js) or [`server-sdk-go`](https://github.com/dTelecom/server-sdk-go)); the browser only gets the token and the node URL. Never put the API key or secret in browser code.

## Installation

```shell
npm install @dtelecom/livekit-client
```

or

```shell
yarn add @dtelecom/livekit-client
```

### Without a bundler

The browser build registers a global named `LivekitClient` (from 1.12.25):

```html
<script src="https://unpkg.com/@dtelecom/livekit-client@1.12.25/dist/livekit-client.umd.js"></script>
<script type="module">
  const { Room, RoomEvent } = LivekitClient;
  const { token, wsUrl } = await (await fetch('/api/token')).json();
  const room = new Room();
  await room.connect(wsUrl, token);
</script>
```

Versions up to 1.12.24 register `window['@dtelecom/livekitClient']`; that name still works.

## Getting a token

On your server, with dTelecom Cloud credentials (`DTELECOM_API_KEY`, `DTELECOM_API_SECRET`, `DTELECOM_CLOUD_URL`):

```typescript
import { CloudClient } from '@dtelecom/server-sdk-js';

const cloud = new CloudClient();

// e.g. GET /api/token
const { token, wsUrl, sessionId, expiresAt } = await cloud.createToken({
  room: 'my-room',
  identity: userId, // unique in the room; a second connection with it replaces the first
  name: userName,
  clientIp: request.ip, // picks the node nearest to the user
});
// send { token, wsUrl } to the browser
```

A token lasts 6 hours by default (at most 24). For longer sessions your backend extends it with `cloud.extendToken(sessionId, '1h')` before `expiresAt`; a participant whose token expired without an extension is removed from the room about a minute later.

## Usage

Examples below are in TypeScript. With CommonJS:

```javascript
const { Room } = require('@dtelecom/livekit-client');
```

### Connecting to a room, publish video & audio

```typescript
import {
  DisconnectReason,
  LocalParticipant,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from '@dtelecom/livekit-client';

// token and wsUrl come from your backend (see "Getting a token")
const { token, wsUrl } = await (await fetch('/api/token')).json();

const room = new Room({
  // automatically manage subscribed video quality
  adaptiveStream: true,

  // optimize publishing bandwidth and CPU for published tracks
  dynacast: true,

  // default capture settings
  videoCaptureDefaults: {
    resolution: VideoPresets.h720.resolution,
  },
});

// set up event listeners
room
  .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
  .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
  .on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakerChange)
  .on(RoomEvent.Disconnected, handleDisconnect)
  .on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);

// connect to the node your backend got with the token
await room.connect(wsUrl, token);
console.log('connected to room', room.name);

// publish local camera and mic tracks
await room.localParticipant.enableCameraAndMicrophone();

function handleTrackSubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
    // attach it to a new HTMLVideoElement or HTMLAudioElement
    const element = track.attach();
    parentElement.appendChild(element);
  }
}

function handleTrackUnsubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  // remove tracks from all attached elements
  track.detach();
}

function handleLocalTrackUnpublished(publication: LocalTrackPublication, participant: LocalParticipant) {
  // when local tracks are ended, update UI to remove them from rendering
  publication.track?.detach();
}

function handleActiveSpeakerChange(speakers: Participant[]) {
  // show UI indicators when participant is speaking
}

function handleDisconnect(reason?: DisconnectReason) {
  // CLIENT_INITIATED: room.disconnect(); PARTICIPANT_REMOVED: removed by your backend or after
  // the token expired; DUPLICATE_IDENTITY: the same identity joined elsewhere; ROOM_DELETED
  console.log('disconnected from room', reason);
}
```

### Handling common track types

There are shortcuts that make working with common track types simple. For a user's camera, microphone, and screen share, you can enable them with the following `LocalParticipant` methods:

```typescript
const p = room.localParticipant;
// turn on the local user's camera and mic, this may trigger a browser prompt
// to ensure permissions are granted
await p.setCameraEnabled(true);
await p.setMicrophoneEnabled(true);

// start sharing the user's screen, this will trigger a browser prompt to select
// the screen to share.
await p.setScreenShareEnabled(true);

// disable camera to mute them, when muted, the user's camera indicator will be turned off
await p.setCameraEnabled(false);
```

Similarly, you can access these common track types on the other participants' end.

```typescript
// get a RemoteParticipant by their sid
const p = room.participants.get('participant-sid');
if (p) {
  // if the other user has enabled their camera, attach it to a new HTMLVideoElement
  if (p.isCameraEnabled) {
    const track = p.getTrack(Track.Source.Camera);
    if (track?.isSubscribed) {
      const videoElement = track.videoTrack?.attach();
      // do something with the element
    }
  }
}
```

### Creating a track prior to creating a room

In some cases, it may be useful to create a track before creating a room. For
example, when building a staging area so the user may check their own camera.

You can use our global track creation functions for this:

```typescript
const tracks = await createLocalTracks({
  audio: true,
  video: true,
});
```

### Publish tracks from any source

LiveKit lets you publish any track as long as it can be represented by a MediaStreamTrack. You can specify a name on the track in order to identify it later.

```typescript
const pub = await room.localParticipant.publishTrack(mediaStreamTrack, {
  name: 'mytrack',
  simulcast: true,
  // if this should be treated like a camera feed, tag it as such
  // supported known sources are .Camera, .Microphone, .ScreenShare
  source: Track.Source.Camera,
});

// you may mute or unpublish the track later
pub.setMuted(true);

room.localParticipant.unpublishTrack(mediaStreamTrack);
```

### Device management APIs

Users may have multiple input and output devices available. LiveKit will automatically use the one that's deemed as the `default` device on the system. You may also list and specify an alternative device to use.

We use the same deviceId as one returned by [MediaDevices.enumerateDevices()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices).

#### Example listing and selecting a camera device

```typescript
// list all microphone devices
const devices = await Room.getLocalDevices('audioinput');

// select last device
const device = devices[devices.length - 1];

// in the current room, switch to the selected device and set
// it as default audioinput in the future.
await room.switchActiveDevice('audioinput', device.deviceId);
```

You can also switch devices given a constraint. This could be useful on mobile devices to switch to a back-facing camera:

```typescript
await videoTrack.restartTrack({
  facingMode: 'environment',
});
```

#### Handling device failures

When creating tracks using LiveKit APIs (`connect`, `createLocalTracks`, `setCameraEnabled`, etc), it's possible to encounter errors with the underlying media device. In those cases, LiveKit will emit `RoomEvent.MediaDevicesError`.

You can use the helper `MediaDeviceFailure.getFailure(error)` to determine specific reason for the error.

- `PermissionDenied` - the user disallowed capturing devices
- `NotFound` - the particular device isn't available
- `DeviceInUse` - device is in use by another process (happens on Windows)

These distinctions enables you to provide more specific messaging to the user.

You could also retrieve the last error with `LocalParticipant.lastCameraError` and `LocalParticipant.lastMicrophoneError`.

### Audio playback

Browsers can be restrictive with regards to audio playback that is not initiated by user interaction. What each browser considers as user interaction can vary by vendor (for example, Safari on iOS is very restrictive).

LiveKit will attempt to autoplay all audio tracks when you attach them to audio elements. However, if that fails, we'll notify you via `RoomEvent.AudioPlaybackStatusChanged`. `Room.canPlayAudio` will indicate if audio playback is permitted. LiveKit takes an optimistic approach so it's possible for this value to change from `true` to `false` when we encounter a browser error.

In the case user interaction is required, LiveKit provides `Room.startAudio` to start audio playback. This function must be triggered in an onclick or ontap event handler. In the same session, once audio playback is successful, additional audio tracks can be played without further user interactions.

```typescript
room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
  if (!room.canPlayAudio) {
    // UI is necessary.
    ...
    button.onclick = () => {
      // startAudio *must* be called in an click/tap handler.
      room.startAudio().then(() => {
        // successful, UI can be removed now
        button.remove();
      });
    }
  }
});
```

### Configuring logging

This library uses [loglevel](https://github.com/pimterry/loglevel) for its internal logs. You can change the effective log level with the `logLevel` field in `ConnectOptions`.
The method `setLogExtension` allows to hook into the livekit internal logs and send them to some third party logging service

```ts
setLogExtension((level: LogLevel, msg: string, context: object) => {
  const enhancedContext = { ...context, timeStamp: Date.now() };
  if (level >= LogLevel.debug) {
    console.log(level, msg, enhancedContext);
  }
});
```

## Browser Support

| Browser         | Desktop OS            | Mobile OS |
| --------------- | --------------------- | --------- |
| Chrome          | Windows, macOS, Linux | Android   |
| Firefox         | Windows, macOS, Linux | Android   |
| Safari          | macOS                 | iOS       |
| Edge (Chromium) | Windows, macOS        |           |

We aim to support a broad range of browser versions by transpiling the library code with babel.
You can have a look at the `"browerslist"` section of `package.json` for more details.

> Note that the library requires some specific browser APIs to be present.
> You can check general compatibility with the helper function `isBrowserSupported()`.
> Support for more modern features like adaptiveStream and dynacast can be checked for with `supportsAdaptiveStream()` and `supportsDynacast()`.

If you are targeting legacy browsers, but still want adaptiveStream functionality you'll likely need to use polyfills for [ResizeObserver](https://www.npmjs.com/package/resize-observer-polyfill) and [IntersectionObserver](https://www.npmjs.com/package/intersection-observer).

Also when targeting legacy browsers, older than the ones specified in our browserslist target, make sure to transpile the library code to your desired target and include required polyfills with babel and/or corejs.
