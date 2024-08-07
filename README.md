# Echo your face detection with the SFU ExWebRTC

```elixir
Mix.install([
  {:kino, "~> 0.13.1"},
  {:ex_webrtc, "~> 0.3.0"},
  {:req, "~> 0.5"}
])
```

## What are we doing?

We illustrate the SFU server [`ExWebRTC`](https://github.com/elixir-webrtc/ex_webrtc) by broadcasting our webcam via `WebRTC`.

`ExWebRTC` is an Elixir port of the [WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API).

This is a **low** latency protocole running on UDP.

We are **not** using the "standard" peer-to-peer WebRTC connection but we are connecting the input feed - the browser's built-in webcam - to an SFU server written in Elixir. The SFU will forward the signal to other connected clients.

<img width="427" alt="Screenshot 2024-06-05 at 05 28 47" src="https://github.com/user-attachments/assets/6c141dc0-1438-4470-a647-4b11af130f01">


We transform the input directly in the browser. Since it is mandatory to start with the "hello world" of computer vision, namely face detection, we showcase two libraries:

- the library <mark>[`face-api`](https://www.npmjs.com/package/@vladmandic/face-api?activeTab=readme)</mark>.
- the library <mark>[`MediaPipe`](https://github.com/tensorflow/tfjs-models/tree/master/face-detection)</mark> from [Tensorflow.js](https://www.tensorflow.org/js/models).

  The `mediaPipe` library gives excellent results.

The transformed stream will be sent to the SFU server via WebRTC.

The Elixir server will broadcast it back, into another `<video`> element of our page in this demo.

## How to use this?

You can run this first Livebook which uses `face-api`. You will notice that the results are not so good. You have a lot of negative findings.

[![Run in Livebook](https://livebook.dev/badge/v1/blue.svg)](https://livebook.dev/run?url=https%3A%2F%2Fgithub.com%2Fdwyl%2FWebRTC-SFU-demo%2Fblob%2Fmain%2Flib%2Fecho_face_api.livemd)


This second Livebook uses `MediaPipe`. This is **much** more performant. Recall that each frame (30 fps) are detected and rebuilt and broadcasted to the Elixir server to broadcast back in the video element below the input.

[![Run in Livebook](https://livebook.dev/badge/v1/blue.svg)](https://livebook.dev/run?url=https%3A%2F%2Fgithub.com%2Fdwyl%2FWebRTC-SFU-demo%2Fblob%2Fmain%2Flib%2Fecho_mediapipe.livemd)

## The WebRTC flow without the face detection addition

The webcam is captured and displayed in a first `<video>` element.

The browser and the Elixir SFU will establish a WebRTC PeerConnection via a signaling channel: the Livebook WebSocket.

They will exchange SDP and ICE candidates.

Once connected, the Elixir SFU will receive the streams from the `<video 1>` via a UDP connection. In this Echo configuration, it will send back the streams to the connected peer via UDP and display them in the other `<video 2>` element.

The "magic" lines:

```elixir
def handle_info(
      {:ex_webrtc, pc, {:rtp, client_track_id, _rid, packet}},
      %{client_video_track: %{id: client_track_id, kind: :video}} = state
    ) do
  PeerConnection.send_rtp(pc, state.serv_video_track.id, packet)

  {:noreply, state}
end
```

<!-- livebook:{"break_markdown":true} -->

### Information flow

- The signaling process (instantiate the PeerConnection):

```mermaid
graph LR;
  B1[Browser <br> PeerConnection]-- ws-->L[Livebook];
  L-- ws -->Ex[Elixir SFU <br> PeerConnection];
  Ex -- ws --> L
  L -- ws --> B1
```

- The active connection:

```mermaid
graph LR;
  B3[video 1]--stream <br> UDP -->ExSFU[Elixir SFU]
  ExSFU --stream <br> UPD-->B4[video 2];
```

<!-- livebook:{"break_markdown":true} -->

### Server-side WebRTC module

```elixir
defmodule RtcServer do
  use GenServer

  alias ExWebRTC.{ICECandidate, PeerConnection, SessionDescription, MediaStreamTrack, RTPCodecParameters}
  alias ExWebRTC.RTP.VP8.Depayloader

  require Logger

  defp ice_servers(), do: [%{urls: "stun:stun.l.google.com:19302"}]
  defp video_codecs, do: [
    %RTPCodecParameters{
      payload_type: 96,
      mime_type: "video/VP8",
      clock_rate: 90_000
    }
  ]

  defp setup_transceivers(pc) do
    media_stream_id = MediaStreamTrack.generate_stream_id()
    video_track = MediaStreamTrack.new(:video, [media_stream_id])
    {:ok, _sender} = PeerConnection.add_track(pc, video_track)
    %{serv_video_track: video_track}
  end

  # public ----------------
  def start_link(args), do: GenServer.start_link(__MODULE__, args, name: __MODULE__)
  def connect, do: GenServer.call(__MODULE__, :connect)

  def receive_signaling_msg({msg, sender}) do
    GenServer.cast(__MODULE__, {:receive_signaling_msg, msg, sender})
  end

  def peek_state, do: GenServer.call(__MODULE__, :peek_state)

  # callbacks-------------------------
  @impl true
  def init(_args) do
    Logger.info("ExRtc PeerConnection started")


    {:ok, %{
      sender: nil,
      pc: nil,
      client_video_track: nil,
      video_depayloader: Depayloader.new(),
      i: 1,
      t: System.monotonic_time(:microsecond)
    }}
  end

  # Livebook calls
  @impl true
  def handle_call(:peek_state, _, state) do
    {:reply, state, state}
  end

  def handle_call(:connect, _, state) do
    {:ok, pc_pid} =
      PeerConnection.start_link(ice_servers: ice_servers(), video_codecs: video_codecs())

    state = %{state | pc: pc_pid} |> Map.merge(setup_transceivers(pc_pid))
    {:reply, :connected, state}
  end

  # messages received from the client
  @impl true
  def handle_cast({:receive_signaling_msg, %{"type"=> "offer"} = msg, sender},state) do
    with desc <-
           SessionDescription.from_json(msg),
         :ok <-
           PeerConnection.set_remote_description(state.pc, desc),
         {:ok, answer} <-
           PeerConnection.create_answer(state.pc),
         :ok <-
           PeerConnection.set_local_description(state.pc, answer),
         :ok <-
           gather_candidates(state.pc) do

      #  the 'answer' is formatted into a struct, which can't be read by the JS client
      answer = %{"type" =>  "answer", "sdp" => answer.sdp}
      send(sender, {:signaling, answer})
      Logger.warning("--> Server sends Answer to remote")
      {:noreply, %{state | sender: sender}}
    else
      error ->
        Logger.error("Server: Error creating answer: #{inspect(error)}")
        {:stop, :shutdown, state}
    end
  end

  def handle_cast({:receive_signaling_msg, %{"type"=> "ice"} = msg, _sender}, state) do
    candidate = ICECandidate.from_json(msg["candidate"])
    :ok = PeerConnection.add_ice_candidate(state.pc, candidate)
    Logger.debug("--> Server processes remote ICE")
    {:noreply, state}
  end

  def handle_cast({:receive_signaling_msg, {msg, _}}, state) do
    Logger.warning("Server: unexpected msg: #{inspect(msg)}")
    {:stop, :shutdown, state}
  end

  @impl true
  def handle_info({:ex_webrtc, _pc, {:track, %{kind: :video} = client_video_track}}, state) do
    {:noreply, %{state | client_video_track: client_video_track}}
  end

  # internal messages --------
  def handle_info({:ex_webrtc, _pc, {:ice_candidate, candidate}}, state) do
    candidate = ICECandidate.to_json(candidate)
    send(state.sender, {:signaling, %{"type"=> "ice", "candidate" => candidate}})
    Logger.debug("--> Server sends ICE to remote")
    {:noreply, state}
  end

  def handle_info(
        {:ex_webrtc, pc, {:rtp, client_track_id, _rid, packet}},
        %{client_video_track: %{id: client_track_id, kind: :video}} = state
      ) do
    PeerConnection.send_rtp(pc, state.serv_video_track.id, packet)

    {:noreply, state}
  end

  def handle_info({:ex_webrtc, pc, {:connection_state_change, :connected}}, state) do
    PeerConnection.get_transceivers(pc)
    |> Enum.find(&(&1.kind == :video))
    |> then(fn %{receiver: receiver} ->
      Logger.warning("PeerConnection successfully connected, using #{inspect(receiver.codec.mime_type)}")
      end)

    {:noreply, state}
  end

  def handle_info({:ex_webrtc, _pc, _msg}, state) do
    {:noreply, state}
  end

  defp gather_candidates(pc) do
    receive do
      {:ex_webrtc, ^pc, {:ice_gathering_state_change, :complete}} -> :ok
    after
      1000 -> {:error, :timeout}
    end
  end
end
```

We will start the RTC GenServer.

```elixir
Supervisor.start_link([RtcServer], strategy: :one_for_one)
```

We instantiate a new PeerConnection:

```elixir
:connected = RtcServer.connect()
```

This will instantiate a `ExWebRTC.PeerConnection` server-side.
It is waiting for a peer to connect and receive its offer. It will respond with an "answer", digest the peer's Ice candidates, and send to the peer its own ICE candidates.

```elixir
RtcServer.peek_state()
```

### Client-side WebRTC module

On connection, a new `PeerConnection` is created. Since the server is already connected, the client will send an "offer" via the signaling channel. The client expects an "answer" back. It will also send "Ice" candidates via the signaling channel, and expects to receive Ice candidates from the server.

Once the connection is set, the client will receive RTP packets and digest them into a `<video>` element.

We use a `Kino.JS.Live` since we obviously need a signaling channel (the Live WebSocket).

> Kino expects us to code a "main.js" module that exports and `init` function
 
> Kino does not load files from an URL, but from a location. We supply the following helper module to make the Livebook work from GitHub, and clean the code.

```elixir
defmodule Assets do
  def fetch_js do
    github_js_url = "https://raw.githubusercontent.com/dwyl/WebRTC-SFU-demo/main/lib/assets/main_mediapipe.js"
    Req.get!(github_js_url).body
  end

  def fetch_html do
    github_html_url = "https://raw.githubusercontent.com/dwyl/WebRTC-SFU-demo/main/lib/assets/index.html"
    Req.get!(github_html_url).body
  end
end
```

The `Kino.JS.Live` module:

```elixir
defmodule VideoLive do
  # GenServer to communicate between browser and Livebook server

  use Kino.JS
  use Kino.JS.Live

  require Logger

  @html Assets.fetch_html()

  asset "main.js" do
    Assets.fetch_js()
  end

  def run() do
    Kino.JS.Live.new(__MODULE__, @html)
  end

  @impl true
  def init(html, ctx) do
    {:ok, assign(ctx, html: html)}
  end

  @impl true
  def handle_connect(ctx) do
    {:ok, ctx.assigns.html, ctx}
  end

  # received from the browser via the signaling WebSocket, call server
  @impl true
  def handle_event("offer",%{"sdp" => sdp}, ctx) do
    RtcServer.receive_signaling_msg({sdp, self()})
    {:noreply, ctx}
  end

  def handle_event("ice",%{"candidate" => candidate}, ctx) do
    RtcServer.receive_signaling_msg({%{"type" => "ice", "candidate" => candidate}, self()})
    {:noreply, ctx}
  end

  # received from the server, send to the browser via signaling WebSocket
  @impl true
  def handle_info({:signaling, %{"type" => "answer"} = msg}, ctx) do
    broadcast_event(ctx, "answer", msg)
    {:noreply, ctx}
  end

  def handle_info({:signaling, %{"type" => "ice"} = msg}, ctx) do
    if msg["candidate"], do: broadcast_event(ctx, "ice",msg)
    {:noreply, ctx}
  end
end
```

## Run it!

```elixir
VideoLive.run()
```

The PeerConnection server-side is now populated:

```elixir
RtcServer.peek_state()
```

## Javascript of the WebRTC and the face detection drawing

It relies on the method [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).

You can transform each frame of a video stream, _at the rate of the video_, namely 30fps.

We use this transformed stream and add it to the PeerConnection track. Et voilà.

The `mediaPipe` library uses `

```js
import {
  FaceDetector,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

export async function init(ctx, html) {
  ctx.importCSS("main.css");
  ctx.root.innerHTML = html;

  async function run() {
    console.log("Starting.....");
    const videoIn = document.getElementById("source"),
      display = { width: videoIn.width, height: videoIn.height },
      canvas = document.createElement("canvas"),
      context = canvas.getContext("2d"),
      stream = await window.navigator.mediaDevices.getUserMedia({
        video: display,
        audio: false,
      });

    videoIn.srcObject = stream;
    await videoIn.play();

    // -------------------mediaPipe-api ------------------
    canvas.height = display.height;
    canvas.width = display.width;

    let faceDetector;

    // Loads the MediaPipe Face Detector model and begins detecting faces in the input video.
    const initializeFaceDetector = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
      );
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
      });
      await predictWebcam();
    };

    async function predictWebcam() {
      const detections = await faceDetector.detectForVideo(
        videoIn,
        performance.now()
      );
      displayVideoDetections(detections.detections);
      window.requestVideoFrameCallback(predictWebcam);
    }

    function displayVideoDetections(detections) {
      context.clearRect(0, 0, display.width, display.height);
      context.drawImage(videoIn, 0, 0, display.width, display.height);

      detections.forEach((detection) => {
        const bbox = detection.boundingBox;
        context.beginPath();
        context.rect(bbox.originX, bbox.originY, bbox.width, bbox.height);
        context.lineWidth = 2;
        context.strokeStyle = "blue";
        context.stroke();

        detection.keypoints.forEach((keypoint) => {
          context.beginPath();
          context.arc(keypoint.x, keypoint.y, 3, 0, 2 * Math.PI);
          context.fillStyle = "red";
          context.fill();
        });
      });
    }

    await initializeFaceDetector();
    videoIn.requestVideoFrameCallback(predictWebcam);
    const transformedStream = canvas.captureStream(30);

    //----------------------- WEBRTC-----------------------------
    const iceConf = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    const pc = new RTCPeerConnection(iceConf);

    // capture local MediaStream (from the webcam)
    const tracks = transformedStream.getTracks();
    tracks.forEach((track) => pc.addTrack(track, transformedStream));

    // send offer to any peer connected on the signaling channel
    pc.onicecandidate = ({ candidate }) => {
      if (candidate === null) {
        return;
      }
      ctx.pushEvent("ice", { candidate: candidate.toJSON(), type: "ice" });
    };

    // send offer to any peer connected on the signaling channel
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log("--> Offer created and sent");
      ctx.pushEvent("offer", { sdp: offer });
    };

    // received from the remote peer (Elixir SFU server here) via UDP
    pc.ontrack = ({ streams }) => {
      console.log("--> Received remote track");
      const echo = document.querySelector("#echo");
      echo.srcObject = streams[0];
    };

    // received from the remote peer via signaling channel (Elixir server)
    ctx.handleEvent("ice", async ({ candidate }) => {
      await pc.addIceCandidate(candidate);
    });

    ctx.handleEvent("answer", async (msg) => {
      console.log("--> handled Answer");
      await pc.setRemoteDescription(msg);
    });

    // internal WebRTC listener, for information or other action...
    pc.onconnectionstatechange = () => {
      console.log("~~> Connection state: ", pc.connectionState);
    };
  }

  run();
}
```
