const captureUrl = new URL("./capture.mjs", import.meta.url);
const workerUrl = new URL("./pitch-worker.mjs", import.meta.url);

export function microphoneError(error) {
  switch (error.name) {
    case "InsecureContext":
      return ["マイクを使える接続で開いてください", "Android では Chrome で公開先の HTTPS アドレスを開いてください。PC の確認には localhost を使えます。"];
    case "NotAllowedError":
    case "SecurityError":
      return ["マイクの使用を許可してください", "Chrome のアドレス欄の左にあるサイト設定で、マイクを許可してください。Android 側の Chrome のマイク権限も確認できます。"];
    case "NotFoundError":
      return ["マイクが見つかりません", "端末にマイクがあることを確認し、接続し直してからもう一度開始してください。"];
    case "NotReadableError":
    case "AbortError":
      return ["マイクを起動できませんでした", "通話や録音アプリを閉じ、Android のマイクアクセスがオンか確認してから、もう一度開始してください。"];
    case "Unsupported":
      return ["このブラウザではマイク分析を使えません", "Chrome を更新し、アプリのページを直接開いてください。"];
    default:
      return ["マイク分析を開始できませんでした", "もう一度「マイクを開始」を押してください。繰り返す場合は、ページを読み込み直してください。"];
  }
}

function within(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Audio setup timed out")), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Microphone {
  constructor(onFrame, onLost) {
    this.onFrame = onFrame;
    this.onLost = onLost;
    this.closed = false;
  }

  async start(range) {
    if (!isSecureContext || location.protocol === "file:") {
      throw new DOMException("Open the app over HTTPS or localhost", "InsecureContext");
    }
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
      throw new DOMException("Web Audio microphone capture is unavailable", "Unsupported");
    }
    const audio = new AudioContext({ latencyHint: "interactive" });
    this.audio = audio;
    // Request audio playback and microphone permission from the same tap.
    const resume = audio.resume().catch((error) => error);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") throw new DOMException("Microphone disconnected", "NotReadableError");
    track.onended = () => this.onLost();
    const resumeResult = await within(resume, 5000);
    if (this.closed) return false;
    if (resumeResult instanceof Error) throw resumeResult;
    await within(audio.audioWorklet.addModule(captureUrl), 5000);
    if (this.closed) return false;

    const capture = new AudioWorkletNode(audio, "pitch-capture", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
    });
    this.capture = capture;
    capture.onprocessorerror = () => this.onLost();
    const worker = new Worker(workerUrl, { type: "module" });
    this.worker = worker;
    const channel = new MessageChannel();
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.ready) resolve();
        else if (!this.closed) {
          this.lastFrame = performance.now();
          this.onFrame(data);
        }
      };
      worker.onerror = (event) => {
        if (this.closed) return;
        if (this.watchdog) this.onLost();
        else reject(new Error(event.message));
      };
    });
    capture.port.postMessage({ port: channel.port1 }, [channel.port1]);
    worker.postMessage({ port: channel.port2, sampleRate: audio.sampleRate, range }, [channel.port2]);
    await within(ready, 5000);
    if (this.closed) return false;

    this.source = audio.createMediaStreamSource(stream);
    this.source.connect(capture).connect(audio.destination);
    this.lastFrame = performance.now();
    this.watchdog = setInterval(() => {
      if (performance.now() - this.lastFrame > 2400 || track.muted || track.readyState !== "live") this.onLost();
    }, 1200);
    return true;
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    }
    this.worker?.terminate();
    this.source?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    if (this.audio && this.audio.state !== "closed") void this.audio.close().catch(() => {});
  }
}
