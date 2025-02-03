'use client'
import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';

interface PartnerFoundData {
  roomId: string;
  isInitiator: boolean;
}

// Use the new Railway server URL as default.
const socket: Socket = io(
  process.env.NEXT_PUBLIC_BACKEND_URL ||
    'https://audio-omegle-server-production.up.railway.app/'
);

const ChatComponent: React.FC = () => {
  // Instead of video elements, we use canvas elements for waveforms.
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Idle');
  const [error, setError] = useState<string | null>(null);
  const [autoSearch, setAutoSearch] = useState<boolean>(true);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // References for local and remote AudioContexts and AnalyserNodes.
  const localAudioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // RTC configuration remains the same.
  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // Function to continuously draw waveform data from an AnalyserNode onto a canvas.
  const drawWaveform = (analyser: AnalyserNode, canvas: HTMLCanvasElement) => {
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const width = canvas.width;
    const height = canvas.height;

    const draw = () => {
      analyser.getByteTimeDomainData(dataArray);
      canvasCtx.fillStyle = '#222'; // background color
      canvasCtx.fillRect(0, 0, width, height);

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = '#0f0'; // waveform color
      canvasCtx.beginPath();
      const sliceWidth = width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
      requestAnimationFrame(draw);
    };

    draw();
  };

  useEffect(() => {
    // Listen for the "partnerFound" event.
    socket.on('partnerFound', async (data: PartnerFoundData) => {
      setRoomId(data.roomId);
      setStatus('Partner found, starting call...');
      await startCall(data.roomId, data.isInitiator);
    });

    socket.on('offer', async ({ offer }: { offer: RTCSessionDescriptionInit }) => {
      if (!peerConnectionRef.current) await startCall(roomId, false);
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(offer);
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit('answer', { roomId, answer });
      }
    });

    socket.on('answer', async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(answer);
      }
    });

    socket.on('ice-candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      if (peerConnectionRef.current && candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(candidate);
        } catch (err) {
          console.error('Error adding candidate:', err);
        }
      }
    });

    // When the remote peer hangs up.
    socket.on('hangup', () => {
      setStatus('Partner hung up');
      cleanupCall();
    });

    // Also listen for socket disconnection.
    socket.on('disconnect', () => {
      setStatus('Disconnected from server');
      cleanupCall();
    });

    return () => {
      socket.off('partnerFound');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('hangup');
      socket.off('disconnect');
    };
  }, [roomId]);

  const startCall = async (room: string | null, isInitiator: boolean) => {
    if (!room) return;
    try {
      // Create the RTCPeerConnection.
      peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
      setStatus('Initializing call...');

      // Monitor connection state changes.
      peerConnectionRef.current.onconnectionstatechange = () => {
        const state = peerConnectionRef.current?.connectionState;
        console.log('Connection state changed:', state);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          cleanupCall();
        }
      };

      // Request only an audio stream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localStreamRef.current = stream;

      // Set up the local audio analyzer.
      localAudioContextRef.current = new AudioContext();
      const localSource = localAudioContextRef.current.createMediaStreamSource(stream);
      localAnalyserRef.current = localAudioContextRef.current.createAnalyser();
      localAnalyserRef.current.fftSize = 2048;
      localSource.connect(localAnalyserRef.current);
      if (localCanvasRef.current && localAnalyserRef.current) {
        drawWaveform(localAnalyserRef.current, localCanvasRef.current);
      }

      // Add the audio tracks to the peer connection.
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });

      // When remote tracks are received.
      peerConnectionRef.current.ontrack = (event: RTCTrackEvent) => {
        const [remoteStream] = event.streams;
        // Set up the remote audio analyzer.
        remoteAudioContextRef.current = new AudioContext();
        const remoteSource = remoteAudioContextRef.current.createMediaStreamSource(remoteStream);
        remoteAnalyserRef.current = remoteAudioContextRef.current.createAnalyser();
        remoteAnalyserRef.current.fftSize = 2048;
        remoteSource.connect(remoteAnalyserRef.current);
        if (remoteCanvasRef.current && remoteAnalyserRef.current) {
          drawWaveform(remoteAnalyserRef.current, remoteCanvasRef.current);
        }
      };

      // Handle ICE candidates.
      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { roomId: room, candidate: event.candidate });
        }
      };

      if (isInitiator) {
        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);
        socket.emit('offer', { roomId: room, offer });
      }
    } catch (err: any) {
      console.error('Error starting call:', err);
      setError(`Error starting call: ${err.message}`);
      setStatus('Error');
    }
  };

  const cleanupCall = () => {
    // Stop the local audio tracks.
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    // Close any open audio contexts.
    if (localAudioContextRef.current) {
      localAudioContextRef.current.close();
      localAudioContextRef.current = null;
    }
    if (remoteAudioContextRef.current) {
      remoteAudioContextRef.current.close();
      remoteAudioContextRef.current = null;
    }
    // Close the RTCPeerConnection.
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    setRoomId(null);
    setStatus('Idle');
    if (autoSearch) {
      setStatus('Searching for a partner...');
      setTimeout(() => {
        socket.emit('findPartner');
      }, 500);
    }
  };

  const handleButtonClick = () => {
    if (roomId) {
      socket.emit('hangup', { roomId });
      cleanupCall();
    } else {
      setStatus('Searching for a partner...');
      socket.emit('findPartner');
    }
  };

  const toggleAutoSearch = () => {
    setAutoSearch(!autoSearch);
  };

  return (
    <div className="bg-gray-900 text-white rounded-lg shadow-lg p-6 max-w-2xl mx-auto my-8">
      <h1 className="text-3xl font-bold mb-4 text-center">Audio Omegle Clone Chat</h1>
      <p className="text-lg mb-4 text-center">
        Status: <span className="font-semibold">{status}</span>
      </p>
      {error && <p className="text-red-500 mb-4 text-center">{error}</p>}
      
      <div className="flex justify-center mb-4">
        <button
          onClick={handleButtonClick}
          className={`${
            roomId ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
          } text-white font-semibold py-2 px-6 rounded`}
        >
          {roomId ? 'Next' : 'Search'}
        </button>
      </div>
      
      <div className="text-center mb-4">
        <button onClick={toggleAutoSearch} className="text-sm text-gray-300 underline">
          {autoSearch ? 'Stop Auto Search' : 'Enable Auto Search'}
        </button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Local Audio Waveform</h2>
          <canvas
            ref={localCanvasRef}
            width={300}
            height={100}
            className="w-full rounded border border-gray-700 bg-black"
          />
        </div>
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Remote Audio Waveform</h2>
          <canvas
            ref={remoteCanvasRef}
            width={300}
            height={100}
            className="w-full rounded border border-gray-700 bg-black"
          />
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;