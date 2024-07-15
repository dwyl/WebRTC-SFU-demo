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
      videoIn.requestVideoFrameCallback(predictWebcam);
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
        /*
        const p = document.createElement("p");
        p.innerText = `Confidence: ${(
          detection.categories[0].score * 100
        ).toFixed(2)}%`;
        p.style.position = "absolute";
        p.style.left = `${bbox.originX}px`;
        p.style.top = `${bbox.originY - 20}px`;
        p.style.backgroundColor = "rgba(255, 255, 255, 0.7)";
        p.style.padding = "2px";
        p.style.borderRadius = "3px";
        document.body.appendChild(p);

        setTimeout(() => {
          document.body.removeChild(p);
        }, 1000);
        */
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
