// export async function init(ctx, html) {
//   ctx.importCSS("main.css");
//   ctx.root.innerHTML = html;
//   await ctx.importJS(
//     "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js"
//   );

//   async function run() {
//     console.log("Starting.....");
//     const videoIn = document.getElementById("source"),
//       stream = await window.navigator.mediaDevices.getUserMedia({
//         video: { width: 300, height: 300 },
//         audio: false,
//       });

//     videoIn.srcObject = stream;
//     await videoIn.play();

//     // -------------------face-api ------------------
//     await faceapi.nets.tinyFaceDetector.loadFromUri(
//       "https://raw.githubusercontent.com/dwyl/WebRTC-SFU-demo/main/lib/assets/model"
//     );

//     const displaySize = { width: videoIn.width, height: videoIn.height },
//       canvas = faceapi.createCanvasFromMedia(videoIn),
//       context = canvas.getContext("2d");

//     faceapi.matchDimensions(canvas, displaySize);

//     async function processFrames(video) {
//       async function drawAtVideoRate() {
//         context.drawImage(video, 0, 0, displaySize.width, displaySize.height);
//         const detections = await faceapi.detectAllFaces(
//           video,
//           new faceapi.TinyFaceDetectorOptions()
//         );
//         const resizedDetections = faceapi.resizeResults(
//           detections,
//           displaySize
//         );
//         faceapi.draw.drawDetections(canvas, resizedDetections);
//         video.requestVideoFrameCallback(drawAtVideoRate);
//       }

//       video.requestVideoFrameCallback(drawAtVideoRate);
//       return canvas.captureStream(30); // 30 fps
//     }

//     const transformedStream = await processFrames(videoIn);

//     //----------------------- WEBRTC-----------------------------
//     const iceConf = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
//     const pc = new RTCPeerConnection(iceConf);

//     // capture local MediaStream (from the webcam)
//     const tracks = transformedStream.getTracks();
//     tracks.forEach((track) => pc.addTrack(track, transformedStream));

//     // send offer to any peer connected on the signaling channel
//     pc.onicecandidate = ({ candidate }) => {
//       if (candidate === null) {
//         return;
//       }
//       ctx.pushEvent("ice", { candidate: candidate.toJSON(), type: "ice" });
//     };

//     // send offer to any peer connected on the signaling channel
//     pc.onnegotiationneeded = async () => {
//       const offer = await pc.createOffer();
//       await pc.setLocalDescription(offer);
//       console.log("--> Offer created and sent");
//       ctx.pushEvent("offer", { sdp: offer });
//     };

//     // received from the remote peer (Elixir SFU server here) via UDP
//     pc.ontrack = ({ streams }) => {
//       console.log("--> Received remote track");
//       const echo = document.querySelector("#echo");
//       echo.srcObject = streams[0];
//     };

//     // received from the remote peer via signaling channel (Elixir server)
//     ctx.handleEvent("ice", async ({ candidate }) => {
//       await pc.addIceCandidate(candidate);
//     });

//     ctx.handleEvent("answer", async (msg) => {
//       console.log("--> handled Answer");
//       await pc.setRemoteDescription(msg);
//     });

//     // internal WebRTC listener, for information or other action...
//     pc.onconnectionstatechange = () => {
//       console.log("~~> Connection state: ", pc.connectionState);
//     };
//   }

//   run();
// }
