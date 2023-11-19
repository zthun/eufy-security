/* eslint-disable max-len */
/* eslint-disable indent */
import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
} from 'homebridge';
import { createSocket, Socket } from 'dgram';
import pickPort, { pickPortOptions } from 'pick-port';
import { CameraConfig, VideoConfig } from '../utils/configTypes';
import { FFmpeg, FFmpegParameters } from '../utils/ffmpeg';
import { Logger as TsLogger, ILogObj } from 'tslog';

import { Camera, PropertyName } from 'eufy-security-client';
import { EufySecurityPlatform } from '../platform';

import { SnapshotManager } from './SnapshotManager';
import { TalkbackStream } from '../utils/Talkback';
import { is_rtsp_ready } from '../utils/utils';
import { CameraAccessory } from '../accessories/CameraAccessory';
import { LocalLivestreamManager, StationStream } from './LocalLivestreamManager';
import { Writable } from 'stream';

export type SessionInfo = {
  address: string; // address of the HAP controller
  ipv6: boolean;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
  videoSRTP: Buffer; // key and salt concatenated
  videoSSRC: number; // rtp synchronisation source

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

type ActiveSession = {
  videoProcess?: FFmpeg;
  audioProcess?: FFmpeg;
  returnProcess?: FFmpeg;
  timeout?: NodeJS.Timeout;
  socket?: Socket;
  talkbackStream?: TalkbackStream;
};

export class StreamingDelegate implements CameraStreamingDelegate {

  public readonly platform: EufySecurityPlatform = this.camera.platform;
  public readonly device: Camera = this.camera.device;
  public readonly cameraConfig: CameraConfig = this.camera.cameraConfig;

  private readonly hap: HAP = this.platform.api.hap;
  private readonly api: API = this.platform.api;
  private readonly log: TsLogger<ILogObj> = this.platform.log;
  private readonly cameraName: string = this.device.getName()!;

  private readonly videoConfig: VideoConfig = this.cameraConfig.videoConfig!;
  private controller?: CameraController;

  public readonly localLivestreamManager: LocalLivestreamManager = new LocalLivestreamManager(this);

  private snapshotManager: SnapshotManager = new SnapshotManager(this);

  // keep track of sessions
  pendingSessions: Map<string, SessionInfo> = new Map();
  ongoingSessions: Map<string, ActiveSession> = new Map();
  timeouts: Map<string, NodeJS.Timeout> = new Map();

  // eslint-disable-next-line max-len
  constructor(
    public readonly camera: CameraAccessory,
  ) {
    this.api.on(APIEvent.SHUTDOWN, () => {
      for (const session in this.ongoingSessions) {
        this.stopStream(session);
      }
      this.localLivestreamManager.stopLocalLiveStream();
    });
  }

  public setController(controller: CameraController) {
    this.controller = controller;
  }

  public getLivestreamManager(): LocalLivestreamManager {
    return this.localLivestreamManager;
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.log.debug('handleSnapshotRequest');

    try {
      this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height, this.cameraName, this.videoConfig.debug);

      const snapshot = await this.snapshotManager.getSnapshotBuffer(request);

      this.log.debug('snapshot byte lenght: ' + snapshot?.byteLength);

      callback(undefined, snapshot);
    } catch (err) {
      this.log.error(this.cameraName, err as string);
      callback();
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6';

    const options: pickPortOptions = {
      type: 'udp',
      ip: ipv6 ? '::' : '0.0.0.0',
      reserveTimeout: 15,
    };
    const videoReturnPort = await pickPort(options);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(options);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6: ipv6,

      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC,

      audioPort: request.audio.port,
      audioReturnPort: audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC,
    };

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,

        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(undefined, response);
  }

  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions.get(request.sessionID);

    if (!sessionInfo) {
      this.log.error(this.cameraName, 'Error finding session information.');
      callback(new Error('Error finding session information'));
    }

    this.log.debug(this.cameraName, 'VIDEOCONFIG: ' + JSON.stringify(this.videoConfig));

    try {
      const activeSession: ActiveSession = {};
      activeSession.socket = createSocket(sessionInfo!.ipv6 ? 'udp6' : 'udp4');
      activeSession.socket.on('error', (err: Error) => {
        this.log.error(this.cameraName, 'Socket error: ' + err.message);
        this.stopStream(request.sessionID);
      });
      activeSession.socket.on('message', () => {
        if (activeSession.timeout) {
          clearTimeout(activeSession.timeout);
        }
        activeSession.timeout = setTimeout(() => {
          this.log.debug(this.cameraName, 'Device appears to be inactive. Stopping video stream.');
          this.controller?.forceStopStreamingSession(request.sessionID);
          this.stopStream(request.sessionID);
        }, request.video.rtcp_interval * 5 * 1000);
      });
      activeSession.socket.bind(sessionInfo!.videoReturnPort);

      // get streams
      const videoParams = await FFmpegParameters.create({ type: 'video', debug: this.videoConfig.debug });
      videoParams.setup(this.cameraConfig, request);
      videoParams.setRTPTarget(sessionInfo!, request);

      const useAudio = (request.audio.codec === AudioStreamingCodecType.OPUS
        || request.audio.codec === AudioStreamingCodecType.AAC_ELD)
        && this.videoConfig.audio;

      if (!useAudio && this.videoConfig.audio) {
        this.log.warn(this.cameraName, `An unsupported audio codec (type: ${request.audio.codec}) was requested. Audio streaming will be omitted.`);
      }

      let audioParams: FFmpegParameters | undefined = undefined;
      if (useAudio) {
        audioParams = await FFmpegParameters.create({ type: 'audio', debug: this.videoConfig.debug });
        audioParams.setup(this.cameraConfig, request);
        audioParams.setRTPTarget(sessionInfo!, request);
      }

      const rtsp = is_rtsp_ready(this.device, this.cameraConfig, this.log);

      let streamData: StationStream | null = null;

      if (rtsp) {
        const url = this.device.getPropertyValue(PropertyName.DeviceRTSPStreamUrl);
        this.platform.log.debug(this.cameraName, 'RTSP URL: ' + url);
        videoParams.setInputSource(url as string);
        audioParams?.setInputSource(url as string);
      } else {

        const value = await this.localLivestreamManager.getLocalLivestream()
          .catch((err) => {
            throw ((this.cameraName + ' Unable to start the livestream: ' + err) as string);
          });

        streamData = value;

        videoParams.setInputSource('pipe:3');
        audioParams?.setInputSource('pipe:4');

      }

      const videoProcess = new FFmpeg(
        `[${this.cameraName}] [Video Process]`,
        audioParams ? [videoParams, audioParams] : [videoParams],
        this.platform.ffmpegLogger,
      );

      videoProcess.on('started', () => {
        callback();
      });

      videoProcess.on('error', (err) => {
        this.log.error(this.cameraName, 'Video process ended with error: ' + err);
        this.stopStream(request.sessionID);
      });

      activeSession.videoProcess = videoProcess;
      activeSession.videoProcess.start();

      if (activeSession.videoProcess && activeSession.videoProcess.stdio) {
        // stdio is defined and can be used

        if (streamData !== null) {
          streamData.videostream.pipe(activeSession.videoProcess.stdio[3] as Writable);
          streamData.audiostream.pipe(activeSession.videoProcess.stdio[4] as Writable);
        }
      }

      if (this.cameraConfig.talkback) {
        const talkbackParameters = await FFmpegParameters.create({ type: 'audio', debug: this.videoConfig.debug });
        await talkbackParameters.setTalkbackInput(sessionInfo!);
        activeSession.talkbackStream = new TalkbackStream(this.platform, this.device);
        activeSession.returnProcess = new FFmpeg(
          `[${this.cameraName}] [Talkback Process]`,
          [talkbackParameters],
          this.platform.ffmpegLogger,
        );
        activeSession.returnProcess.on('error', (err) => {
          this.log.error(this.cameraName, 'Talkback process ended with error: ' + err);
        });
        activeSession.returnProcess.start();
        activeSession.returnProcess.stdout?.pipe(activeSession.talkbackStream);
      }

      // Check if the pendingSession has been stopped before it was successfully started.
      const pendingSession = this.pendingSessions.get(request.sessionID);
      // pendingSession has not been deleted. Transfer it to ongoingSessions.
      if (pendingSession) {
        this.ongoingSessions.set(request.sessionID, activeSession);
        this.pendingSessions.delete(request.sessionID);
      } else { // pendingSession has been deleted. Add it to ongoingSession and end it immediately.
        this.ongoingSessions.set(request.sessionID, activeSession);
        this.log.info(this.cameraName, 'pendingSession has been deleted. Add it to ongoingSession and end it immediately.');
        this.stopStream(request.sessionID);
      }

    } catch (err) {
      this.log.error(this.cameraName, 'Stream could not be started: ' + err);
      callback(err as Error);
      this.pendingSessions.delete(request.sessionID);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(
          this.cameraName,
          'Received request to reconfigure: ' +
          request.video.width +
          ' x ' +
          request.video.height +
          ', ' +
          request.video.fps +
          ' fps, ' +
          request.video.max_bit_rate +
          ' kbps (Ignored)',
          this.videoConfig.debug,
        );
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.log.debug(this.cameraName, 'Receive Apple HK Stop request' + JSON.stringify(request));
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  public stopStream(sessionId: string): void {
    this.log.debug('Stopping session with id: ' + sessionId);

    const pendingSession = this.pendingSessions.get(sessionId);
    if (pendingSession) {
      this.pendingSessions.delete(sessionId);
    }

    const session = this.ongoingSessions.get(sessionId);
    if (session) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      try {
        session.talkbackStream?.stopTalkbackStream();
        session.returnProcess?.stdout?.unpipe();
        session.returnProcess?.stop();
      } catch (err) {
        this.log.error(this.cameraName, 'Error occurred terminating returnAudio FFmpeg process: ' + err);
      }
      try {
        session.videoProcess?.stop();
      } catch (err) {
        this.log.error(this.cameraName, 'Error occurred terminating video FFmpeg process: ' + err);
      }
      try {
        session.audioProcess?.stop();
      } catch (err) {
        this.log.error(this.cameraName, 'Error occurred terminating audio FFmpeg process: ' + err);
      }
      try {
        session.socket?.close();
      } catch (err) {
        this.log.error(this.cameraName, 'Error occurred closing socket: ' + err);
      }
      try {
        if (!is_rtsp_ready(this.device, this.cameraConfig, this.log)) {
          this.localLivestreamManager.stopLocalLiveStream();
        }
      } catch (err) {
        this.log.error(this.cameraName, 'Error occurred terminating Eufy Station livestream: ' + err);
      }

      this.ongoingSessions.delete(sessionId);
      this.log.info(this.cameraName, 'Stopped video stream.');
    } else {
      this.log.debug('No session to stop.');
    }
  }
}